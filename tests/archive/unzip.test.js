// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CancelledError, CorruptDataError, ValidationError } from '../../src/core/errors.js';
import { crc32, extractZip, listZipEntries, readZipEntry, ZIP_LIMITS } from '../../src/archive/unzip.js';
import { buildZip } from '../helpers/zip.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tml-unzip-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function writeZip(dir, name, entries) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, buildZip(entries));
  return file;
}

const NATIVES_ENTRIES = [
  { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\n' },
  { name: 'linux/x64/org/lwjgl/liblwjgl.so', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]), method: 'deflate' },
  { name: 'license.txt', data: 'LWJGL license', method: 'deflate' },
];

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('listZipEntries reports names, methods and sizes', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(dir, 'a.zip', [
      { name: 'stored.bin', data: 'hello' },
      { name: 'packed.bin', data: 'x'.repeat(4096), method: 'deflate' },
      { name: 'nested/dir/', data: '' },
    ]);

    const entries = await listZipEntries(file);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['stored.bin', 'packed.bin', 'nested/dir/'],
    );
    const stored = entries.find((entry) => entry.name === 'stored.bin');
    const packed = entries.find((entry) => entry.name === 'packed.bin');
    assert.equal(stored.method, 0);
    assert.equal(stored.uncompressedSize, 5);
    assert.equal(packed.method, 8);
    assert.equal(packed.uncompressedSize, 4096);
    assert.equal(entries.find((entry) => entry.name === 'nested/dir/').isDirectory, true);
  } finally {
    cleanup(dir);
  }
});

test('readZipEntry returns the original bytes', async () => {
  const dir = tmpDir();
  try {
    const payload = Buffer.from('the quick brown fox');
    const file = await writeZip(dir, 'b.zip', [
      { name: 'raw.txt', data: payload },
      { name: 'zip.txt', data: payload, method: 'deflate' },
    ]);

    const entries = await listZipEntries(file);
    for (const entry of entries) {
      assert.deepEqual(await readZipEntry(file, entry), payload);
    }
  } finally {
    cleanup(dir);
  }
});

test('extractZip writes nested files and skips directories', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(dir, 'c.zip', NATIVES_ENTRIES);
    const dest = path.join(dir, 'out');
    const result = await extractZip(file, dest);

    assert.equal(result.count, 3);
    assert.equal(fs.readFileSync(path.join(dest, 'license.txt'), 'utf8'), 'LWJGL license');
    assert.equal(fs.readFileSync(path.join(dest, 'linux/x64/org/lwjgl/liblwjgl.so')).length, 7);
    assert.ok(!fs.existsSync(path.join(dest, 'nested')));
    const mode = fs.statSync(path.join(dest, 'linux/x64/org/lwjgl/liblwjgl.so')).mode & 0o777;
    assert.equal(mode, 0o755);
  } finally {
    cleanup(dir);
  }
});

test('extractZip honors exclude prefixes', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(dir, 'd.zip', NATIVES_ENTRIES);
    const dest = path.join(dir, 'out');
    const result = await extractZip(file, dest, { exclude: ['META-INF/'] });

    assert.equal(result.count, 2);
    assert.ok(!fs.existsSync(path.join(dest, 'META-INF')));
    assert.equal(fs.existsSync(path.join(dest, 'license.txt')), true);
  } finally {
    cleanup(dir);
  }
});

test('extractZip keeps only matching entries when include is set', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(dir, 'e.zip', NATIVES_ENTRIES);
    const dest = path.join(dir, 'out');
    const seen = [];
    const result = await extractZip(file, dest, {
      include: ['linux/'],
      onEntry: (entry) => seen.push(entry.name),
    });

    assert.equal(result.count, 1);
    assert.deepEqual(seen, ['linux/x64/org/lwjgl/liblwjgl.so']);
    assert.ok(!fs.existsSync(path.join(dest, 'license.txt')));
  } finally {
    cleanup(dir);
  }
});

test('extractZip rejects zip slip path traversal', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(dir, 'evil.zip', [
      { name: '../evil.txt', data: 'pwned' },
      { name: 'ok.txt', data: 'fine' },
    ]);

    await assert.rejects(
      extractZip(file, path.join(dir, 'out')),
      (err) => err instanceof ValidationError && err.code === 'PATH_ESCAPE',
    );
    assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')));
  } finally {
    cleanup(dir);
  }
});

test('extractZip rejects absolute paths inside the archive', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(dir, 'abs.zip', [{ name: '/etc/passwd', data: 'root' }]);
    await assert.rejects(
      extractZip(file, path.join(dir, 'out')),
      (err) => err instanceof ValidationError && err.code === 'PATH_ESCAPE',
    );
  } finally {
    cleanup(dir);
  }
});

test('extractZip detects a checksum mismatch', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(dir, 'bad-crc.zip', [{ name: 'a.txt', data: 'hello', tamper: 'checksum' }]);
    await assert.rejects(extractZip(file, path.join(dir, 'out')), CorruptDataError);
  } finally {
    cleanup(dir);
  }
});

test('extractZip detects a size mismatch', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(dir, 'bad-size.zip', [{ name: 'a.txt', data: 'hello', tamper: 'size' }]);
    await assert.rejects(extractZip(file, path.join(dir, 'out')), CorruptDataError);
  } finally {
    cleanup(dir);
  }
});

test('extractZip rejects encrypted entries', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(dir, 'locked.zip', [{ name: 'a.txt', data: 'hello', flags: 0x1 }]);
    await assert.rejects(
      extractZip(file, path.join(dir, 'out')),
      (err) => err instanceof ValidationError && err.code === 'ZIP_ENCRYPTED_ENTRY',
    );
  } finally {
    cleanup(dir);
  }
});

test('extractZip rejects unsupported compression methods', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(dir, 'bzip.zip', [{ name: 'a.txt', data: 'hello', method: 12 }]);
    await assert.rejects(
      extractZip(file, path.join(dir, 'out')),
      (err) => err instanceof ValidationError && err.code === 'ZIP_UNSUPPORTED_METHOD',
    );
  } finally {
    cleanup(dir);
  }
});

test('listZipEntries rejects files without an end of central directory', async () => {
  const dir = tmpDir();
  try {
    const tooSmall = path.join(dir, 'small.bin');
    fs.writeFileSync(tooSmall, Buffer.alloc(10));
    await assert.rejects(listZipEntries(tooSmall), CorruptDataError);

    const garbage = path.join(dir, 'garbage.bin');
    fs.writeFileSync(garbage, Buffer.from('this is definitely not a zip archive at all'.repeat(4)));
    await assert.rejects(listZipEntries(garbage), CorruptDataError);
  } finally {
    cleanup(dir);
  }
});

test('extractZip enforces the entry count limit', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(
      dir,
      'many.zip',
      Array.from({ length: 4 }, (_, index) => ({ name: `f${index}.txt`, data: 'x' })),
    );
    await assert.rejects(
      extractZip(file, path.join(dir, 'out'), { limits: { maxEntries: 2 } }),
      (err) => err instanceof ValidationError && err.code === 'ZIP_LIMIT_EXCEEDED',
    );
    assert.ok(ZIP_LIMITS.maxEntries >= 1);
  } finally {
    cleanup(dir);
  }
});

test('extractZip enforces the entry size limit', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(dir, 'big.zip', [{ name: 'a.bin', data: Buffer.alloc(4096, 7) }]);
    await assert.rejects(
      extractZip(file, path.join(dir, 'out'), { limits: { maxEntryBytes: 1024 } }),
      (err) => err instanceof ValidationError && err.code === 'ZIP_LIMIT_EXCEEDED',
    );
  } finally {
    cleanup(dir);
  }
});

test('extractZip can be cancelled with a signal', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(dir, 'cancel.zip', NATIVES_ENTRIES);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      extractZip(file, path.join(dir, 'out'), { signal: controller.signal }),
      CancelledError,
    );
  } finally {
    cleanup(dir);
  }
});

test('extractZip returns zero files when every entry is excluded', async () => {
  const dir = tmpDir();
  try {
    const file = await writeZip(dir, 'only-meta.zip', [{ name: 'META-INF/MANIFEST.MF', data: 'Manifest' }]);
    const result = await extractZip(file, path.join(dir, 'out'), { exclude: ['META-INF/'] });
    assert.equal(result.count, 0);
    assert.equal(result.bytes, 0);
  } finally {
    cleanup(dir);
  }
});
