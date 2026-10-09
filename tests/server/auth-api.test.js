// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, DEFAULT_MSA_CLIENT_ID } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { AuthError } from '../../src/core/errors.js';
import { createApiRouter } from '../../src/server/routes.js';
import { createTmlServer } from '../../src/server/server.js';
import { createTokenStore, SESSION_FILE_NAME } from '../../src/auth/token-store.js';
import { createAuthProvider } from '../../src/auth/provider.js';

const OWN_CLIENT_ID = '11111111-2222-3333-4444-555555555555';

const FRESH_SESSION = Object.freeze({
  type: 'msa',
  userType: 'msa',
  uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  username: 'Alex',
  accessToken: 'mc-token-secret',
  refreshToken: 'refresh-token-secret',
  expiresAt: Date.now() + 3_600_000,
  xuid: '42424242',
});

function createFakeAuth() {
  const state = {
    completeCalls: [],
    declineNext: false,
  };
  return {
    state,
    async startDeviceLogin() {
      return {
        deviceCode: `dev-${state.completeCalls.length}-${Date.now()}`,
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://microsoft.com/link',
        verificationUriComplete: null,
        interval: 5,
        expiresIn: 900,
        expiresAt: Date.now() + 900_000,
        message: 'Enter ABCD-EFGH',
      };
    },
    async completeDeviceLogin(start) {
      state.completeCalls.push(start.deviceCode);
      if (state.declineNext) {
        state.declineNext = false;
        throw new AuthError('declined', { code: 'AUTH_DECLINED', status: 400, details: { stage: 'device' } });
      }
      return { ...FRESH_SESSION };
    },
  };
}

function createStubManager() {
  const meta = Object.freeze({
    id: 'stub1',
    name: 'Stub',
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    fabricLoaderVersion: '0.15.7',
    java: 'minecraft-bundled',
    memory: { min: '512M', max: '4096M' },
  });
  const calls = { launch: [] };
  return {
    meta,
    calls,
    async list() {
      return [meta];
    },
    async get(id) {
      if (id !== meta.id) {
        const err = new Error(`not found: ${id}`);
        err.code = 'INSTANCE_NOT_FOUND';
        err.status = 404;
        throw err;
      }
      return meta;
    },
    status(id) {
      return { id, running: false, pid: null };
    },
    async launch(id, opts = {}) {
      calls.launch.push({ id, opts });
      return { id, pid: 4242, version: meta.minecraftVersion, source: 'fabric' };
    },
    async stop(id) {
      return { id, stopped: true, code: 0, signal: null };
    },
  };
}

let server;
let port;
let dataDir;
let sessionFile;
let auth;
let manager;
let skin;

function createFakeSkin() {
  const state = { uploads: [], resets: [], actives: [], textures: [], profile: null };
  return {
    state,
    async upload(args) {
      state.uploads.push(args);
      return { changed: true, variant: args.variant };
    },
    async reset(args) {
      state.resets.push(args);
      return { changed: true };
    },
    async active(args) {
      state.actives.push(args);
      if (state.profile) return state.profile;
      return {
        username: 'Alex',
        skins: [{ url: 'https://textures.minecraft.net/texture/active-skin', alias: 'DEFAULT', state: 'ACTIVE' }],
      };
    },
    async texture(args) {
      state.textures.push(args);
      if (state.textureResult) return state.textureResult;
      return { hash: args.hash ?? 'cached', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), source: 'exact' };
    },
  };
}

function request(pathname, { method = 'GET', body = null, to = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port: to ?? port,
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
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-auth-api-'));
  const config = loadConfig({ env: { TML_DATA_DIR: dataDir, TML_PORT: '0', TML_LOG_LEVEL: 'silent' } });
  const logger = createLogger({ level: 'silent' });
  sessionFile = path.join(dataDir, SESSION_FILE_NAME);

  const fake = createFakeAuth();
  auth = createAuthProvider({
    clientId: config.auth.clientId,
    source: config.auth.source,
    factory: () => fake,
    logger,
  });
  auth.state = fake.state;
  const account = createTokenStore({ file: sessionFile, logger });
  manager = createStubManager();

  skin = createFakeSkin();
  const router = createApiRouter({
    config,
    logger,
    instance: { manager },
    auth,
    account,
    skin,
  });
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

test('auth API requires both an auth client and a token store', () => {
  const config = loadConfig({ env: { TML_DATA_DIR: dataDir, TML_PORT: '0', TML_LOG_LEVEL: 'silent' } });
  const logger = createLogger({ level: 'silent' });
  assert.throws(
    () => createApiRouter({ config, logger, auth }),
    (err) => err.code === 'INVALID_AUTH_CONFIG',
  );
  assert.throws(
    () => createApiRouter({ config, logger, account: createTokenStore({ file: sessionFile }) }),
    (err) => err.code === 'INVALID_AUTH_CONFIG',
  );
});

test('sign-in is configured out of the box with the built-in default app', async () => {
  const view = await request('/api/config');
  assert.equal(view.status, 200);
  assert.deepEqual(view.json.auth, { configured: true, source: 'default', offlineName: null });
  assert.equal(view.text.includes(DEFAULT_MSA_CLIENT_ID), false, 'public config must not leak the client id');

  const started = await request('/api/auth/device', { method: 'POST', body: {} });
  assert.equal(started.status, 200, 'device sign-in works without saving any client id first');
  assert.equal(typeof started.json.deviceCode, 'string');
});

test('POST /api/auth/client no longer exists', async () => {
  const res = await request('/api/auth/client', { method: 'POST', body: { clientId: OWN_CLIENT_ID } });
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'NOT_FOUND');
});

test('device login flow: start, complete and store the session without leaking secrets', async () => {
  const started = await request('/api/auth/device', { method: 'POST', body: {} });
  assert.equal(started.status, 200);
  assert.equal(typeof started.json.deviceCode, 'string');
  assert.equal(started.json.userCode, 'ABCD-EFGH');
  assert.equal(started.json.verificationUri, 'https://microsoft.com/link');
  assert.equal(started.text.includes('mc-token-secret'), false);

  const completed = await request('/api/auth/login', {
    method: 'POST',
    body: { deviceCode: started.json.deviceCode },
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.json.session.signedIn, true);
  assert.equal(completed.json.session.username, 'Alex');
  assert.equal(completed.text.includes('mc-token-secret'), false, 'responses must never expose the access token');
  assert.equal(completed.text.includes('refresh-token-secret'), false);

  const stored = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(stored.accessToken, 'mc-token-secret');

  const session = await request('/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.json.signedIn, true);
  assert.equal(session.json.username, 'Alex');
  assert.equal(session.json.clientConfigured, true);
  assert.equal(session.text.includes('mc-token-secret'), false);
});

test('login rejects unknown and invalid device codes', async () => {
  const unknown = await request('/api/auth/login', { method: 'POST', body: { deviceCode: 'never-issued' } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'AUTH_DEVICE_UNKNOWN');

  const missing = await request('/api/auth/login', { method: 'POST', body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'VALIDATION_ERROR');
});

test('a declined sign-in is reported and the device code is invalidated', async () => {
  const started = await request('/api/auth/device', { method: 'POST', body: {} });
  auth.state.declineNext = true;

  const declined = await request('/api/auth/login', {
    method: 'POST',
    body: { deviceCode: started.json.deviceCode },
  });
  assert.equal(declined.status, 400);
  assert.equal(declined.json.error.code, 'AUTH_DECLINED');

  const retry = await request('/api/auth/login', {
    method: 'POST',
    body: { deviceCode: started.json.deviceCode },
  });
  assert.equal(retry.status, 404, 'a declined device code must not stay usable');
  assert.equal(retry.json.error.code, 'AUTH_DEVICE_UNKNOWN');
});

test('an expired session is signed out automatically', async () => {
  await request('/api/auth/session', { method: 'DELETE' });
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({ ...FRESH_SESSION, accessToken: 'old-token', expiresAt: Date.now() - 1000 }, null, 2),
    { mode: 0o600 },
  );

  const probe = await request('/api/auth/session');
  assert.equal(probe.status, 200);
  assert.equal(probe.json.signedIn, false, 'an expired session must not be reported as signed in');
  assert.equal(fs.existsSync(sessionFile), false, 'the expired session file must be removed');

  const still = await request('/api/auth/session');
  assert.equal(still.json.signedIn, false);
});

test('logout clears the stored session', async () => {
  await request('/api/auth/session', { method: 'DELETE' });
  fs.writeFileSync(sessionFile, JSON.stringify({ ...FRESH_SESSION }, null, 2), { mode: 0o600 });

  const signedIn = await request('/api/auth/session');
  assert.equal(signedIn.json.signedIn, true);

  const out = await request('/api/auth/session', { method: 'DELETE' });
  assert.equal(out.status, 200);
  assert.equal(out.json.signedIn, false);
  assert.equal(fs.existsSync(sessionFile), false);

  const after = await request('/api/auth/session');
  assert.equal(after.json.signedIn, false);
});

test('launch injects the stored account session into the manager', async () => {
  manager.calls.launch.length = 0;
  await request('/api/auth/session', { method: 'DELETE' });
  fs.writeFileSync(sessionFile, JSON.stringify({ ...FRESH_SESSION, expiresAt: Date.now() + 3_600_000 }, null, 2), {
    mode: 0o600,
  });

  const launched = await request('/api/instances/stub1/launch', { method: 'POST', body: {} });
  assert.equal(launched.status, 202);
  assert.equal(manager.calls.launch.length, 1);
  const { id, opts } = manager.calls.launch[0];
  assert.equal(id, 'stub1');
  assert.equal(opts.auth.username, 'Alex');
  assert.equal(opts.auth.uuid, FRESH_SESSION.uuid);
  assert.equal(opts.auth.accessToken, 'mc-token-secret');
});

test('launch with an expired session signs out and stays offline-compatible', async () => {
  manager.calls.launch.length = 0;
  await request('/api/auth/session', { method: 'DELETE' });
  fs.writeFileSync(sessionFile, JSON.stringify({ ...FRESH_SESSION, expiresAt: Date.now() - 1000 }, null, 2), {
    mode: 0o600,
  });

  const launched = await request('/api/instances/stub1/launch', { method: 'POST', body: {} });
  assert.equal(launched.status, 202);
  assert.equal(manager.calls.launch[0].opts.auth, undefined, 'an expired session must not be injected');
  assert.equal(fs.existsSync(sessionFile), false, 'the expired session must be cleared');
});

test('launch without a stored session stays offline-compatible', async () => {
  manager.calls.launch.length = 0;
  await request('/api/auth/session', { method: 'DELETE' });
  if (fs.existsSync(sessionFile)) fs.rmSync(sessionFile);

  const launched = await request('/api/instances/stub1/launch', { method: 'POST', body: {} });
  assert.equal(launched.status, 202);
  const { opts } = manager.calls.launch[0];
  assert.equal(opts.auth, undefined, 'no session means no auth injection');
});

test('launch prefers the Microsoft session but falls back to the configured offline name', async () => {
  manager.calls.launch.length = 0;
  await request('/api/auth/session', { method: 'DELETE' });
  if (fs.existsSync(sessionFile)) fs.rmSync(sessionFile);

  const patched = await request('/api/config', {
    method: 'PATCH',
    body: { auth: { offlineName: 'Offline_Steve' } },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.config.auth.offlineName, 'Offline_Steve');

  const offline = await request('/api/instances/stub1/launch', { method: 'POST', body: {} });
  assert.equal(offline.status, 202);
  assert.equal(manager.calls.launch[0].opts.auth.username, 'Offline_Steve', 'signed out → configured offline name');

  fs.writeFileSync(sessionFile, JSON.stringify(FRESH_SESSION, null, 2), { mode: 0o600 });
  const online = await request('/api/instances/stub1/launch', { method: 'POST', body: {} });
  assert.equal(online.status, 202);
  assert.equal(manager.calls.launch[1].opts.auth.username, 'Alex', 'signed in → the Microsoft session wins');

  const cleared = await request('/api/config', {
    method: 'PATCH',
    body: { auth: { offlineName: null } },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.config.auth.offlineName, null);
});

test('skin change requires a session, forwards the token and validates input', async () => {
  skin.state.uploads.length = 0;
  await request('/api/auth/session', { method: 'DELETE' });
  if (fs.existsSync(sessionFile)) fs.rmSync(sessionFile);

  const signedOut = await request('/api/minecraft/skin', {
    method: 'POST',
    body: { data: 'AAAA', variant: 'classic' },
  });
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.json.error.code, 'AUTH_NO_SESSION');
  assert.equal(skin.state.uploads.length, 0);

  const missingData = await request('/api/minecraft/skin', { method: 'POST', body: {} });
  assert.equal(missingData.status, 400);
  assert.equal(missingData.json.error.code, 'INVALID_SKIN');

  fs.writeFileSync(sessionFile, JSON.stringify({ ...FRESH_SESSION }, null, 2), { mode: 0o600 });
  const ok = await request('/api/minecraft/skin', {
    method: 'POST',
    body: { data: Buffer.from('png-bytes').toString('base64'), variant: 'slim' },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { changed: true, variant: 'slim' });
  assert.equal(skin.state.uploads.length, 1);
  assert.equal(skin.state.uploads[0].token, 'mc-token-secret', 'the stored access token is forwarded');
  assert.equal(skin.state.uploads[0].variant, 'slim');
  assert.deepEqual(skin.state.uploads[0].data, Buffer.from('png-bytes'));
  assert.equal(ok.text.includes('mc-token-secret'), false, 'the token never leaves the server');
});

test('skin change with an expired session requires signing in again', async () => {
  skin.state.uploads.length = 0;
  await request('/api/auth/session', { method: 'DELETE' });
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({ ...FRESH_SESSION, expiresAt: Date.now() - 1000 }, null, 2),
    { mode: 0o600 },
  );

  const res = await request('/api/minecraft/skin', {
    method: 'POST',
    body: { data: Buffer.from('png-bytes').toString('base64') },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'AUTH_NO_SESSION');
  assert.equal(skin.state.uploads.length, 0);
  assert.equal(fs.existsSync(sessionFile), false, 'the expired session must be cleared');

  await request('/api/auth/session', { method: 'DELETE' });
});

test('skin reset calls the Minecraft Services reset endpoint', async () => {
  skin.state.resets.length = 0;
  await request('/api/auth/session', { method: 'DELETE' });
  fs.writeFileSync(sessionFile, JSON.stringify({ ...FRESH_SESSION }, null, 2), { mode: 0o600 });

  const res = await request('/api/minecraft/skin', { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { changed: true });
  assert.equal(skin.state.resets.length, 1);
  assert.equal(skin.state.resets[0].token, 'mc-token-secret');

  await request('/api/auth/session', { method: 'DELETE' });
});

test('GET active skin requires a session and returns the skin in use', async () => {
  skin.state.actives.length = 0;
  await request('/api/auth/session', { method: 'DELETE' });
  if (fs.existsSync(sessionFile)) fs.rmSync(sessionFile);

  const signedOut = await request('/api/minecraft/skin');
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.json.error.code, 'AUTH_NO_SESSION');
  assert.equal(skin.state.actives.length, 0);

  fs.writeFileSync(sessionFile, JSON.stringify({ ...FRESH_SESSION }, null, 2), { mode: 0o600 });
  const ok = await request('/api/minecraft/skin');
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.username, 'Alex');
  assert.equal(ok.json.skins[0].url, 'https://textures.minecraft.net/texture/active-skin');
  assert.equal(ok.json.skins[0].state, 'ACTIVE');
  assert.equal(skin.state.actives.length, 1);
  assert.equal(skin.state.actives[0].token, 'mc-token-secret', 'the stored access token is forwarded');
  assert.equal(ok.text.includes('mc-token-secret'), false, 'the token never leaves the server');

  // ยังไม่เคยเปลี่ยน skin → คืนรายการเปล่า ( UI แสดง default skin )
  skin.state.profile = { username: 'Alex', skins: [] };
  const empty = await request('/api/minecraft/skin');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.skins, []);
  skin.state.profile = null;

  await request('/api/auth/session', { method: 'DELETE' });
});

test('GET skin image serves the local cache as a data URL without hitting the network', async () => {
  skin.state.textures.length = 0;
  skin.state.profile = null;
  await request('/api/auth/session', { method: 'DELETE' });
  if (fs.existsSync(sessionFile)) fs.rmSync(sessionFile);

  const hash = 'c'.repeat(64);

  // hash ผิดรูป → 400 (validate ที่ route ก่อน ไม่แตะ service)
  const badHash = await request('/api/minecraft/skin/image?hash=..%2Fetc%2Fpasswd');
  assert.equal(badHash.status, 400);
  assert.equal(badHash.json.error.code, 'INVALID_SKIN_HASH');
  assert.equal(skin.state.textures.length, 0);

  // ยังไม่ sign in → 401
  const signedOut = await request(`/api/minecraft/skin/image?hash=${hash}`);
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.json.error.code, 'AUTH_NO_SESSION');
  assert.equal(skin.state.textures.length, 0);

  fs.writeFileSync(sessionFile, JSON.stringify({ ...FRESH_SESSION }, null, 2), { mode: 0o600 });
  const ok = await request(`/api/minecraft/skin/image?hash=${hash}`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.hash, hash);
  assert.equal(ok.json.source, 'exact');
  assert.match(ok.json.dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(skin.state.textures, [{ hash }], 'the requested hash is forwarded to the local cache reader');
  assert.equal(ok.text.includes('mc-token-secret'), false, 'the token never leaves the server');

  await request('/api/auth/session', { method: 'DELETE' });
});

