// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureDir,
  pathExists,
  readJson,
  resolveWithin,
  writeJson,
} from '../../src/core/filesystem.js';
import { CorruptDataError, ValidationError } from '../../src/core/errors.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tml-fs-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('resolveWithin allows paths inside the base directory', () => {
  const base = tmpDir();
  try {
    assert.equal(resolveWithin(base, 'minecraft/mods/mod.jar'), path.join(base, 'minecraft/mods/mod.jar'));
    assert.equal(resolveWithin(base, './a/../b.txt'), path.join(base, 'b.txt'));
    assert.equal(resolveWithin(base, 'nested/'), path.join(base, 'nested'));
  } finally {
    cleanup(base);
  }
});

test('resolveWithin rejects traversal and absolute escapes', () => {
  const base = tmpDir();
  try {
    assert.throws(() => resolveWithin(base, '../../outside.txt'), ValidationError);
    assert.throws(() => resolveWithin(base, 'minecraft/../../../etc/passwd'), ValidationError);
    assert.throws(() => resolveWithin(base, '/etc/passwd'), ValidationError);
    assert.throws(() => resolveWithin(base, '..'), ValidationError);
  } finally {
    cleanup(base);
  }
});

test('writeJson / readJson round-trip and create parent directories', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'nested', 'deep', 'instance.json');
    await writeJson(file, { format: 1, name: 'Survival' });

    assert.equal(await pathExists(file), true);
    const read = await readJson(file);
    assert.deepEqual(read, { format: 1, name: 'Survival' });

    assert.match(fs.readFileSync(file, 'utf8'), /^\s*\{/);
    assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    cleanup(dir);
  }
});

test('readJson distinguishes missing, optional and corrupt files', async () => {
  const dir = tmpDir();
  try {
    const missing = path.join(dir, 'missing.json');
    await assert.rejects(() => readJson(missing), (err) => err.code === 'FILE_NOT_FOUND');
    assert.equal(await readJson(missing, { optional: true }), null);

    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{ nope');
    await assert.rejects(() => readJson(corrupt), CorruptDataError);
  } finally {
    cleanup(dir);
  }
});

test('ensureDir is idempotent', async () => {
  const dir = tmpDir();
  try {
    const target = path.join(dir, 'a', 'b', 'c');
    await ensureDir(target);
    await ensureDir(target);
    assert.equal(await pathExists(target), true);
  } finally {
    cleanup(dir);
  }
});
