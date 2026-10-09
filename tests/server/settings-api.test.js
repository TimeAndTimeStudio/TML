// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { createApiRouter } from '../../src/server/routes.js';
import { createTmlServer } from '../../src/server/server.js';
import { createInstanceManager } from '../../src/instance/manager.js';

const SEEDED_CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function request(target, pathname, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port: target,
        path: pathname,
        method,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
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
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let server;
let port;
let dataDir;
let logger;
let manager;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-settings-'));
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    `${JSON.stringify({ auth: { clientId: SEEDED_CLIENT_ID }, log: { level: 'info' } }, null, 2)}\n`,
  );
  const config = loadConfig({ env: { TML_DATA_DIR: dataDir } });
  logger = createLogger({ level: 'silent' });
  manager = createInstanceManager({ config, logger });

  const router = createApiRouter({ config, logger, instance: { manager } });
  server = createTmlServer({ config, logger, router });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('PATCH /api/config persists host, port and log level and applies the level live', async () => {
  const res = await request(port, '/api/config', {
    method: 'PATCH',
    body: { server: { host: '0.0.0.0', port: 9620 }, log: { level: 'error' } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.saved, true);
  assert.deepEqual(res.json.changed, ['server.host', 'server.port', 'log.level']);
  assert.deepEqual(res.json.restartRequired, ['server']);
  assert.deepEqual(res.json.config.server, { host: '0.0.0.0', port: 9620 });
  assert.equal(res.json.config.log.level, 'error');

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(persisted.server.host, '0.0.0.0');
  assert.equal(persisted.server.port, 9620);
  assert.equal(persisted.log.level, 'error');
  assert.equal(persisted.auth.clientId, SEEDED_CLIENT_ID, 'unrelated config keys must survive');

  const view = await request(port, '/api/config');
  assert.equal(view.status, 200);
  assert.deepEqual(view.json.server, { host: '0.0.0.0', port: 9620 });
  assert.equal(view.json.log.level, 'error');
  assert.equal(view.text.includes(SEEDED_CLIENT_ID), false, 'public config must not leak the client id');

  assert.equal(logger.level, 'error', 'the log level must apply without a restart');
});

test('PATCH /api/config rejects invalid values without touching the config', async () => {
  const cases = [
    [{ server: { port: 70000 } }, 'INVALID_PORT'],
    [{ server: { port: 'not-a-port' } }, 'INVALID_PORT'],
    [{ server: { host: '   ' } }, 'INVALID_HOST'],
    [{ log: { level: 'loud' } }, 'INVALID_LOG_LEVEL'],
    [{ window: { platform: 'x11' } }, 'INVALID_WINDOW_PLATFORM'],
    [{}, 'CONFIG_PATCH_EMPTY'],
  ];
  for (const [body, code] of cases) {
    const res = await request(port, '/api/config', { method: 'PATCH', body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(res.json.error.code, code, `expected ${code} for ${JSON.stringify(body)}`);
  }

  const view = await request(port, '/api/config');
  assert.deepEqual(view.json.server, { host: '0.0.0.0', port: 9620 }, 'a rejected patch must not change anything');
  assert.equal(view.json.log.level, 'error');
});

test('PATCH /api/config manages the game window platform', async () => {
  const set = await request(port, '/api/config', {
    method: 'PATCH',
    body: { window: { platform: 'wayland' } },
  });
  assert.equal(set.status, 200);
  assert.equal(set.json.saved, true);
  assert.deepEqual(set.json.changed, ['window.platform']);
  assert.deepEqual(set.json.restartRequired, [], 'the platform applies to the next launch, not to the server');
  assert.equal(set.json.config.window.platform, 'wayland');

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(persisted.window.platform, 'wayland');
  assert.equal(persisted.auth.clientId, SEEDED_CLIENT_ID, 'unrelated config keys must survive');

  const view = await request(port, '/api/config');
  assert.equal(view.json.window.platform, 'wayland');

  const again = await request(port, '/api/config', {
    method: 'PATCH',
    body: { window: { platform: 'wayland' } },
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.saved, false, 'patching the same value must be a no-op');
  assert.deepEqual(again.json.changed, []);

  const reset = await request(port, '/api/config', {
    method: 'PATCH',
    body: { window: { platform: null } },
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.config.window.platform, 'auto');
});

test('values provided via environment variables cannot be overwritten through PATCH /api/config', async () => {
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-settings-env-'));
  const envConfig = loadConfig({
    env: {
      TML_DATA_DIR: envDir,
      TML_HOST: '127.0.0.1',
      TML_PORT: '0',
      TML_LOG_LEVEL: 'silent',
    },
  });
  const envLogger = createLogger({ level: 'silent' });
  const envRouter = createApiRouter({ config: envConfig, logger: envLogger });
  const envServer = createTmlServer({ config: envConfig, logger: envLogger, router: envRouter });
  await new Promise((resolve, reject) => {
    envServer.once('error', reject);
    envServer.listen(0, '127.0.0.1', resolve);
  });
  try {
    const envPort = envServer.address().port;
    for (const body of [
      { server: { host: '1.2.3.4' } },
      { server: { port: 1234 } },
      { log: { level: 'debug' } },
    ]) {
      const res = await request(envPort, '/api/config', { method: 'PATCH', body });
      assert.equal(res.status, 409, `expected 409 for ${JSON.stringify(body)}`);
      assert.equal(res.json.error.code, 'CONFIG_FROM_ENV');
    }
    assert.equal(fs.existsSync(path.join(envDir, 'config.json')), false, 'a refused patch must not create a config file');
  } finally {
    await new Promise((resolve) => envServer.close(resolve));
    fs.rmSync(envDir, { recursive: true, force: true });
  }
});

test('PATCH /api/instances/:id updates name and memory in memory and on disk', async () => {
  const created = await manager.create({
    name: 'Alpha',
    minecraftVersion: '1.20.1',
    fabricLoaderVersion: '0.15.7',
  });

  const res = await request(port, `/api/instances/${created.id}`, {
    method: 'PATCH',
    body: {
      name: 'Beta',
      memory: { min: '1024M', max: '4096M' },
      extraJvmArgs: ['-Dtml.custom=1'],
      extraGameArgs: ['--demo'],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.instance.name, 'Beta');
  assert.deepEqual(res.json.instance.memory, { min: '1024M', max: '4096M' });
  assert.deepEqual(res.json.instance.extraJvmArgs, ['-Dtml.custom=1']);
  assert.deepEqual(res.json.instance.extraGameArgs, ['--demo']);
  assert.equal(res.json.instance.minecraftVersion, '1.20.1', 'version fields must stay untouched');

  const fresh = await manager.get(created.id);
  assert.equal(fresh.name, 'Beta');
  assert.deepEqual(fresh.memory, { min: '1024M', max: '4096M' });
  assert.deepEqual(fresh.extraJvmArgs, ['-Dtml.custom=1']);
  assert.deepEqual(fresh.extraGameArgs, ['--demo']);

  const view = await request(port, `/api/instances/${created.id}`);
  assert.equal(view.json.instance.name, 'Beta');

  const noop = await request(port, `/api/instances/${created.id}`, {
    method: 'PATCH',
    body: { name: 'Beta' },
  });
  assert.equal(noop.status, 200);
  assert.equal(noop.json.instance.name, 'Beta');

  // เปลี่ยน Minecraft version ได้ผ่าน PATCH (ค่าใหม่ถูก validate + เขียนลง meta)
  const bumped = await request(port, `/api/instances/${created.id}`, {
    method: 'PATCH',
    body: { minecraftVersion: '1.20.4' },
  });
  assert.equal(bumped.status, 200);
  assert.equal(bumped.json.instance.minecraftVersion, '1.20.4');
  const persisted = await manager.get(created.id);
  assert.equal(persisted.minecraftVersion, '1.20.4', 'the new version must reach disk');
  assert.equal(persisted.name, 'Beta', 'other fields must stay untouched');
});

test('PATCH /api/instances/:id validates the patch shape and fields', async () => {
  const created = await manager.create({
    name: 'Gamma',
    minecraftVersion: '1.20.1',
    fabricLoaderVersion: '0.15.7',
  });

  const cases = [
    [{ name: '' }, 'INVALID_INSTANCE_NAME', 400],
    [{ memory: { min: 'banana', max: '4096M' } }, 'INVALID_MEMORY', 400],
    [{ minecraftVersion: 'bad@ver' }, 'INVALID_VERSION_ID', 400],
    [{ bogusField: true }, 'FIELD_NOT_ALLOWED', 400],
    [{ extraJvmArgs: '-Xmx2G' }, 'INVALID_EXTRA_ARGS', 400],
    [{ extraGameArgs: [''] }, 'INVALID_EXTRA_ARGS', 400],
    [[1, 2, 3], 'INVALID_INSTANCE_PATCH', 400],
  ];
  for (const [body, code, status] of cases) {
    const res = await request(port, `/api/instances/${created.id}`, { method: 'PATCH', body });
    assert.equal(res.status, status, `expected ${status} for ${JSON.stringify(body)}`);
    assert.equal(res.json.error.code, code, `expected ${code} for ${JSON.stringify(body)}`);
  }

  const missing = await request(port, '/api/instances/does-not-exist', {
    method: 'PATCH',
    body: { name: 'Nope' },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'INSTANCE_NOT_FOUND');

  const untouched = await manager.get(created.id);
  assert.equal(untouched.name, 'Gamma', 'a rejected patch must not change the instance');
});

test('PATCH /api/config manages the offline player name', async () => {
  const set = await request(port, '/api/config', {
    method: 'PATCH',
    body: { auth: { offlineName: 'Steve_' } },
  });
  assert.equal(set.status, 200);
  assert.ok(set.json.changed.includes('auth.offlineName'));
  assert.equal(set.json.config.auth.offlineName, 'Steve_');
  assert.deepEqual(set.json.restartRequired, [], 'an offline name applies without a restart');

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(persisted.auth.offlineName, 'Steve_');
  assert.equal(persisted.auth.clientId, SEEDED_CLIENT_ID, 'unrelated auth keys must survive');

  const view = await request(port, '/api/config');
  assert.equal(view.json.auth.offlineName, 'Steve_');

  for (const bad of ['ab', 'x'.repeat(17), 'bad name', 'name!', 123]) {
    const res = await request(port, '/api/config', {
      method: 'PATCH',
      body: { auth: { offlineName: bad } },
    });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(res.json.error.code, 'INVALID_OFFLINE_NAME');
  }
  const still = await request(port, '/api/config');
  assert.equal(still.json.auth.offlineName, 'Steve_', 'a rejected patch must not change the name');

  const reset = await request(port, '/api/config', {
    method: 'PATCH',
    body: { auth: { offlineName: null } },
  });
  assert.equal(reset.status, 200);
  assert.ok(reset.json.changed.includes('auth.offlineName'));
  assert.equal(reset.json.config.auth.offlineName, null);
  const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal('offlineName' in after.auth, false, 'resetting removes the persisted key');
  assert.equal(after.auth.clientId, SEEDED_CLIENT_ID, 'unrelated auth keys must survive the reset');
});

