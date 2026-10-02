// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { createApiRouter } from '../../src/server/routes.js';
import { createTmlServer } from '../../src/server/server.js';

let server;
let port;
let dataDir;

function rawRequest(pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-server-'));
  const config = loadConfig({ env: { TML_DATA_DIR: dataDir, TML_PORT: '0', TML_LOG_LEVEL: 'silent' } });
  const logger = createLogger({ level: 'silent' });
  const router = createApiRouter({ config, logger });
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

test('GET /api/health returns launcher status', async () => {
  const res = await rawRequest('/api/health');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);

  const payload = JSON.parse(res.body);
  assert.equal(payload.status, 'ok');
  assert.equal(payload.name, 'TML');
  assert.equal(typeof payload.uptimeSeconds, 'number');
  assert.equal(payload.node, process.version);
});

test('GET /api/config returns launcher configuration', async () => {
  const res = await rawRequest('/api/config');
  assert.equal(res.status, 200);

  const payload = JSON.parse(res.body);
  assert.equal(payload.server.port, 0);
  assert.equal(payload.phase, undefined);
  assert.ok(payload.paths.dataDir);
  assert.ok(!/token|password|secret/i.test(res.body));
});

test('GET / serves the launcher UI', async () => {
  const res = await rawRequest('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /TML/);
  assert.match(res.body, /Time Mini Launcher/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('static assets are served with correct content types', async () => {
  const css = await rawRequest('/css/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);

  const js = await rawRequest('/js/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
});

test('unknown API route returns JSON 404', async () => {
  const res = await rawRequest('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(JSON.parse(res.body).error.code, 'NOT_FOUND');
});

test('wrong method returns 405 with Allow header', async () => {
  const res = await rawRequest('/api/health', 'POST');
  assert.equal(res.status, 405);
  assert.equal(JSON.parse(res.body).error.code, 'METHOD_NOT_ALLOWED');
  assert.match(res.headers.allow, /GET/);
});

test('project files outside web/ are never served', async () => {
  const root = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

  for (const pathname of ['/package.json', '/../../package.json', '/%2e%2e/%2e%2e/package.json']) {
    const res = await rawRequest(pathname);
    assert.notEqual(res.status, 200);
    assert.ok(!res.body.includes(`"name": "${root.name}"`), `leaked package.json via ${pathname}`);
  }
});

test('unknown method on static path returns 405', async () => {
  const res = await rawRequest('/index.html', 'POST');
  assert.equal(res.status, 405);
  assert.match(res.headers.allow, /GET/);
});

test('api routes are listed', async () => {
  const res = await rawRequest('/api/routes');
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.ok(payload.routes.includes('GET /api/health'));
  assert.ok(payload.routes.includes('GET /api/config'));
});

test('security headers allow mod icons and skin data URLs only (CSP img-src)', async () => {
  const res = await rawRequest('/index.html');
  const csp = res.headers['content-security-policy'];
  assert.ok(csp, 'every response carries a Content-Security-Policy');
  assert.match(csp, /img-src[^;]*data:/, 'สกิน preview มาเป็น data URL จาก cache บนเครื่อง');
  assert.match(csp, /img-src[^;]*https:\/\/cdn\.modrinth\.com/, 'ไอคอน mod จาก Modrinth CDN');
  // รูปสกินไม่ได้โหลดจาก host ภายนอกอีกแล้ว → ไม่ต้องเปิด host นี้ใน CSP
  assert.doesNotMatch(csp, /textures\.minecraft\.net/);
});
