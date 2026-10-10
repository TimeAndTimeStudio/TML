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
import { JavaRuntimeError } from '../../src/core/errors.js';
import { createApiRouter } from '../../src/server/routes.js';
import { createTmlServer } from '../../src/server/server.js';
import { createInstanceManager } from '../../src/instance/manager.js';

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
let config;
let logger;
let java;

function createFakeJava() {
  const downloaded = new Set();
  const state = { chosen: null, downloads: [] };
  return {
    state,
    async list() {
      return [
        {
          name: 'java-runtime-gamma',
          javaVersion: '17.0.15',
          released: '2025-05-19',
          major: 17,
          manifestUrl: 'https://piston-meta.mojang.com/manifest.json',
          manifestSha1: 'a'.repeat(40),
          downloaded: downloaded.has('java-runtime-gamma'),
        },
        {
          name: 'java-runtime-delta',
          javaVersion: '21.0.7',
          released: '2025-05-19',
          major: 21,
          downloaded: downloaded.has('java-runtime-delta'),
        },
      ];
    },
    getChosen() {
      return state.chosen;
    },
    setChosen(name) {
      state.chosen = name;
      return name;
    },
    async download(name, opts = {}) {
      if (name === 'java-runtime-nope') {
        throw new JavaRuntimeError(`Unknown Java runtime: ${name}`, {
          code: 'JAVA_RUNTIME_NOT_FOUND',
          status: 404,
          details: { name },
        });
      }
      state.downloads.push({ name, force: opts.force === true });
      const cached = downloaded.has(name);
      downloaded.add(name);
      if (typeof opts.onProgress === 'function') {
        opts.onProgress({
          stage: 'java',
          loaded: cached ? 0 : 95000000,
          total: cached ? 0 : 95000000,
          percent: 100,
          files: { done: cached ? 0 : 133, count: 133 },
        });
      }
      return {
        name,
        path: path.join(config.paths.javaDir, name),
        cached,
        files: cached ? 0 : 133,
        bytes: cached ? 0 : 95000000,
      };
    },
    async remove(name) {
      if (!downloaded.has(name)) {
        throw new JavaRuntimeError(`Java runtime ${name} is not downloaded`, {
          code: 'JAVA_RUNTIME_NOT_DOWNLOADED',
          status: 404,
          details: { name },
        });
      }
      downloaded.delete(name);
      const clearedChosen = state.chosen === name;
      if (clearedChosen) state.chosen = null;
      return { name, deleted: true, clearedChosen };
    },
  };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-java-api-'));
  config = loadConfig({ env: { TML_DATA_DIR: dataDir, TML_LOG_LEVEL: 'silent' } });
  logger = createLogger({ level: 'silent' });
  java = createFakeJava();
  const manager = createInstanceManager({ config, logger });

  const router = createApiRouter({ config, logger, instance: { manager }, java });
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

test('GET /api/java/runtimes lists runtimes without leaking manifest internals', async () => {
  const res = await request(port, '/api/java/runtimes');
  assert.equal(res.status, 200);
  assert.equal(res.json.chosen, null);
  assert.equal(res.json.count, 2);
  assert.deepEqual(Object.keys(res.json.runtimes[0]).sort(), [
    'downloaded',
    'javaVersion',
    'major',
    'name',
    'released',
  ]);
  assert.equal(res.json.runtimes[0].name, 'java-runtime-gamma');
  assert.equal(res.json.runtimes[0].javaVersion, '17.0.15');
  assert.equal(res.json.runtimes[0].major, 17);
  assert.equal(res.json.runtimes[0].downloaded, false);
  assert.equal('manifestUrl' in res.json.runtimes[0], false);
});

test('POST download installs a runtime, records it as chosen and persists the choice', async () => {
  const res = await request(port, '/api/java/runtimes/java-runtime-delta/download', { method: 'POST', body: {} });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.name, 'java-runtime-delta');
  assert.equal(res.json.chosen, 'java-runtime-delta');
  assert.equal(res.json.cached, false);
  assert.equal(res.json.files, 133);
  assert.deepEqual(java.state.downloads.at(-1), { name: 'java-runtime-delta', force: false });

  const forced = await request(port, '/api/java/runtimes/java-runtime-delta/download', {
    method: 'POST',
    body: { force: true },
  });
  assert.equal(forced.status, 200, 'a cached download answers 200');
  assert.equal(forced.json.cached, true);
  assert.deepEqual(java.state.downloads.at(-1), { name: 'java-runtime-delta', force: true });

  const configRes = await request(port, '/api/config');
  assert.equal(configRes.json.java, 'java-runtime-delta');

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(persisted.java, 'java-runtime-delta');

  const list = await request(port, '/api/java/runtimes');
  assert.equal(list.json.chosen, 'java-runtime-delta');
  assert.equal(list.json.runtimes.find((runtime) => runtime.name === 'java-runtime-delta').downloaded, true);
});

test('POST download validates names and 404s unknown runtimes', async () => {
  const invalid = await request(port, '/api/java/runtimes/BAD%20NAME/download', { method: 'POST', body: {} });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'INVALID_JAVA_RUNTIME');

  const escape = await request(port, '/api/java/runtimes/..%2F..%2Fetc%2Fpasswd/download', {
    method: 'POST',
    body: {},
  });
  assert.equal(escape.status, 400);
  assert.equal(escape.json.error.code, 'INVALID_JAVA_RUNTIME');

  const unknown = await request(port, '/api/java/runtimes/java-runtime-nope/download', { method: 'POST', body: {} });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'JAVA_RUNTIME_NOT_FOUND');
});

test('PATCH /api/config sets, validates and clears the chosen java runtime', async () => {
  const patched = await request(port, '/api/config', {
    method: 'PATCH',
    body: { java: 'java-runtime-gamma' },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.saved, true);
  assert.deepEqual(patched.json.changed, ['java']);
  assert.deepEqual(patched.json.restartRequired, []);
  assert.equal(patched.json.config.java, 'java-runtime-gamma');
  assert.equal(java.state.chosen, 'java-runtime-gamma');

  const list = await request(port, '/api/java/runtimes');
  assert.equal(list.json.chosen, 'java-runtime-gamma');

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(persisted.java, 'java-runtime-gamma');

  const invalid = await request(port, '/api/config', { method: 'PATCH', body: { java: 'UPPER' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'INVALID_JAVA_RUNTIME');

  const empty = await request(port, '/api/config', { method: 'PATCH', body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error.code, 'CONFIG_PATCH_EMPTY');

  const cleared = await request(port, '/api/config', { method: 'PATCH', body: { java: null } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json.changed, ['java']);
  assert.equal(cleared.json.config.java, null);
  assert.equal(java.state.chosen, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).java, null);
});

test('PLAY refuses to launch until a downloaded java runtime is selected', async () => {
  // ยังไม่ได้เลือก runtime เลย → 409
  const unchosen = await request(port, '/api/instances/no-such-instance/launch', { method: 'POST', body: {} });
  assert.equal(unchosen.status, 409, unchosen.text);
  assert.equal(unchosen.json.error.code, 'JAVA_RUNTIME_UNAVAILABLE');
  assert.equal(unchosen.json.error.details.chosen, null);

  // เลือก runtime ที่ยังไม่ได้โหลด → ยังใช้ไม่ได้
  await request(port, '/api/config', { method: 'PATCH', body: { java: 'java-runtime-gamma' } });
  const notDownloaded = await request(port, '/api/instances/no-such-instance/launch', { method: 'POST', body: {} });
  assert.equal(notDownloaded.status, 409, notDownloaded.text);
  assert.equal(notDownloaded.json.error.code, 'JAVA_RUNTIME_UNAVAILABLE');
  assert.equal(notDownloaded.json.error.details.chosen, 'java-runtime-gamma');

  // โหลด runtime ที่เลือกไว้แล้ว → ผ่าน guard (ไปต่อจนถึงขั้นหา instance ซึ่งไม่มีอยู่ → 404)
  await request(port, '/api/java/runtimes/java-runtime-delta/download', { method: 'POST', body: {} });
  const passed = await request(port, '/api/instances/no-such-instance/launch', { method: 'POST', body: {} });
  assert.equal(passed.status, 404, passed.text);
  assert.equal(passed.json.error.code, 'INSTANCE_NOT_FOUND');
});

test('GET download progress is idle before a download and done after it', async () => {
  const idle = await request(port, '/api/java/runtimes/java-runtime-gamma/progress');
  assert.equal(idle.status, 200);
  assert.deepEqual(idle.json, {
    name: 'java-runtime-gamma',
    active: false,
    phase: 'idle',
    loaded: 0,
    total: 0,
    percent: 0,
    files: { done: 0, count: 0 },
  });

  const started = await request(port, '/api/java/runtimes/java-runtime-gamma/download', { method: 'POST', body: {} });
  assert.equal(started.status, 201, started.text);

  const done = await request(port, '/api/java/runtimes/java-runtime-gamma/progress');
  assert.equal(done.status, 200);
  assert.equal(done.json.active, false, 'the entry is not active once the download settles');
  assert.equal(done.json.phase, 'done');
  assert.equal(done.json.percent, 100);
  assert.deepEqual(done.json.files, { done: 133, count: 133 });
  assert.equal(done.json.loaded, 95000000);
  assert.equal(done.json.total, 95000000);

  const invalid = await request(port, '/api/java/runtimes/BAD%20NAME/progress');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'INVALID_JAVA_RUNTIME');
});

test('DELETE removes a downloaded runtime and clears the persisted selection', async () => {
  // gamma เพิ่งถูก download → เป็นตัวที่เลือกอยู่ (POST download setChosen อัตโนมัติ)
  const res = await request(port, '/api/java/runtimes/java-runtime-gamma', { method: 'DELETE' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.deleted, true);
  assert.equal(res.json.clearedChosen, true, 'deleting the chosen runtime clears the selection');
  assert.equal(res.json.chosen, null);

  const list = await request(port, '/api/java/runtimes');
  assert.equal(list.json.chosen, null);
  assert.equal(
    list.json.runtimes.find((runtime) => runtime.name === 'java-runtime-gamma').downloaded,
    false,
    'the runtime is no longer downloaded',
  );

  const configRes = await request(port, '/api/config');
  assert.equal(configRes.json.java, null, 'the cleared selection is served live');
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(persisted.java, null, 'the cleared selection is persisted to config.json');

  const again = await request(port, '/api/java/runtimes/java-runtime-gamma', { method: 'DELETE' });
  assert.equal(again.status, 404, 'deleting twice must not succeed');
  assert.equal(again.json.error.code, 'JAVA_RUNTIME_NOT_DOWNLOADED');

  const invalid = await request(port, '/api/java/runtimes/BAD%20NAME', { method: 'DELETE' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'INVALID_JAVA_RUNTIME');

  const escape = await request(port, '/api/java/runtimes/..%2F..%2Fetc%2Fpasswd', { method: 'DELETE' });
  assert.equal(escape.status, 400);
  assert.equal(escape.json.error.code, 'INVALID_JAVA_RUNTIME');

  const never = await request(port, '/api/java/runtimes/java-runtime-alpha', { method: 'DELETE' });
  assert.equal(never.status, 404, 'a valid name that was never downloaded answers 404');
  assert.equal(never.json.error.code, 'JAVA_RUNTIME_NOT_DOWNLOADED');
});

test('DELETE a downloaded runtime that is not chosen keeps the selection intact', async () => {
  // delta ยังโหลดอยู่และไม่ได้ถูกเลือก (selection ถูกค้างเป็น null ไว้)
  const res = await request(port, '/api/java/runtimes/java-runtime-delta', { method: 'DELETE' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.deleted, true);
  assert.equal(res.json.clearedChosen, false);
  assert.equal(res.json.chosen, null);

  const list = await request(port, '/api/java/runtimes');
  assert.equal(
    list.json.runtimes.every((runtime) => runtime.downloaded === false),
    true,
    'nothing is left downloaded',
  );
});
