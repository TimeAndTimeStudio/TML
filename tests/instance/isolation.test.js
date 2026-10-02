// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeZipFile } from '../../src/archive/zip.js';
import { createInstanceManager } from '../../src/instance/manager.js';
import { createInstanceExporter } from '../../src/instance/export.js';
import { createInstanceImporter } from '../../src/instance/import.js';
import { buildZip } from '../helpers/zip.js';

const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url));

const FORBIDDEN_IDENTIFIERS = Object.freeze([
  'globalMods',
  'globalConfig',
  'globalSaves',
  'globalGameDirectory',
  'currentInstanceMods',
  'currentInstanceConfig',
]);

const BASE = Object.freeze({
  minecraftVersion: '1.20.1',
  fabricLoaderVersion: '0.15.7',
});

const MANIFEST_JSON = `${JSON.stringify(
  { format: 1, name: 'Pack', minecraftVersion: '1.20.1', loader: 'fabric', fabricLoaderVersion: '0.15.7' },
  null,
  2,
)}\n`;

function createFakeLauncher() {
  const handles = [];
  return {
    handles,
    async launch() {
      let settle;
      const exited = new Promise((resolve) => {
        settle = resolve;
      });
      const handle = {
        pid: 9300 + handles.length,
        kill: (signal = 'SIGTERM') => {
          setTimeout(() => settle({ code: null, signal, error: null }), 0);
        },
        finish: (result) => settle(result),
        exited,
      };
      handles.push(handle);
      return handle;
    },
  };
}

function createFakeFabric() {
  const versions = new Map();
  return {
    async versionFor(id) {
      return versions.get(id) ?? null;
    },
    async install(id) {
      const version = { id: 'fabric-loader-0.15.7-1.20.1', mainClass: 'knot' };
      versions.set(id, version);
      return { id: version.id, installed: true };
    },
  };
}

function walkFiles(dir) {
  const out = [];
  const stack = [['', dir]];
  while (stack.length > 0) {
    const [rel, current] = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const nextAbs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push([nextRel, nextAbs]);
      else out.push([nextRel, nextAbs]);
    }
  }
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function snapshot(dir) {
  const out = {};
  for (const [rel, abs] of walkFiles(dir)) {
    out[rel] = fs.readFileSync(abs, 'utf8');
  }
  return out;
}

function walkSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSourceFiles(abs));
    else if (entry.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

let root;
let instancesDir;
let exportsDir;
let tempRoot;
let cacheDir;
let manager;
let exporter;
let importer;
let alpha;
let bravo;
let alphaZip;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-isolation-test-'));
  instancesDir = path.join(root, 'instances');
  exportsDir = path.join(root, 'exports');
  tempRoot = path.join(root, 'tmp');
  cacheDir = path.join(root, 'cache');
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  manager = createInstanceManager({ instancesDir, launcher: createFakeLauncher(), fabric: createFakeFabric() });
  exporter = createInstanceExporter({ manager, writeZip: writeZipFile, exportsDir });
  importer = createInstanceImporter({ manager, tempRoot });

  alpha = await manager.create({ name: 'Alpha', id: 'alpha', ...BASE });
  bravo = await manager.create({ name: 'Bravo', id: 'bravo', ...BASE });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('forbidden global identifiers never appear in source', () => {
  const files = walkSourceFiles(SRC_DIR);
  assert.ok(files.length > 10, 'expected to scan the src tree');

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      const pattern = new RegExp(`\\b${identifier}\\b`);
      assert.ok(
        !pattern.test(source),
        `${path.relative(SRC_DIR, file)} must not reference ${identifier}`,
      );
    }
  }
});

test('shared caches live outside every instance directory', () => {
  const alphaDir = manager.paths(alpha.id).dir;
  const bravoDir = manager.paths(bravo.id).dir;
  assert.equal(path.relative(instancesDir, alphaDir).startsWith('..'), false);
  assert.equal(path.relative(instancesDir, bravoDir).startsWith('..'), false);

  for (const shared of [cacheDir, exportsDir, tempRoot]) {
    assert.equal(path.relative(alphaDir, shared).startsWith('..'), true, `${shared} must not be inside alpha`);
    assert.equal(path.relative(bravoDir, shared).startsWith('..'), true, `${shared} must not be inside bravo`);
  }
});

test('test 1: writing mods into A never puts them into B', async () => {
  const alphaMods = manager.paths(alpha.id).modsDir;
  const bravoMods = manager.paths(bravo.id).modsDir;

  fs.writeFileSync(path.join(alphaMods, 'test.jar'), 'test mod');

  assert.equal(fs.existsSync(path.join(bravoMods, 'test.jar')), false);
  assert.deepEqual(fs.readdirSync(bravoMods), []);
});

test('test 2: changing A config leaves B config untouched', async () => {
  const alphaConfig = manager.paths(alpha.id).gameDir + '/config';
  const bravoConfig = manager.paths(bravo.id).gameDir + '/config';
  const before = snapshot(bravoConfig);

  fs.mkdirSync(path.join(alphaConfig, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(alphaConfig, 'sub', 'a.toml'), 'a=1');
  fs.writeFileSync(path.join(alphaConfig, 'global.toml'), 'changed');

  assert.deepEqual(snapshot(bravoConfig), before, 'B config must not change');
});

test('test 3: changing B saves leaves A saves untouched', async () => {
  const alphaSaves = manager.paths(alpha.id).gameDir + '/saves';
  const bravoSaves = manager.paths(bravo.id).gameDir + '/saves';
  const before = snapshot(alphaSaves);

  fs.mkdirSync(path.join(bravoSaves, 'world'), { recursive: true });
  fs.writeFileSync(path.join(bravoSaves, 'world', 'level.dat'), 'bravo level');

  assert.deepEqual(snapshot(alphaSaves), before, 'A saves must not change');
});

test('test 4: export A → import as C → editing C never changes A', async () => {
  const alphaBefore = snapshot(manager.paths(alpha.id).dir);
  alphaZip ??= await exporter.export(alpha.id);

  const result = await importer.import(alphaZip.path, { id: 'charlie', name: 'Charlie' });
  const charlieDir = manager.paths(result.instanceId).dir;

  fs.writeFileSync(path.join(manager.paths(result.instanceId).modsDir, 'test.jar'), 'edited copy');
  fs.writeFileSync(path.join(charlieDir, 'minecraft/options.txt'), 'fov:110\n');
  fs.mkdirSync(path.join(charlieDir, 'minecraft/saves/newworld'), { recursive: true });
  fs.writeFileSync(path.join(charlieDir, 'minecraft/saves/newworld/level.dat'), 'copy level');

  assert.deepEqual(snapshot(manager.paths(alpha.id).dir), alphaBefore, 'A must be byte-identical after editing C');
});

test('test 5: a zip slip entry is rejected and nothing escapes', async () => {
  const outside = path.join(root, 'outside.txt');
  const slip = path.join(root, 'slip.zip');
  fs.writeFileSync(slip, buildZip([
    { name: 'instance.json', data: MANIFEST_JSON },
    { name: '../../outside.txt', data: 'pwned' },
  ]));

  await assert.rejects(importer.import(slip, { id: 'slipped' }), (err) => err.code === 'ZIP_INVALID_ENTRY_NAME');
  assert.equal(fs.existsSync(outside), false, 'the slipped file must not exist');
  assert.equal(fs.existsSync(path.join(instancesDir, 'slipped')), false, 'no instance may be created');
});

test('test 6: a zip without instance.json is rejected', async () => {
  const broken = path.join(root, 'broken.zip');
  fs.writeFileSync(broken, buildZip([{ name: 'minecraft/mods/a.jar', data: 'x' }]));

  await assert.rejects(importer.import(broken), (err) => err.code === 'IMPORT_NO_MANIFEST');
  assert.equal(fs.existsSync(path.join(instancesDir, 'broken')), false);
});

test('test 7: a zip with loader forge is rejected (fabric only)', async () => {
  const forge = path.join(root, 'forge.zip');
  fs.writeFileSync(forge, buildZip([
    { name: 'instance.json', data: JSON.stringify({ format: 1, name: 'Pack', minecraftVersion: '1.20.1', loader: 'forge', fabricLoaderVersion: '0.15.7' }) },
  ]));

  await assert.rejects(
    importer.import(forge),
    (err) => err.code === 'EXPORT_MANIFEST_INVALID' && err.details.field === 'loader',
  );
  assert.equal(fs.existsSync(path.join(instancesDir, 'forge')), false);
});

test('duplicate copies real files — no symlink, no hard link, no shared state', async () => {
  fs.writeFileSync(path.join(manager.paths(alpha.id).modsDir, 'test.jar'), 'original copy source');

  const copy = await manager.duplicate(alpha.id, { id: 'alphacopy', name: 'Alpha Copy' });
  const srcDir = manager.paths(alpha.id).dir;
  const dstDir = manager.paths(copy.id).dir;

  for (const [rel, abs] of walkFiles(dstDir)) {
    const link = fs.lstatSync(abs);
    assert.equal(link.isSymbolicLink(), false, `${rel} must not be a symlink`);

    const srcFile = path.join(srcDir, rel);
    if (fs.existsSync(srcFile)) {
      const srcStat = fs.statSync(srcFile);
      const dstStat = fs.statSync(abs);
      assert.notEqual(dstStat.ino, srcStat.ino, `${rel} must be a real copy, not a hard link`);
      assert.notEqual(dstStat.nlink, 0);
    }
  }

  fs.writeFileSync(path.join(manager.paths(copy.id).modsDir, 'test.jar'), 'edited duplicate');
  assert.equal(
    fs.readFileSync(path.join(manager.paths(alpha.id).modsDir, 'test.jar'), 'utf8'),
    'original copy source',
    'editing the duplicate must never touch the source',
  );
});

test('deleting an instance removes only its own directory', async () => {
  const cacheSentinel = path.join(cacheDir, 'shared-cache.bin');
  fs.writeFileSync(cacheSentinel, 'shared read-only cache');

  const bravoBefore = snapshot(manager.paths(bravo.id).dir);
  const alphaDir = manager.paths(alpha.id).dir;
  assert.equal(fs.existsSync(alphaDir), true);

  await manager.delete(alpha.id);

  assert.equal(fs.existsSync(alphaDir), false, 'instances/<alpha>/ must be gone');
  assert.equal(fs.existsSync(path.join(instancesDir, 'alpha')), false);
  assert.equal(fs.readFileSync(cacheSentinel, 'utf8'), 'shared read-only cache', 'shared cache must survive');
  assert.deepEqual(snapshot(manager.paths(bravo.id).dir), bravoBefore, 'other instances must survive untouched');
});
