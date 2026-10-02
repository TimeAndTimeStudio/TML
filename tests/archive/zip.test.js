// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ZIP_METHOD_DEFLATE,
  ZIP_METHOD_STORE,
  validateZipEntryName,
  writeZipFile,
} from '../../src/archive/zip.js';
import { ZIP_LIMITS, extractZip, listZipEntries, readZipEntry } from '../../src/archive/unzip.js';
import { CancelledError, ValidationError } from '../../src/core/errors.js';

let root;
let counter = 0;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-zip-'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function nextOutput() {
  return path.join(root, `archive-${counter++}.zip`);
}

test('writeZipFile round-trips data, file and directory entries through our reader', async () => {
  const srcFile = path.join(root, 'payload.bin');
  const payload = Buffer.from('file payload '.repeat(50));
  fs.writeFileSync(srcFile, payload);

  const dest = nextOutput();
  const list = [
    { name: 'readme.txt', data: 'hello hello hello '.repeat(20) },
    { name: 'dir/', dir: true },
    { name: 'dir/nested.txt', data: 'nested' },
    { name: 'bin/store.bin', data: Buffer.alloc(64, 7), method: 'store' },
    { name: 'from-file.bin', file: srcFile },
  ];
  const result = await writeZipFile(list, dest);

  assert.ok(Object.isFrozen(result));
  assert.equal(result.count, 5);
  assert.equal(result.path, dest);
  assert.equal(result.bytes, fs.statSync(dest).size);
  assert.ok(result.bytes > 0);
  assert.equal(fs.existsSync(`${dest}.part`), false, 'the temporary file must be renamed away');
  assert.equal(result.entries.length, 5);
  assert.ok(Object.isFrozen(result.entries[0]));
  assert.equal(result.entries[0].method, ZIP_METHOD_DEFLATE, 'repetitive text must deflate');
  assert.equal(result.entries[3].method, ZIP_METHOD_STORE, 'explicit store must be honoured');

  const entries = await listZipEntries(dest);
  assert.deepEqual(entries.map((entry) => entry.name), list.map((entry) => entry.name));
  assert.equal(entries.find((entry) => entry.name === 'dir/').isDirectory, true);
  assert.equal(entries.find((entry) => entry.name === 'dir/nested.txt').isDirectory, false);

  assert.equal((await readZipEntry(dest, entries[0])).toString(), 'hello hello hello '.repeat(20));
  assert.deepEqual(await readZipEntry(dest, entries[3]), Buffer.alloc(64, 7));
  assert.equal((await readZipEntry(dest, entries[4])).equals(payload), true, 'crc + sizes of file entries must verify');
  assert.equal((entries.find((entry) => entry.name === 'from-file.bin').mode & 0o100000) !== 0, true);

  const extractDir = path.join(root, 'extracted');
  await extractZip(dest, extractDir);
  assert.equal(fs.readFileSync(path.join(extractDir, 'dir', 'nested.txt'), 'utf8'), 'nested');
  assert.equal(fs.readFileSync(path.join(extractDir, 'from-file.bin')).equals(payload), true);
});

test('incompressible data falls back to store so archives never grow', async () => {
  const dest = nextOutput();
  const random = crypto.randomBytes(8192);
  const result = await writeZipFile([{ name: 'random.bin', data: random }], dest);

  assert.equal(result.entries[0].method, ZIP_METHOD_STORE);
  assert.equal(result.entries[0].compressedSize, random.length);

  const entries = await listZipEntries(dest);
  assert.equal(entries[0].method, ZIP_METHOD_STORE);
  assert.equal((await readZipEntry(dest, entries[0])).equals(random), true);
});

test('entry names are validated before anything touches disk', async () => {
  const dest = nextOutput();
  const invalid = [
    { entry: { name: '' }, code: 'ZIP_INVALID_ENTRY_NAME' },
    { entry: { name: '/abs.txt' }, code: 'ZIP_INVALID_ENTRY_NAME' },
    { entry: { name: 'a\\b.txt' }, code: 'ZIP_INVALID_ENTRY_NAME' },
    { entry: { name: '../escape.txt' }, code: 'ZIP_INVALID_ENTRY_NAME' },
    { entry: { name: 'a/../b.txt' }, code: 'ZIP_INVALID_ENTRY_NAME' },
    { entry: { name: './here.txt' }, code: 'ZIP_INVALID_ENTRY_NAME' },
    { entry: { name: 'C:/drive.txt' }, code: 'ZIP_INVALID_ENTRY_NAME' },
    { entry: { name: 'bad\x00name.txt' }, code: 'ZIP_INVALID_ENTRY_NAME' },
    { entry: { name: 'dir', dir: true }, code: 'ZIP_INVALID_ENTRY_NAME' },
    { entry: { name: 'file.txt/' }, code: 'ZIP_INVALID_ENTRY_NAME' },
    { entry: { name: 'a//b.txt' }, code: 'ZIP_INVALID_ENTRY_NAME' },
    { entry: { name: 'x'.repeat(ZIP_LIMITS.maxNameLength + 1) }, code: 'ZIP_LIMIT_EXCEEDED' },
  ];

  for (const { entry, code } of invalid) {
    const input = entry.dir ? entry : { ...entry, data: 'x' };
    await assert.rejects(writeZipFile([input], dest), (err) => err instanceof ValidationError && err.code === code, `expected ${code} for ${JSON.stringify(entry.name)}`);
  }

  assert.equal(fs.existsSync(dest), false, 'invalid input must fail before the archive is created');
  assert.equal(fs.existsSync(`${dest}.part`), false);

  assert.equal(validateZipEntryName('a/b.txt'), 'a/b.txt');
  assert.equal(validateZipEntryName('dir/', { dir: true }), 'dir/');
  assert.equal(validateZipEntryName('ünïcode ✓.txt'), 'ünïcode ✓.txt');
});

test('invalid entry shapes are rejected before writing', async () => {
  const dest = nextOutput();
  const src = path.join(root, 'exists.txt');
  fs.writeFileSync(src, 'ok');

  await assert.rejects(writeZipFile('nope', dest), { code: 'ZIP_INVALID_ENTRIES' });
  await assert.rejects(writeZipFile([{ name: 'a.txt', data: 'one' }, { name: 'a.txt', data: 'dup' }], dest), { code: 'ZIP_DUPLICATE_ENTRY' });
  await assert.rejects(writeZipFile([{ name: 'x', data: 'a', file: src }], dest), (err) => err.code === 'ZIP_INVALID_ENTRY');
  await assert.rejects(writeZipFile([{ name: 'x' }], dest), (err) => err.code === 'ZIP_INVALID_ENTRY');
  await assert.rejects(writeZipFile([{ name: 'x', data: 'a', method: 'brotli' }], dest), (err) => err.code === 'ZIP_INVALID_METHOD');
  await assert.rejects(writeZipFile([{ name: 'd/', dir: true, data: 'nope' }], dest), (err) => err.code === 'ZIP_INVALID_ENTRY');
  await assert.rejects(writeZipFile([{ name: 'x', data: 42 }], dest), (err) => err.code === 'ZIP_INVALID_ENTRY');
  await assert.rejects(writeZipFile([], dest), (err) => err.code === 'ZIP_EMPTY_ARCHIVE');
  await assert.rejects(writeZipFile([{ name: 'x', data: 'a' }], ''), { code: 'INVALID_ZIP_PATH' });

  assert.equal(fs.existsSync(dest), false);
});

test('writer limits mirror the reader limits', async () => {
  const dest = nextOutput();
  await assert.rejects(
    writeZipFile([{ name: 'a', data: 'a' }, { name: 'b', data: 'b' }, { name: 'c', data: 'c' }], dest, { limits: { maxEntries: 2 } }),
    (err) => err.code === 'ZIP_LIMIT_EXCEEDED' && err.details.limit === 2,
  );
  await assert.rejects(
    writeZipFile([{ name: 'big', data: '12345' }], dest, { limits: { maxEntryBytes: 4 } }),
    (err) => err.code === 'ZIP_LIMIT_EXCEEDED' && err.details.limit === 4,
  );
  assert.equal(fs.existsSync(dest), false);
});

test('failures and cancellation leave no partial archive behind', async () => {
  const missing = nextOutput();
  const dest = path.join(root, 'failure.zip');
  await assert.rejects(writeZipFile([{ name: 'x.bin', file: missing }], dest), { code: 'ENOENT' });
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.part`), false);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    writeZipFile([{ name: 'x.txt', data: 'x' }], dest, { signal: controller.signal }),
    (err) => err instanceof CancelledError,
  );
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.part`), false);
});

test('writing to the same path replaces the previous archive', async () => {
  const dest = path.join(root, 'replace.zip');
  await writeZipFile([{ name: 'old.txt', data: 'old' }], dest);
  const first = await listZipEntries(dest);
  assert.deepEqual(first.map((entry) => entry.name), ['old.txt']);

  await writeZipFile([{ name: 'new.txt', data: 'new' }], dest);
  const second = await listZipEntries(dest);
  assert.deepEqual(second.map((entry) => entry.name), ['new.txt']);
  assert.equal((await readZipEntry(dest, second[0])).toString(), 'new');
  assert.equal(fs.existsSync(`${dest}.part`), false);
});
