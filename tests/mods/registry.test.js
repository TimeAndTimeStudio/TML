// Owner: Time And Time Studio
// Date: 2026-10-06 14:59 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { forgetInstalledMod, readModRegistry, recordInstalledMods } from '../../src/mods/registry.js';

test('parallel registry writes keep every entry instead of overwriting each other', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-registry-'));
  try {
    const version = (id, projectId) => ({ id, projectId, versionNumber: '1.0.0' });

    // โหลดหลายไฟล์พร้อมกัน → แต่ละคำสั่งอ่าน-แก้-เขียน registry ตัวเดียวกัน ห้ามทำ entry ก่อนหน้าหาย
    await Promise.all([
      recordInstalledMods(dir, version('v-a', 'p-a'), [{ filename: 'a.jar' }]),
      recordInstalledMods(dir, version('v-b', 'p-b'), [{ filename: 'b.jar' }]),
      recordInstalledMods(dir, version('v-c', 'p-c'), [{ filename: 'c.jar' }]),
    ]);

    const registry = await readModRegistry(dir);
    assert.deepEqual(Object.keys(registry).sort(), ['a.jar', 'b.jar', 'c.jar']);
    assert.equal(registry['a.jar'].versionId, 'v-a');
    assert.equal(registry['b.jar'].versionId, 'v-b');
    assert.equal(registry['c.jar'].versionId, 'v-c');

    await Promise.all([
      forgetInstalledMod(dir, 'a.jar'),
      forgetInstalledMod(dir, 'b.jar'),
    ]);
    const after = await readModRegistry(dir);
    assert.deepEqual(Object.keys(after), ['c.jar']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
