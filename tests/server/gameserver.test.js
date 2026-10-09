// Owner: Time And Time Studio
// Date: 2026-10-06 11:20 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { JavaRuntimeError } from '../../src/core/errors.js';
import { writeZipFile } from '../../src/archive/zip.js';
import { createApiRouter } from '../../src/server/routes.js';
import { createTmlServer } from '../../src/server/server.js';
import { createInstanceManager } from '../../src/instance/manager.js';
import { createInstanceExporter } from '../../src/instance/export.js';
import { createInstanceImporter } from '../../src/instance/import.js';
import { createGameServerManager, FABRIC_INSTALLER_VERSION } from '../../src/instance/gameserver.js';
import {
  DEFAULT_SERVER_PORT,
  validateInstanceMeta,
} from '../../src/instance/validate.js';
import { buildZip } from '../helpers/zip.js';

const BASE = Object.freeze({ minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });

function createFakeLauncher() {
  return {
    handles: [],
    async launch() {
      let settle;
      const exited = new Promise((resolve) => {
        settle = resolve;
      });
      const handle = {
        pid: 9600,
        kill: (signal = 'SIGTERM') => {
          setTimeout(() => settle({ code: null, signal, error: null }), 0);
        },
        exited,
      };
      this.handles.push(handle);
      return handle;
    },
  };
}

function createFakeFabric() {
  const versions = new Map();
  return {
    async versionFor(id) {
      return versions.get(id) ?? null;
    },
    async install(id) {
      const version = { id: 'fabric-loader-0.15.7-1.20.1', mainClass: 'knot' };
      versions.set(id, version);
      return { id: version.id, installed: true };
    },
  };
}

// java stub สองหน้า: รับ args มี -dir = โหมดติดตั้ง (สร้าง jar เอง), ไม่มี = โหมดรัน server (พิมพ์ Done แล้วรอ stop)
function writeStubJava(dir) {
  const file = path.join(dir, 'stub-java.sh');
  fs.writeFileSync(
    file,
    [
      '#!/usr/bin/env bash',
      'dir=""',
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "-dir" ]; then dir="$arg"; fi',
      '  prev="$arg"',
      'done',
      'if [ -n "$dir" ]; then',
      '  printf "launch jar\\n" > "$dir/fabric-server-launch.jar"',
      '  printf "server jar\\n" > "$dir/server.jar"',
      '  echo "Installer finished"',
      '  exit 0',
      'fi',
      'echo "[main/INFO]: Starting minecraft server version stub"',
      'echo "[Server thread/INFO]: Done (0.487s)! For help, type \'help\'"',
      'while IFS= read -r line; do',
      '  if [ "$line" = "stop" ]; then',
      '    echo "[Server thread/INFO]: Stopping server"',
      '    exit 0',
      '  fi',
      'done',
      '',
    ].join('\n'),
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function manifestZip({ name = 'ApiPack', type = null } = {}) {
  const manifest = `${JSON.stringify(
    {
      format: 1,
      name,
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      fabricLoaderVersion: '0.15.7',
      ...(type ? { type } : {}),
    },
    null,
    2,
  )}\n`;
  return buildZip([
    { name: 'instance.json', data: manifest },
    { name: 'minecraft/', data: '' },
    { name: 'minecraft/mods/pack.jar', data: 'pack mod' },
  ]);
}

let server;
let port;
let dataDir;
let config;
let manager;
let gameserver;
let javaState;
let stubJava;

function request(pathname, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function upload(pathname, zipBuffer, { preview = true } = {}) {
  return new Promise((resolve, reject) => {
    const suffix = preview ? '?preview=1' : '';
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `${pathname}${suffix}`,
        method: 'POST',
        headers: {
          'content-type': 'application/zip',
          'content-length': zipBuffer.length,
          accept: 'application/json',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(zipBuffer);
  });
}

// phase 'running' อาจยังไม่ถูกตั้งตอน start คืน (Done line เพิ่งเข้า) — รอหน่อย ๆ
async function waitForPhase(id, expected, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    const res = await request(`/api/servers/${id}/status`);
    if (res.status === 200 && res.json.phase === expected) return res.json;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`phase "${expected}" never reached for ${id}`);
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-gameserver-'));
  stubJava = writeStubJava(dataDir);
  javaState = { fail: false };
  config = loadConfig({ env: { TML_DATA_DIR: dataDir, TML_PORT: '0', TML_LOG_LEVEL: 'silent' } });
  const logger = createLogger({ level: 'silent' });

  // installer jar วางไว้ใน cache ก่อน — กันไม่ให้ test ต้องต่อมึง (ensureInstallerJar เจอไฟล์แล้วข้าม)
  const installerDir = path.join(config.paths.cacheDir, 'fabric-installer');
  fs.mkdirSync(installerDir, { recursive: true });
  fs.writeFileSync(path.join(installerDir, `fabric-installer-${FABRIC_INSTALLER_VERSION}.jar`), 'stub');

  manager = createInstanceManager({
    config,
    launcher: createFakeLauncher(),
    fabric: createFakeFabric(),
    logger,
  });
  const exporter = createInstanceExporter({ manager, writeZip: writeZipFile, exportsDir: config.paths.exportsDir, logger });
  const importer = createInstanceImporter({ manager, tempRoot: config.paths.tmpDir, logger });
  gameserver = createGameServerManager({
    config,
    logger,
    manager,
    getJava: async () => {
      if (javaState.fail) {
        throw new JavaRuntimeError('No downloaded Java runtime is selected', {
          code: 'JAVA_RUNTIME_UNAVAILABLE',
          status: 409,
          details: { chosen: null },
        });
      }
      return { path: stubJava, name: 'stub' };
    },
  });

  const router = createApiRouter({
    config,
    logger,
    instance: { manager, exporter, importer, installer: null, gameserver },
  });
  server = createTmlServer({ config, logger, router });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await gameserver?.shutdown();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('validateInstanceMeta exposes client/server type, port and eula fields', () => {
  const client = validateInstanceMeta({
    id: 'val-client',
    name: 'Val Client',
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    fabricLoaderVersion: '0.15.7',
  });
  assert.equal(client.type, 'client');
  assert.equal(client.port, DEFAULT_SERVER_PORT);
  assert.equal(client.eulaAccepted, false);

  const serverMeta = validateInstanceMeta({
    id: 'val-server',
    name: 'Val Server',
    type: 'server',
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    fabricLoaderVersion: '0.15.7',
    port: '25577',
    eulaAccepted: true,
  });
  assert.equal(serverMeta.type, 'server');
  assert.equal(serverMeta.port, 25577);
  assert.equal(serverMeta.eulaAccepted, true);

  assert.throws(
    () =>
      validateInstanceMeta({
        id: 'val-bad-type',
        name: 'Bad',
        type: 'laptop',
        minecraftVersion: '1.20.1',
        loader: 'fabric',
        fabricLoaderVersion: '0.15.7',
      }),
    (err) => err.code === 'INVALID_INSTANCE_TYPE',
  );
  assert.throws(
    () =>
      validateInstanceMeta({
        id: 'val-bad-port',
        name: 'Bad',
        type: 'server',
        port: 70000,
        minecraftVersion: '1.20.1',
        loader: 'fabric',
        fabricLoaderVersion: '0.15.7',
      }),
    (err) => err.code === 'INVALID_SERVER_PORT',
  );
  assert.throws(
    () =>
      validateInstanceMeta({
        id: 'val-bad-eula',
        name: 'Bad',
        eulaAccepted: 'yes',
        minecraftVersion: '1.20.1',
        loader: 'fabric',
        fabricLoaderVersion: '0.15.7',
      }),
    (err) => err.code === 'INVALID_EULA_ACCEPTED',
  );
});

test('servers API keeps servers apart from instances', async () => {
  const created = await request('/api/servers', {
    method: 'POST',
    body: { name: 'Api Server', id: 'srv1', ...BASE },
  });
  assert.equal(created.status, 201);
  const srv = created.json.server;
  assert.equal(srv.id, 'srv1');
  assert.equal(srv.type, 'server');
  assert.equal(srv.port, DEFAULT_SERVER_PORT);
  assert.equal(srv.eulaAccepted, false);
  assert.equal(srv.installed, false);
  assert.equal(srv.running, false);

  const client = await request('/api/instances', {
    method: 'POST',
    body: { name: 'Api Client', id: 'cli1', ...BASE },
  });
  assert.equal(client.status, 201);
  assert.equal(client.json.instance.type, 'client');

  const invalidPort = await request('/api/servers', {
    method: 'POST',
    body: { name: 'Bad Port', id: 'srvbad', port: 0, ...BASE },
  });
  assert.equal(invalidPort.status, 400);
  assert.equal(invalidPort.json.error.code, 'INVALID_SERVER_PORT');

  const clientList = await request('/api/instances');
  assert.equal(clientList.status, 200);
  assert.ok(clientList.json.instances.length >= 1);
  assert.ok(clientList.json.instances.every((item) => item.type === 'client'));
  assert.ok(!clientList.json.instances.some((item) => item.id === 'srv1'));

  const serverList = await request('/api/servers');
  assert.equal(serverList.status, 200);
  assert.ok(serverList.json.servers.some((item) => item.id === 'srv1'));
  assert.ok(serverList.json.servers.every((item) => item.type === 'server'));
  assert.ok(!serverList.json.servers.some((item) => item.id === 'cli1'));

  // item routes ใช้ร่วมกันได้ — /api/instances/:id โชว์ type ให้ชัดเจน
  const shared = await request('/api/instances/srv1');
  assert.equal(shared.status, 200);
  assert.equal(shared.json.instance.type, 'server');

  // server ที่มีจริงผ่าน server route; client ถูกปฏิเสธ; ไม่มีจริง → 404
  const fetched = await request('/api/servers/srv1');
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.server.id, 'srv1');
  const clientOnServerRoute = await request('/api/servers/cli1');
  assert.equal(clientOnServerRoute.status, 400);
  assert.equal(clientOnServerRoute.json.error.code, 'NOT_SERVER_INSTANCE');
  const missing = await request('/api/servers/nope');
  assert.equal(missing.status, 404);

  const patched = await request('/api/instances/srv1', { method: 'PATCH', body: { port: 25566 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.instance.port, 25566);
  const back = await request('/api/instances/srv1', { method: 'PATCH', body: { port: DEFAULT_SERVER_PORT } });
  assert.equal(back.json.instance.port, DEFAULT_SERVER_PORT);
});

test('client launch, stop and install routes refuse server instances', async () => {
  const launch = await request('/api/instances/srv1/launch', { method: 'POST' });
  assert.equal(launch.status, 409);
  assert.equal(launch.json.error.code, 'SERVER_INSTANCE');

  const stop = await request('/api/instances/srv1/stop', { method: 'POST' });
  assert.equal(stop.status, 409);
  assert.equal(stop.json.error.code, 'SERVER_INSTANCE');

  const install = await request('/api/servers/cli1/install', { method: 'POST' });
  assert.equal(install.status, 400);
  assert.equal(install.json.error.code, 'NOT_SERVER_INSTANCE');
});

test('server start refuses before the EULA is accepted', async () => {
  const started = await request('/api/servers/srv1/start', { method: 'POST' });
  assert.equal(started.status, 409);
  assert.equal(started.json.error.code, 'EULA_NOT_ACCEPTED');

  const consoleRes = await request('/api/servers/srv1/console?since=0');
  assert.equal(consoleRes.status, 200);
  const texts = consoleRes.json.lines.map((line) => line.text).join('\n');
  assert.ok(texts.includes('EULA not accepted'), 'console explains the EULA gate');

  const status = await request('/api/servers/srv1/status');
  assert.equal(status.json.running, false);
  assert.equal(status.json.installed, false);
  assert.equal(status.json.eulaAccepted, false);
});

test('eula endpoint writes eula.txt and updates the instance meta', async () => {
  const rejected = await request('/api/servers/srv1/eula', { method: 'POST', body: {} });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.eulaAccepted, false);

  const accepted = await request('/api/servers/srv1/eula', { method: 'POST', body: { accept: true } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.eulaAccepted, true);

  const gameDir = manager.paths('srv1').gameDir;
  const eulaText = await fs.promises.readFile(path.join(gameDir, 'eula.txt'), 'utf8');
  assert.match(eulaText, /^eula=true$/m);

  const fetched = await request('/api/servers/srv1');
  assert.equal(fetched.json.server.eulaAccepted, true);
});

test('server start reports JAVA_RUNTIME_UNAVAILABLE when no runtime resolves', async () => {
  javaState.fail = true;
  try {
    const started = await request('/api/servers/srv1/start', { method: 'POST' });
    assert.equal(started.status, 409);
    assert.equal(started.json.error.code, 'JAVA_RUNTIME_UNAVAILABLE');
  } finally {
    javaState.fail = false;
  }
});

test('server start installs files on demand and streams the console', async () => {
  const started = await request('/api/servers/srv1/start', { method: 'POST' });
  assert.equal(started.status, 202);
  assert.equal(started.json.running, true);
  assert.equal(started.json.installed, true);
  assert.equal(typeof started.json.pid, 'number');
  assert.equal(started.json.port, DEFAULT_SERVER_PORT);

  await waitForPhase('srv1', 'running');
  const status = await request('/api/servers/srv1/status');
  assert.equal(status.json.running, true);
  assert.equal(status.json.installed, true);
  assert.equal(status.json.eulaAccepted, true);

  const consoleRes = await request('/api/servers/srv1/console?since=0');
  assert.equal(consoleRes.status, 200);
  assert.equal(consoleRes.json.running, true);
  const texts = consoleRes.json.lines.map((line) => line.text).join('\n');
  assert.ok(texts.includes('[tml] Server files installed'));
  assert.ok(texts.includes('[tml] Server started (pid'));
  assert.ok(texts.includes('Done ('));

  // since = nextSince ไม่มีอะไรใหม่ → คืนว่างเปล่า
  const quiet = await request(`/api/servers/srv1/console?since=${consoleRes.json.nextSince}`);
  assert.equal(quiet.json.lines.length, 0);

  const again = await request('/api/servers/srv1/start', { method: 'POST' });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'SERVER_ALREADY_RUNNING');

  const props = await fs.promises.readFile(path.join(manager.paths('srv1').gameDir, 'server.properties'), 'utf8');
  assert.match(props, new RegExp(`^server-port=${DEFAULT_SERVER_PORT}$`, 'm'));
  const marker = JSON.parse(await fs.promises.readFile(manager.paths('srv1').dir + '/server-install.json', 'utf8'));
  assert.equal(marker.minecraftVersion, '1.20.1');
  assert.equal(marker.fabricLoaderVersion, '0.15.7');
});

test('server stop shuts the process down gracefully and a second stop 404s', async () => {
  const stopped = await request('/api/servers/srv1/stop', { method: 'POST' });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.running, false);
  assert.equal(stopped.json.code, 0);

  const status = await request('/api/servers/srv1/status');
  assert.equal(status.json.running, false);
  assert.equal(status.json.phase, 'idle');
  assert.equal(status.json.exit.code, 0);

  const consoleRes = await request('/api/servers/srv1/console?since=0');
  const texts = consoleRes.json.lines.map((line) => line.text).join('\n');
  assert.ok(texts.includes('[tml] Server stopped (code 0)'));

  const again = await request('/api/servers/srv1/stop', { method: 'POST' });
  assert.equal(again.status, 404);
  assert.equal(again.json.error.code, 'SERVER_NOT_RUNNING');
});

test('install endpoint installs once, then reports skipped on repeat', async () => {
  const created = await request('/api/servers', {
    method: 'POST',
    body: { name: 'Install Only', id: 'srvinstall', ...BASE },
  });
  assert.equal(created.status, 201);

  const first = await request('/api/servers/srvinstall/install', { method: 'POST' });
  assert.equal(first.status, 202);
  assert.equal(first.json.installed, true);
  assert.equal(first.json.skipped, false);

  const second = await request('/api/servers/srvinstall/install', { method: 'POST' });
  assert.equal(second.status, 202);
  assert.equal(second.json.skipped, true);

  const status = await request('/api/servers/srvinstall/status');
  assert.equal(status.json.installed, true);
});

test('delete and export refuse a running server, then work after stop', async () => {
  await request('/api/servers', { method: 'POST', body: { name: 'Guarded', id: 'srvguard', ...BASE } });
  await request('/api/servers/srvguard/eula', { method: 'POST', body: { accept: true } });
  const started = await request('/api/servers/srvguard/start', { method: 'POST' });
  assert.equal(started.status, 202);

  // delete/patch/export ผ่าน item routes เดิม (/api/instances/:id) ที่ทั้ง client และ server ใช้ร่วมกัน
  const deleted = await request('/api/instances/srvguard', { method: 'DELETE' });
  assert.equal(deleted.status, 409);
  assert.equal(deleted.json.error.code, 'INSTANCE_RUNNING');

  const exported = await request('/api/instances/srvguard/export', { method: 'POST', body: {} });
  assert.equal(exported.status, 409);
  assert.equal(exported.json.error.code, 'INSTANCE_RUNNING');

  const stopped = await request('/api/servers/srvguard/stop', { method: 'POST' });
  assert.equal(stopped.status, 200);

  const removed = await request('/api/instances/srvguard', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.deleted, true);
});

test('import endpoints reject archives of the other type', async () => {
  const clientZip = manifestZip({ name: 'Client Pack' });
  const serverZip = manifestZip({ name: 'Server Pack', type: 'server' });

  const clientToServer = await upload('/api/servers/import', clientZip);
  assert.equal(clientToServer.status, 400);
  assert.equal(clientToServer.json.error.code, 'IMPORT_TYPE_MISMATCH');

  const serverToClient = await upload('/api/instances/import', serverZip);
  assert.equal(serverToClient.status, 400);
  assert.equal(serverToClient.json.error.code, 'IMPORT_TYPE_MISMATCH');

  const preview = await upload('/api/servers/import', serverZip);
  assert.equal(preview.status, 200);
  assert.equal(preview.json.preview, true);
  assert.equal(preview.json.manifest.type, 'server');

  const confirmed = await request('/api/servers/import', {
    method: 'POST',
    body: { token: preview.json.token, name: 'Imported Server' },
  });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.json.manifest.type, 'server');
  const importedId = confirmed.json.instanceId;

  const detail = await request(`/api/servers/${importedId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.server.type, 'server');
  assert.equal(detail.json.server.installed, false);

  const clientList = await request('/api/instances');
  assert.ok(!clientList.json.instances.some((item) => item.id === importedId));
});

test('server export writes type server in the manifest', async () => {
  const exported = await request('/api/instances/srv1/export', { method: 'POST', body: {} });
  assert.equal(exported.status, 201);

  const importer = createInstanceImporter({ manager, tempRoot: config.paths.tmpDir, logger: null });
  const inspected = await importer.inspect(exported.json.path);
  assert.equal(inspected.manifest.type, 'server');
  assert.equal(inspected.manifest.minecraftVersion, '1.20.1');
});
