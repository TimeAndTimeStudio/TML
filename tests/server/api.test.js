// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
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
import { SourceNotAllowedError } from '../../src/core/errors.js';
import { hashBuffer } from '../../src/download/hash.js';
import { writeZipFile } from '../../src/archive/zip.js';
import { createApiRouter } from '../../src/server/routes.js';
import { createTmlServer } from '../../src/server/server.js';
import { createInstanceManager } from '../../src/instance/manager.js';
import { createInstanceExporter } from '../../src/instance/export.js';
import { createInstanceImporter } from '../../src/instance/import.js';
import { createModInstaller } from '../../src/mods/install.js';
import { buildZip } from '../helpers/zip.js';

const localOnly = (input) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new SourceNotAllowedError(`Host not allowed: ${url.hostname}`, {
      details: { host: url.hostname },
    });
  }
  return url;
};

const BASE = Object.freeze({ minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });

const MOD_JAR = Buffer.from('mod jar served by api test\n'.repeat(4));
const MOD_HASHES = hashBuffer(MOD_JAR, ['sha1', 'sha512']);

function createFakeLauncher() {
  const handles = [];
  return {
    handles,
    async launch() {
      let settle;
      const exited = new Promise((resolve) => {
        settle = resolve;
      });
      const handle = {
        pid: 9500 + handles.length,
        kill: (signal = 'SIGTERM') => {
          setTimeout(() => settle({ code: null, signal, error: null }), 0);
        },
        finish: (result) => settle(result),
        exited,
      };
      handles.push(handle);
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

function manifestZip(name = 'ApiPack') {
  const manifest = `${JSON.stringify(
    { format: 1, name, minecraftVersion: '1.20.1', loader: 'fabric', fabricLoaderVersion: '0.15.7' },
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
let exportsDir;
let upstream;
let listVersionCalls;

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
      }
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
      }
    );
    req.on('error', reject);
    req.end(zipBuffer);
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-api-'));
  config = loadConfig({ env: { TML_DATA_DIR: dataDir, TML_PORT: '0', TML_LOG_LEVEL: 'silent' } });
  const logger = createLogger({ level: 'silent' });
  exportsDir = config.paths.exportsDir;
  listVersionCalls = [];

  manager = createInstanceManager({ config, launcher: createFakeLauncher(), fabric: createFakeFabric(), logger });
  const exporter = createInstanceExporter({ manager, writeZip: writeZipFile, exportsDir, logger });
  const importer = createInstanceImporter({ manager, tempRoot: config.paths.tmpDir, logger });

  upstream = http.createServer((req, res) => {
    if (req.url === '/files/apimod.jar') {
      res.writeHead(200, { 'content-type': 'application/java-archive' });
      res.end(MOD_JAR);
      return;
    }
    res.writeHead(404).end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const base = `http://127.0.0.1:${upstream.address().port}`;

  const modrinth = {
    async getVersion(versionId) {
      if (versionId !== 'apimod-1') {
        const err = new Error('version not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      return {
        id: 'apimod-1',
        projectId: 'apiproj',
        versionNumber: '1.2.3',
        gameVersions: ['1.20.1'],
        loaders: ['fabric'],
        files: [
          {
            filename: 'apimod.jar',
            url: `${base}/files/apimod.jar`,
            primary: true,
            size: MOD_JAR.length,
            sha1: MOD_HASHES.sha1,
            sha512: MOD_HASHES.sha512,
          },
        ],
        dependencies: [],
      };
    },
    async listVersions(projectId, options) {
      listVersionCalls.push({ projectId, options });
      // หน่วงสั้น ๆ ให้ check ยังทำงานอยู่จริงตอน test ยิงหลาย kind พร้อมกัน
      // (ถ้าเร็วเกินไป ผลจะบังเอิญผ่านได้ทั้ง code เก่าและใหม่ → ไม่จับ regression)
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (projectId !== 'apiproj') {
        const err = new Error('project not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      const version = await modrinth.getVersion('apimod-1');
      return [version];
    },
  };
  const installer = createModInstaller({ manager, modrinth, validator: localOnly, logger });

  const router = createApiRouter({
    config,
    logger,
    instance: { manager, exporter, importer, installer },
  });
  server = createTmlServer({ config, logger, router });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('instances API: list, create, get and delete', async () => {
  const empty = await request('/api/instances');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { count: 0, instances: [] });

  const created = await request('/api/instances', {
    method: 'POST',
    body: { name: 'Api Survival', id: 'apisurv', ...BASE },
  });
  assert.equal(created.status, 201);
  const instance = created.json.instance;
  assert.equal(instance.id, 'apisurv');
  assert.equal(instance.name, 'Api Survival');
  assert.equal(instance.minecraftVersion, '1.20.1');
  assert.equal(instance.loader, 'fabric');
  assert.equal(instance.fabricLoaderVersion, '0.15.7');
  assert.equal(instance.running, false);
  assert.equal(instance.mods, 0);
  assert.equal(instance.playSeconds, 0, 'new instance reports 0 played seconds');
  assert.equal(instance.sessionSeconds, 0, 'no live session when stopped');
  assert.equal(instance.lastPlayedAt, null, 'never played yet');

  const invalid = await request('/api/instances', { method: 'POST', body: { ...BASE } });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.json.error.code);

  const fetched = await request('/api/instances/apisurv');
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.json.instance, instance);

  const list = await request('/api/instances');
  assert.equal(list.json.count, 1);
  assert.equal(list.json.instances[0].id, 'apisurv');

  const missing = await request('/api/instances/nope');
  assert.equal(missing.status, 404);

  const deleted = await request('/api/instances/apisurv', { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.deleted, true);
  assert.equal(deleted.json.instanceId, 'apisurv');

  const gone = await request('/api/instances/apisurv');
  assert.equal(gone.status, 404);
});

test('launch and stop flow reports running state', async () => {
  await request('/api/instances', { method: 'POST', body: { name: 'Runner', id: 'runner1', ...BASE } });

  const launched = await request('/api/instances/runner1/launch', { method: 'POST' });
  assert.equal(launched.status, 202);
  assert.equal(launched.json.instanceId, 'runner1');
  assert.equal(launched.json.running, true);
  assert.equal(typeof launched.json.pid, 'number');
  assert.equal(launched.json.source, 'fabric');

  const again = await request('/api/instances/runner1/launch', { method: 'POST' });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'INSTANCE_ALREADY_RUNNING');

  const running = await request('/api/instances/runner1');
  assert.equal(running.json.instance.running, true);
  assert.equal(running.json.instance.pid, launched.json.pid);
  assert.ok(running.json.instance.sessionSeconds >= 0, 'live session seconds exposed while running');

  const stopped = await request('/api/instances/runner1/stop', { method: 'POST' });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.running, false);

  const afterStop = await request('/api/instances/runner1');
  assert.equal(afterStop.json.instance.running, false);
  assert.ok(afterStop.json.instance.lastPlayedAt, 'stop waits for the playtime record before responding');

  const stopAgain = await request('/api/instances/runner1/stop', { method: 'POST' });
  assert.equal(stopAgain.status, 404);
  assert.equal(stopAgain.json.error.code, 'INSTANCE_NOT_RUNNING');

  const deletedWhileRunning = (async () => {
    await request('/api/instances/runner1/launch', { method: 'POST' });
    const res = await request('/api/instances/runner1', { method: 'DELETE' });
    await request('/api/instances/runner1/stop', { method: 'POST' });
    return res;
  })();
  const runningDelete = await deletedWhileRunning;
  assert.equal(runningDelete.status, 409);
  assert.equal(runningDelete.json.error.code, 'INSTANCE_RUNNING');
});

test('export API creates archives with collision handling', async () => {
  await request('/api/instances', { method: 'POST', body: { name: 'Exported', id: 'exp1', ...BASE } });

  const first = await request('/api/instances/exp1/export', { method: 'POST', body: {} });
  assert.equal(first.status, 201);
  assert.equal(first.json.instanceId, 'exp1');
  assert.equal(first.json.filename, 'Exported-1.20.1.zip');
  assert.match(first.json.sha1, /^[0-9a-f]{40}$/);
  assert.ok(first.json.bytes > 0);
  assert.equal(fs.existsSync(path.join(exportsDir, 'Exported-1.20.1.zip')), true);

  const collision = await request('/api/instances/exp1/export', { method: 'POST', body: {} });
  assert.equal(collision.status, 409);
  assert.equal(collision.json.error.code, 'EXPORT_EXISTS');

  const forced = await request('/api/instances/exp1/export', { method: 'POST', body: { force: true } });
  assert.equal(forced.status, 201);
});

test('export API writes to a custom path and rejects invalid ones', async () => {
  await request('/api/instances', { method: 'POST', body: { name: 'Pathed', id: 'exp2', ...BASE } });

  const destDir = path.join(dataDir, 'chosen-exports');
  const custom = await request('/api/instances/exp2/export', { method: 'POST', body: { path: destDir } });
  assert.equal(custom.status, 201);
  assert.equal(custom.json.filename, 'Pathed-1.20.1.zip');
  assert.equal(fs.existsSync(path.join(destDir, 'Pathed-1.20.1.zip')), true);

  const relative = await request('/api/instances/exp2/export', { method: 'POST', body: { path: 'relative/dir', force: true } });
  assert.equal(relative.status, 400);
  assert.equal(relative.json.error.code, 'INVALID_EXPORT_PATH');

  const empty = await request('/api/instances/exp2/export', { method: 'POST', body: { path: '', force: true } });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error.code, 'INVALID_EXPORT_PATH');
});

test('import API validates an upload first and then creates a new instance', async () => {
  const zip = manifestZip('Imported Api');

  const noPreview = await upload('/api/instances/import', zip, { preview: false });
  assert.equal(noPreview.status, 400);
  assert.equal(noPreview.json.error.code, 'IMPORT_PREVIEW_REQUIRED');

  const preview = await upload('/api/instances/import', zip, { preview: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.preview, true);
  assert.match(preview.json.token, /^[a-f0-9]{32}$/);
  assert.deepEqual(preview.json.manifest, {
    name: 'Imported Api',
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    fabricLoaderVersion: '0.15.7',
    type: 'client',
  });

  const badToken = await request('/api/instances/import', { method: 'POST', body: { token: 'zzz' } });
  assert.equal(badToken.status, 400);
  assert.equal(badToken.json.error.code, 'IMPORT_INVALID_TOKEN');

  const confirmed = await request('/api/instances/import', {
    method: 'POST',
    body: { token: preview.json.token, name: 'Renamed Import' },
  });
  assert.equal(confirmed.status, 201);
  assert.match(confirmed.json.instanceId, /^[a-z0-9][a-z0-9_-]{0,63}$/);
  assert.equal(confirmed.json.name, 'Renamed Import');
  assert.equal(confirmed.json.manifest.name, 'Imported Api');
  assert.equal(confirmed.json.files, 1);

  const detail = await request(`/api/instances/${confirmed.json.instanceId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.instance.name, 'Renamed Import');

  const replay = await request('/api/instances/import', {
    method: 'POST',
    body: { token: preview.json.token },
  });
  assert.equal(replay.status, 404);
  assert.equal(replay.json.error.code, 'IMPORT_STAGED_NOT_FOUND');

  const slip = await upload('/api/instances/import', buildZip([
    { name: 'instance.json', data: JSON.stringify({ format: 1, name: 'X', minecraftVersion: '1.20.1', loader: 'fabric', fabricLoaderVersion: '0.15.7' }) },
    { name: '../../escape.txt', data: 'pwned' },
  ]));
  assert.equal(slip.status, 400);
  assert.equal(slip.json.error.code, 'ZIP_INVALID_ENTRY_NAME');

  const staging = path.join(config.paths.tmpDir, 'import-staging');
  const staged = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  assert.deepEqual(staged, [], 'staged uploads must not linger');
  assert.equal(fs.existsSync(path.join(dataDir, 'escape.txt')), false);
});

test('mods API lists, installs and removes mods for one instance', async () => {
  await request('/api/instances', { method: 'POST', body: { name: 'Modded', id: 'modded1', ...BASE } });

  const before = await request('/api/instances/modded1/mods');
  assert.equal(before.status, 200);
  assert.equal(before.json.instanceId, 'modded1');
  assert.deepEqual(before.json.mods, []);
  assert.equal(before.json.count, 0);

  const invalid = await request('/api/instances/modded1/mods', { method: 'POST', body: {} });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.details.field, 'versionId');

  const installed = await request('/api/instances/modded1/mods', {
    method: 'POST',
    body: { versionId: 'apimod-1' },
  });
  assert.equal(installed.status, 201, installed.text);
  assert.equal(installed.json.instanceId, 'modded1');
  assert.equal(installed.json.versionId, 'apimod-1');
  assert.equal(installed.json.installed, true);
  assert.equal(installed.json.files[0].filename, 'apimod.jar');

  const after = await request('/api/instances/modded1/mods');
  assert.equal(after.json.count, 1);
  assert.deepEqual(after.json.mods, [{ filename: 'apimod.jar', size: MOD_JAR.length }]);

  const card = await request('/api/instances/modded1');
  assert.equal(card.json.instance.mods, 1);

  const removed = await request('/api/instances/modded1/mods/apimod.jar', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.removed, true);
  assert.equal(removed.json.instanceId, 'modded1');

  const removedAgain = await request('/api/instances/modded1/mods/apimod.jar', { method: 'DELETE' });
  assert.equal(removedAgain.status, 404);
  assert.equal(removedAgain.json.error.code, 'MOD_NOT_FOUND');

  const empty = await request('/api/instances/modded1/mods');
  assert.equal(empty.json.count, 0);

  const unknownInstance = await request('/api/instances/ghost/mods');
  assert.equal(unknownInstance.status, 404);
});

test('mods API installs a versionIds batch and reports each version independently', async () => {
  await request('/api/instances', { method: 'POST', body: { name: 'Batchy', id: 'batchy1', ...BASE } });

  const empty = await request('/api/instances/batchy1/mods', { method: 'POST', body: { versionIds: [] } });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error.details.field, 'versionIds');

  const badItem = await request('/api/instances/batchy1/mods', { method: 'POST', body: { versionIds: ['apimod-1', 42] } });
  assert.equal(badItem.status, 400);
  assert.equal(badItem.json.error.details.field, 'versionIds');

  // มีทั้งตัวที่เจอและไม่เจอ → ok true/false ต่อรายการ ไม่ fail ทั้งชุด
  const batch = await request('/api/instances/batchy1/mods', {
    method: 'POST',
    body: { versionIds: ['apimod-1', 'missing-1'] },
  });
  assert.equal(batch.status, 201, batch.text);
  assert.equal(batch.json.count, 2);
  const byId = new Map(batch.json.results.map((entry) => [entry.versionId, entry]));
  assert.equal(byId.get('apimod-1').ok, true);
  assert.equal(byId.get('apimod-1').files[0].filename, 'apimod.jar');
  assert.equal(byId.get('missing-1').ok, false);
  assert.ok(byId.get('missing-1').error, 'failure carries an error message');

  const list = await request('/api/instances/batchy1/mods');
  assert.equal(list.json.count, 1, 'only the resolvable version installed');

  // packs batch เดินเส้นทางเดียวกัน
  const packs = await request('/api/instances/batchy1/packs', {
    method: 'POST',
    body: { versionIds: ['apimod-1'], kind: 'shaderpacks' },
  });
  assert.equal(packs.status, 201, packs.text);
  assert.equal(packs.json.kind, 'shaderpacks');
  assert.equal(packs.json.results[0].ok, true);
});

test('packs API installs, lists and removes resource packs and shaders per kind', async () => {
  await request('/api/instances', { method: 'POST', body: { name: 'Packy', id: 'packy1', ...BASE } });

  const resourceBefore = await request('/api/instances/packy1/packs?kind=resourcepacks');
  assert.equal(resourceBefore.status, 200);
  assert.equal(resourceBefore.json.kind, 'resourcepacks');
  assert.deepEqual(resourceBefore.json.packs, []);
  const shaderBefore = await request('/api/instances/packy1/packs?kind=shaderpacks');
  assert.equal(shaderBefore.status, 200);
  assert.equal(shaderBefore.json.count, 0);

  const installed = await request('/api/instances/packy1/packs', {
    method: 'POST',
    body: { versionId: 'apimod-1', kind: 'resourcepacks' },
  });
  assert.equal(installed.status, 201, installed.text);
  assert.equal(installed.json.kind, 'resourcepacks');
  assert.equal(installed.json.files[0].filename, 'apimod.jar');
  assert.equal(
    fs.existsSync(path.join(dataDir, 'instances', 'packy1', 'minecraft', 'resourcepacks', 'apimod.jar')),
    true,
    'the pack lands in gameDir/resourcepacks',
  );

  const shaderInstall = await request('/api/instances/packy1/packs', {
    method: 'POST',
    body: { versionId: 'apimod-1', kind: 'shaderpacks' },
  });
  assert.equal(shaderInstall.status, 201);
  assert.equal(shaderInstall.json.kind, 'shaderpacks');

  const invalidKind = await request('/api/instances/packy1/packs', {
    method: 'POST',
    body: { versionId: 'apimod-1', kind: 'cheats' },
  });
  assert.equal(invalidKind.status, 400);
  assert.equal(invalidKind.json.error.code, 'INVALID_PACK_KIND');

  const invalidVersion = await request('/api/instances/packy1/packs', { method: 'POST', body: {} });
  assert.equal(invalidVersion.status, 400);
  assert.equal(invalidVersion.json.error.details.field, 'versionId');

  const afterResource = await request('/api/instances/packy1/packs?kind=resourcepacks');
  assert.equal(afterResource.json.count, 1);
  assert.deepEqual(afterResource.json.packs, [{ filename: 'apimod.jar', size: MOD_JAR.length }]);
  const afterShader = await request('/api/instances/packy1/packs?kind=shaderpacks');
  assert.equal(afterShader.json.count, 1);

  const mods = await request('/api/instances/packy1/mods');
  assert.equal(mods.json.count, 0, 'packs never leak into the mods folder');

  const removed = await request('/api/instances/packy1/packs/apimod.jar?kind=resourcepacks', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.removed, true);
  assert.equal(removed.json.kind, 'resourcepacks');

  const resourceGone = await request('/api/instances/packy1/packs?kind=resourcepacks');
  assert.equal(resourceGone.json.count, 0);
  const shaderStill = await request('/api/instances/packy1/packs?kind=shaderpacks');
  assert.equal(shaderStill.json.count, 1, 'removal only touches the requested kind');

  const missing = await request('/api/instances/packy1/packs/nope.zip?kind=shaderpacks', { method: 'DELETE' });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'PACK_FILE_NOT_FOUND');

  const badKind = await request('/api/instances/packy1/packs?kind=nope');
  assert.equal(badKind.status, 400);
  assert.equal(badKind.json.error.code, 'INVALID_PACK_KIND');
});

test('removed files API trashes, lists and restores instance files for later recovery', async () => {
  await request('/api/instances', { method: 'POST', body: { name: 'Trashable', id: 'trashme1', ...BASE } });
  await request('/api/instances/trashme1/mods', { method: 'POST', body: { versionId: 'apimod-1' } });

  const modsDir = manager.paths('trashme1').modsDir;
  assert.equal(fs.existsSync(path.join(modsDir, 'apimod.jar')), true);

  const trashed = await request('/api/instances/trashme1/removed', {
    method: 'POST',
    body: { kind: 'mods', filename: 'apimod.jar', reason: 'incompatible', targetVersion: '1.21' },
  });
  assert.equal(trashed.status, 201, trashed.text);
  assert.equal(trashed.json.removed, true);
  assert.equal(trashed.json.remembered, true);
  assert.equal(fs.existsSync(path.join(modsDir, 'apimod.jar')), false);
  const bucket = path.join(manager.paths('trashme1').dir, '.removed', 'mods');
  assert.equal(fs.existsSync(path.join(bucket, 'apimod.jar')), true);

  const modsAfter = await request('/api/instances/trashme1/mods');
  assert.equal(modsAfter.json.count, 0);

  const list = await request('/api/instances/trashme1/removed');
  assert.equal(list.status, 200);
  assert.equal(list.json.count, 1);
  assert.deepEqual(
    {
      kind: list.json.removed[0].kind,
      filename: list.json.removed[0].filename,
      reason: list.json.removed[0].reason,
      targetVersion: list.json.removed[0].targetVersion,
    },
    { kind: 'mods', filename: 'apimod.jar', reason: 'incompatible', targetVersion: '1.21' },
  );
  assert.equal(typeof list.json.removed[0].size, 'number');
  assert.equal(typeof list.json.removed[0].removedAt, 'string');

  const trashedAgain = await request('/api/instances/trashme1/removed', {
    method: 'POST',
    body: { kind: 'mods', filename: 'apimod.jar' },
  });
  assert.equal(trashedAgain.status, 404);
  assert.equal(trashedAgain.json.error.code, 'MOD_NOT_FOUND');

  const traversal = await request('/api/instances/trashme1/removed', {
    method: 'POST',
    body: { kind: 'mods', filename: '../escape.jar' },
  });
  assert.equal(traversal.status, 400);
  assert.equal(traversal.json.error.code, 'INVALID_MOD_FILENAME');

  const badKind = await request('/api/instances/trashme1/removed', {
    method: 'POST',
    body: { kind: 'cheese', filename: 'x.jar' },
  });
  assert.equal(badKind.status, 400);
  assert.equal(badKind.json.error.code, 'INVALID_PACK_KIND');

  const restored = await request('/api/instances/trashme1/removed/restore', {
    method: 'POST',
    body: { kind: 'mods', filename: 'apimod.jar' },
  });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.restored, true);
  assert.equal(fs.existsSync(path.join(modsDir, 'apimod.jar')), true);
  const listAfter = await request('/api/instances/trashme1/removed');
  assert.equal(listAfter.json.count, 0);

  const restoreMissing = await request('/api/instances/trashme1/removed/restore', {
    method: 'POST',
    body: { kind: 'mods', filename: 'apimod.jar' },
  });
  assert.equal(restoreMissing.status, 404);
  assert.equal(restoreMissing.json.error.code, 'REMOVED_FILE_NOT_FOUND');

  // สร้างสถานะซ้ำ: มีไฟล์ชื่อเดียวกันทั้งใน mods/ และ .removed/ → restore ต้องชน (409) ไม่ทับเงียบ ๆ
  await request('/api/instances/trashme1/removed', { method: 'POST', body: { kind: 'mods', filename: 'apimod.jar' } });
  await request('/api/instances/trashme1/mods', { method: 'POST', body: { versionId: 'apimod-1' } });
  const conflict = await request('/api/instances/trashme1/removed/restore', {
    method: 'POST',
    body: { kind: 'mods', filename: 'apimod.jar' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'RESTORE_CONFLICT');
});

test('changing the Minecraft version remembers the previous one for the revert control', async () => {
  await request('/api/instances', { method: 'POST', body: { name: 'Revertible', id: 'revertme1', ...BASE } });
  const before = await request('/api/instances/revertme1');
  assert.equal(before.status, 200, before.text);
  assert.equal(before.json.instance.previousMinecraftVersion, null);

  const first = await request('/api/instances/revertme1', {
    method: 'PATCH',
    body: { minecraftVersion: '1.20.2' },
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.instance.minecraftVersion, '1.20.2');
  assert.equal(first.json.instance.previousMinecraftVersion, '1.20.1');

  // patch ด้วยเวอร์ชั่นเดิม → previous ห้ามถูกเขียนทับ
  const same = await request('/api/instances/revertme1', {
    method: 'PATCH',
    body: { minecraftVersion: '1.20.2' },
  });
  assert.equal(same.status, 200, same.text);
  assert.equal(same.json.instance.previousMinecraftVersion, '1.20.1');

  // patch อย่างอื่น (name) → previous ห้ามถูกแตะ
  const renamed = await request('/api/instances/revertme1', {
    method: 'PATCH',
    body: { name: 'Revertible Two' },
  });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.json.instance.previousMinecraftVersion, '1.20.1');

  const second = await request('/api/instances/revertme1', {
    method: 'PATCH',
    body: { minecraftVersion: '1.20.3' },
  });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.instance.minecraftVersion, '1.20.3');
  assert.equal(second.json.instance.previousMinecraftVersion, '1.20.2'); // จำล่าสุดที่เคยใช้ไว้เสมอ
});

test('removed list reports which files the target Minecraft version supports for auto-restore', async () => {
  await request('/api/instances', { method: 'POST', body: { name: 'Supporty', id: 'supporty1', ...BASE } });
  await request('/api/instances/supporty1/mods', { method: 'POST', body: { versionId: 'apimod-1' } });
  await request('/api/instances/supporty1/removed', {
    method: 'POST',
    body: { kind: 'mods', filename: 'apimod.jar', reason: 'incompatible', targetVersion: '1.21' },
  });
  // ไฟล์ที่วางเองโดยไม่ผ่าน API → ไม่มีใน registry → ไม่รู้ว่ารองรับไหม
  const modsDir = manager.paths('supporty1').modsDir;
  fs.writeFileSync(path.join(modsDir, 'mystery.jar'), 'mystery');
  await request('/api/instances/supporty1/removed', {
    method: 'POST',
    body: { kind: 'mods', filename: 'mystery.jar', reason: 'manual' },
  });

  const plain = await request('/api/instances/supporty1/removed');
  assert.equal(plain.status, 200);
  assert.equal(plain.json.count, 2);
  for (const entry of plain.json.removed) {
    assert.equal(Object.hasOwn(entry, 'supported'), false, 'supported ตอบเฉพาะตอนระบุ minecraftVersion');
  }

  const supported = await request('/api/instances/supporty1/removed?minecraftVersion=1.20.1');
  assert.equal(supported.status, 200, supported.text);
  const byName = Object.fromEntries(supported.json.removed.map((entry) => [entry.filename, entry]));
  assert.equal(byName['apimod.jar'].supported, true, 'เวอร์ชี Modrinth ของ apimod.jar รองรับ 1.20.1');
  assert.equal(byName['mystery.jar'].supported, false, 'ไม่มีใน registry → ไม่ auto-restore');

  const unsupported = await request('/api/instances/supporty1/removed?minecraftVersion=1.19.2');
  assert.equal(unsupported.status, 200, unsupported.text);
  const byName2 = Object.fromEntries(unsupported.json.removed.map((entry) => [entry.filename, entry]));
  assert.equal(byName2['apimod.jar'].supported, false);
  assert.equal(byName2['mystery.jar'].supported, false);
});

test('trashing and restoring files in parallel keeps every removed-index entry', async () => {
  await request('/api/instances', { method: 'POST', body: { name: 'Bursty', id: 'bursty1', ...BASE } });
  const modsDir = manager.paths('bursty1').modsDir;
  fs.mkdirSync(modsDir, { recursive: true });
  const filenames = ['burst-a.jar', 'burst-b.jar', 'burst-c.jar'];
  for (const filename of filenames) fs.writeFileSync(path.join(modsDir, filename), filename);

  const trashed = await Promise.all(
    filenames.map((filename) =>
      request('/api/instances/bursty1/removed', {
        method: 'POST',
        body: { kind: 'mods', filename, reason: 'incompatible', targetVersion: '1.21' },
      }),
    ),
  );
  for (const res of trashed) assert.equal(res.status, 201, res.text);

  const list = await request('/api/instances/bursty1/removed');
  assert.equal(list.json.count, 3, 'รายการที่ลบพร้อมกันต้องครบสามไฟล์');
  assert.deepEqual(list.json.removed.map((entry) => entry.filename).sort(), [...filenames].sort());

  const restored = await Promise.all(
    filenames.map((filename) =>
      request('/api/instances/bursty1/removed/restore', {
        method: 'POST',
        body: { kind: 'mods', filename },
      }),
    ),
  );
  for (const res of restored) assert.equal(res.status, 200, res.text);
  for (const filename of filenames) {
    assert.equal(fs.existsSync(path.join(modsDir, filename)), true, `${filename} ต้องกลับเข้า mods/`);
  }
  const after = await request('/api/instances/bursty1/removed');
  assert.equal(after.json.count, 0);
});

test('checks for different kinds run at the same time instead of queueing behind one instance lock', async () => {
  await request('/api/instances', { method: 'POST', body: { name: 'Parallel', id: 'parakeck1', ...BASE } });
  await request('/api/instances/parakeck1/mods', { method: 'POST', body: { versionId: 'apimod-1' } });
  // ใส่ไฟล์ resource pack + registry entry ด้วย → ทั้งสอง kind ต้องเรียก listVersions (delay ใน fake) จริงทั้งคู่
  const gameDir = manager.paths('parakeck1').gameDir;
  const rpDir = path.join(gameDir, 'resourcepacks');
  fs.mkdirSync(rpDir, { recursive: true });
  fs.writeFileSync(path.join(rpDir, 'probe-rp.zip'), 'pack');
  fs.writeFileSync(
    path.join(manager.paths('parakeck1').dir, 'mod-registry.json'),
    JSON.stringify({
      'probe-rp.zip': { projectId: 'apiproj', versionId: 'apimod-1', versionNumber: '1.2.3', kind: 'resourcepacks' },
    }),
  );

  const [mods, packs] = await Promise.all([
    request('/api/instances/parakeck1/check', { method: 'POST', body: { kind: 'mods' } }),
    request('/api/instances/parakeck1/check', { method: 'POST', body: { kind: 'resourcepacks' } }),
  ]);
  // code เดิมกันทั้ง instance (409 CHECK_ALREADY_RUNNING) → kind ที่สองต้องพลาด แต่ตอนนี้ต้อง 200 ทั้งคู่
  assert.equal(mods.status, 200, mods.text);
  assert.equal(packs.status, 200, packs.text);
  assert.equal(mods.json.checked, 1);
  assert.equal(packs.json.checked, 1);

  const progress = await request('/api/instances/parakeck1/check-progress');
  assert.equal(progress.status, 200);
  assert.equal(progress.json.instanceId, 'parakeck1');
  assert.equal(progress.json.running, false, 'progress settled once both checks answered');
  assert.equal(progress.json.phase, 'done');
  assert.equal(typeof progress.json.finishedAt, 'number');
});

test('check API verifies instance files against Modrinth and reports update state', async () => {
  const idle = await request('/api/instances/checky1/check-progress');
  assert.equal(idle.status, 200, 'progress route answers even before any check');
  assert.equal(idle.json.phase, 'idle');
  assert.equal(idle.json.running, false);

  await request('/api/instances', { method: 'POST', body: { name: 'Checky', id: 'checky1', ...BASE } });

  const missing = await request('/api/instances/nope/check', { method: 'POST', body: {} });
  assert.equal(missing.status, 404);

  const badKind = await request('/api/instances/checky1/check', { method: 'POST', body: { kind: 'cheats' } });
  assert.equal(badKind.status, 400);
  assert.equal(badKind.json.error.code, 'INVALID_PACK_KIND');

  const empty = await request('/api/instances/checky1/check', { method: 'POST', body: { kind: 'resourcepacks' } });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.kind, 'resourcepacks');
  assert.equal(empty.json.checked, 0);
  assert.deepEqual(empty.json.files, []);

  const installed = await request('/api/instances/checky1/mods', {
    method: 'POST',
    body: { versionId: 'apimod-1' },
  });
  assert.equal(installed.status, 201, installed.text);

  listVersionCalls.length = 0;
  const checked = await request('/api/instances/checky1/check', { method: 'POST', body: { kind: 'mods' } });
  assert.equal(checked.status, 200, checked.text);
  assert.equal(checked.json.instanceId, 'checky1');
  assert.equal(checked.json.kind, 'mods');
  assert.equal(checked.json.checked, 1);
  assert.deepEqual(checked.json.adopted, [], 'registry-tracked files skip hash adoption');
  assert.equal(checked.json.updateCount, 0, 'the installed version is the latest known one');
  const entry = checked.json.files[0];
  assert.equal(entry.filename, 'apimod.jar');
  assert.equal(entry.status, 'checked');
  assert.equal(entry.projectId, 'apiproj');
  assert.equal(entry.versionId, 'apimod-1');
  assert.equal(entry.updateAvailable, false);
  assert.deepEqual(entry.latest, { versionId: 'apimod-1', versionNumber: '1.2.3' });
  assert.deepEqual(listVersionCalls[0], {
    projectId: 'apiproj',
    options: { gameVersions: ['1.20.1'], loaders: ['fabric'] },
  });

  const progress = await request('/api/instances/checky1/check-progress');
  assert.equal(progress.status, 200);
  assert.equal(progress.json.instanceId, 'checky1');
  assert.equal(progress.json.running, false, 'progress is settled once the POST answered');
  assert.equal(progress.json.phase, 'done');
  assert.equal(typeof progress.json.startedAt, 'number');
  assert.equal(typeof progress.json.finishedAt, 'number');
});

test('import API accepts an absolute .zip path behind the same preview flow', async () => {
  const zip = manifestZip('Path Import');
  const zipPath = path.join(dataDir, 'path-import.zip');
  fs.writeFileSync(zipPath, zip);
  const dirZip = path.join(dataDir, 'fake-dir.zip');
  fs.mkdirSync(dirZip, { recursive: true });

  try {
    const noPreview = await request('/api/instances/import', { method: 'POST', body: { path: zipPath } });
    assert.equal(noPreview.status, 400);
    assert.equal(noPreview.json.error.code, 'IMPORT_PREVIEW_REQUIRED');

    const relative = await request('/api/instances/import?preview=1', {
      method: 'POST',
      body: { path: 'relative/export.zip' },
    });
    assert.equal(relative.status, 400);
    assert.equal(relative.json.error.code, 'IMPORT_PATH_NOT_ABSOLUTE');

    const notZip = await request('/api/instances/import?preview=1', {
      method: 'POST',
      body: { path: path.join(dataDir, 'notes.txt') },
    });
    assert.equal(notZip.status, 400);
    assert.equal(notZip.json.error.code, 'IMPORT_PATH_NOT_ZIP');

    const missing = await request('/api/instances/import?preview=1', {
      method: 'POST',
      body: { path: path.join(dataDir, 'ghost.zip') },
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'IMPORT_PATH_NOT_FOUND');

    const notAFile = await request('/api/instances/import?preview=1', {
      method: 'POST',
      body: { path: dirZip },
    });
    assert.equal(notAFile.status, 400);
    assert.equal(notAFile.json.error.code, 'IMPORT_PATH_NOT_A_FILE');

    const preview = await request('/api/instances/import?preview=1', {
      method: 'POST',
      body: { path: zipPath },
    });
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.json.preview, true);
    assert.match(preview.json.token, /^[a-f0-9]{32}$/);
    assert.equal(preview.json.manifest.name, 'Path Import');
    assert.deepEqual(preview.json.manifest, {
      name: 'Path Import',
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      fabricLoaderVersion: '0.15.7',
      type: 'client',
    });

    const staging = path.join(config.paths.tmpDir, 'import-staging');
    assert.equal(fs.existsSync(path.join(staging, `${preview.json.token}.zip`)), true, 'the path archive is staged as a copy');

    const confirmed = await request('/api/instances/import', {
      method: 'POST',
      body: { token: preview.json.token, name: 'Path Confirmed' },
    });
    assert.equal(confirmed.status, 201, confirmed.text);
    assert.equal(confirmed.json.name, 'Path Confirmed');
    assert.equal(confirmed.json.manifest.name, 'Path Import');
    assert.equal(fs.existsSync(path.join(staging, `${preview.json.token}.zip`)), false, 'confirm consumes the staged copy');
  } finally {
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(dirZip, { recursive: true, force: true });
  }
});

test('launch progress route reports idle state and validates the instance id', async () => {
  const idle = await request('/api/instances/runner1/launch-progress');
  assert.equal(idle.status, 200);
  assert.deepEqual(idle.json, {
    instanceId: 'runner1',
    launching: false,
    stage: 'idle',
    percent: 0,
    loaded: 0,
    total: 0,
  });

  const badId = await request('/api/instances/BAD%20ID!/launch-progress');
  assert.equal(badId.status, 400);
  assert.ok(badId.json.error.code);
});

test('instance routes appear in the route listing', async () => {
  const res = await request('/api/routes');
  const routes = res.json.routes;
  for (const expected of [
    'GET /api/instances',
    'POST /api/instances',
    'GET /api/instances/:id',
    'DELETE /api/instances/:id',
    'POST /api/instances/:id/launch',
    'POST /api/instances/:id/stop',
    'POST /api/instances/:id/export',
    'POST /api/instances/import',
    'GET /api/instances/:id/mods',
    'POST /api/instances/:id/mods',
    'DELETE /api/instances/:id/mods/:modId',
    'GET /api/instances/:id/packs',
    'POST /api/instances/:id/packs',
    'DELETE /api/instances/:id/packs/:fileId',
    'POST /api/instances/:id/check',
    'GET /api/instances/:id/check-progress',
    'GET /api/instances/:id/launch-progress',
  ]) {
    assert.ok(routes.includes(expected), `${expected} must be listed`);
  }
});
