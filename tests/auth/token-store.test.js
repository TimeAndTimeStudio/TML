// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTokenStore, SESSION_FILE_NAME } from '../../src/auth/token-store.js';

const SESSION = Object.freeze({
  type: 'msa',
  userType: 'msa',
  uuid: '11111111-2222-3333-4444-555555555555',
  username: 'Steve',
  accessToken: 'mc-access-token-secret',
  refreshToken: 'msa-refresh-token-secret',
  expiresAt: Date.now() + 3_600_000,
  xuid: '1234567890',
});

let root;
let file;
let store;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-token-store-'));
  file = path.join(root, SESSION_FILE_NAME);
  store = createTokenStore({ file });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('createTokenStore validates its configuration', () => {
  assert.throws(() => createTokenStore({}), (err) => err.code === 'INVALID_TOKEN_STORE');
  assert.throws(() => createTokenStore({ file: '' }), (err) => err.code === 'INVALID_TOKEN_STORE');
});

test('save persists the session with 0600 permissions', async () => {
  const saved = await store.save(SESSION);

  assert.equal(saved.signedIn, true);
  assert.equal(saved.username, 'Steve');
  assert.equal('accessToken' in saved, false, 'public session must never expose the access token');
  assert.equal('refreshToken' in saved, false, 'public session must never expose the refresh token');

  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `session file must be 0600, got ${mode.toString(8)}`);

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.accessToken, 'mc-access-token-secret');
  assert.equal(raw.refreshToken, 'msa-refresh-token-secret');
  assert.equal(raw.username, 'Steve');
});

test('read returns the stored session and caches it', async () => {
  const fresh = createTokenStore({ file });
  const first = await fresh.read();
  assert.equal(first.username, 'Steve');
  assert.equal(first.accessToken, 'mc-access-token-secret');

  const second = await fresh.read();
  assert.equal(second, first, 'subsequent reads should use the in-memory cache');
});

test('save rejects sessions that are missing required fields', async () => {
  await assert.rejects(store.save({ username: 'NoUuid' }), (err) => err.code === 'INVALID_TOKEN_STORE');
  await assert.rejects(store.save({ uuid: 'x' }), (err) => err.code === 'INVALID_TOKEN_STORE');
  await assert.rejects(store.save(null), (err) => err.code === 'INVALID_TOKEN_STORE');
});

test('a corrupt session file is removed instead of crashing', async () => {
  fs.writeFileSync(file, '{not json', { mode: 0o600 });
  const fresh = createTokenStore({ file });
  assert.equal(await fresh.read(), null);
  assert.equal(fs.existsSync(file), false, 'the corrupt file must be deleted');
});

test('a session file with an invalid shape is removed', async () => {
  fs.writeFileSync(file, JSON.stringify({ hello: 'world' }), { mode: 0o600 });
  const fresh = createTokenStore({ file });
  assert.equal(await fresh.read(), null);
  assert.equal(fs.existsSync(file), false);
});

test('clear removes the stored session', async () => {
  await store.save(SESSION);
  assert.equal(fs.existsSync(file), true);

  await store.clear();
  assert.equal(fs.existsSync(file), false);
  assert.equal(await store.read(), null);
  assert.equal(store.publicSession(null), null);
});

test('an expired session is signed out automatically on the cached path', async () => {
  await store.save({ ...SESSION, expiresAt: Date.now() - 1000 });
  assert.equal(await store.read(), null, 'an expired session must not be returned');
  assert.equal(fs.existsSync(file), false, 'the expired session file must be removed');
});

test('an expired session file is removed on first read', async () => {
  fs.writeFileSync(file, JSON.stringify({ ...SESSION, expiresAt: Date.now() - 1000 }, null, 2), { mode: 0o600 });
  const fresh = createTokenStore({ file });
  assert.equal(await fresh.read(), null);
  assert.equal(fs.existsSync(file), false, 'the expired session file must be removed');
});
