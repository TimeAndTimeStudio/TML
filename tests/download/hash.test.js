// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createHasher,
  hashBuffer,
  hashFile,
  normalizeHash,
  verifyBuffer,
  verifyFile,
  verifyHashes,
} from '../../src/download/hash.js';
import { ChecksumMismatchError, ValidationError } from '../../src/core/errors.js';

const SHA1_ABC = 'a9993e364706816aba3e25717850c26c9cd0d89d';
const SHA512_EMPTY =
  'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tml-hash-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('hashBuffer computes sha1 and sha512 in one call', () => {
  assert.deepEqual(hashBuffer('abc', ['sha1']), { sha1: SHA1_ABC });
  assert.equal(hashBuffer('abc').sha1, SHA1_ABC);
  assert.equal(hashBuffer('', ['sha512']).sha512, SHA512_EMPTY);

  const both = hashBuffer('abc', ['sha1', 'sha512']);
  assert.equal(both.sha1, SHA1_ABC);
  assert.equal(both.sha512.length, 128);
});

test('hashFile matches hashBuffer for large content', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'blob.bin');
    const data = Buffer.alloc(300 * 1024, 0x5a);
    fs.writeFileSync(file, data);

    const fromFile = await hashFile(file, ['sha1', 'sha512']);
    const fromBuffer = hashBuffer(data, ['sha1', 'sha512']);
    assert.deepEqual(fromFile, fromBuffer);

    await assert.rejects(() => hashFile(path.join(dir, 'missing.bin')), (err) => err.code === 'ENOENT');
  } finally {
    cleanup(dir);
  }
});

test('normalizeHash accepts case-insensitive hex and rejects bad values', () => {
  assert.equal(normalizeHash(SHA1_ABC.toUpperCase(), 'sha1'), SHA1_ABC);
  assert.equal(normalizeHash(` ${SHA1_ABC} `), SHA1_ABC);

  assert.throws(() => normalizeHash('nope', 'sha1'), (err) => err instanceof ValidationError && err.code === 'INVALID_HASH');
  assert.throws(() => normalizeHash('a'.repeat(39), 'sha1'), (err) => err.code === 'INVALID_HASH');
  assert.throws(() => normalizeHash('a'.repeat(40), 'sha512'), (err) => err.code === 'INVALID_HASH');
  assert.throws(() => normalizeHash('a'.repeat(40), 'md5'), (err) => err.code === 'UNSUPPORTED_HASH_ALGORITHM');
});

test('verifyBuffer and verifyFile detect mismatches', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'client.jar');
    fs.writeFileSync(file, 'client-bytes');

    const ok = verifyBuffer('client-bytes', { sha1: hashBuffer('client-bytes').sha1 });
    assert.equal(ok.ok, true);

    assert.throws(
      () => verifyBuffer('client-bytes', { sha1: SHA1_ABC }),
      (err) =>
        err instanceof ChecksumMismatchError &&
        err.code === 'CHECKSUM_MISMATCH' &&
        err.mismatches.length === 1 &&
        err.mismatches[0].algorithm === 'sha1'
    );

    await verifyFile(file, { sha1: hashBuffer('client-bytes').sha1 });
    await assert.rejects(
      () => verifyFile(file, { sha1: SHA1_ABC }),
      (err) => err instanceof ChecksumMismatchError && err.details.file === file
    );
  } finally {
    cleanup(dir);
  }
});

test('verification without expectations is a no-op', () => {
  assert.deepEqual(verifyBuffer('anything', {}), { ok: true, checked: [], hashes: {} });
  assert.deepEqual(verifyHashes({ sha1: SHA1_ABC }, { sha1: null }), {
    ok: true,
    checked: [],
    hashes: {},
  });
});

test('createHasher cannot be reused after digest', () => {
  const hasher = createHasher(['sha1']);
  hasher.update('abc');
  assert.equal(hasher.digest().sha1, SHA1_ABC);
  assert.throws(() => hasher.update('more'), (err) => err.code === 'HASHER_FINALIZED');
  assert.throws(() => hasher.digest(), (err) => err.code === 'HASHER_FINALIZED');
});
