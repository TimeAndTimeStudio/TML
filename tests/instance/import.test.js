// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CancelledError } from '../../src/core/errors.js';
import { writeZipFile } from '../../src/archive/zip.js';
import { createInstanceManager } from '../../src/instance/manager.js';
import { createInstanceExporter } from '../../src/instance/export.js';
import { createInstanceImporter } from '../../src/instance/import.js';
import { buildZip } from '../helpers/zip.js';

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
        pid: 9100 + handles.length,
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

let root;
let instancesDir;
let exportsDir;
let tempRoot;
let manager;
let exporter;
let importer;
let survival;
let survivalZip;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-import-test-'));
  instancesDir = path.join(root, 'instances');
  exportsDir = path.join(root, 'exports');
  tempRoot = path.join(root, 'tmp');
  fs.mkdirSync(tempRoot, { recursive: true });

  manager = createInstanceManager({ instancesDir, launcher: createFakeLauncher(), fabric: createFakeFabric() });
  exporter = createInstanceExporter({ manager, writeZip: writeZipFile, exportsDir });
  importer = createInstanceImporter({ manager, tempRoot });

  survival = await manager.create({ name: 'Survival', id: 'survival1', ...BASE });
  const paths = manager.paths(survival.id);
  fs.writeFileSync(path.join(paths.modsDir, 'iris.jar'), 'iris mod');
  fs.mkdirSync(path.join(paths.gameDir, 'config', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(paths.gameDir, 'config', 'sub', 'x.toml'), 'x=1');
  fs.mkdirSync(path.join(paths.gameDir, 'saves', 'world'), { recursive: true });
  fs.writeFileSync(path.join(paths.gameDir, 'saves', 'world', 'level.dat'), 'level');
  fs.mkdirSync(path.join(paths.gameDir, 'saves', 'emptyworld'), { recursive: true });
  fs.writeFileSync(path.join(paths.gameDir, 'resourcepacks', 'pack.zip'), 'pack');
  fs.writeFileSync(path.join(paths.gameDir, 'shaderpacks', 'shaders.zip'), 'shaders');
  fs.writeFileSync(path.join(paths.gameDir, 'options.txt'), 'fov:70\n');

  survivalZip = await exporter.export(survival.id);
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('import creates a fresh instance from an exported archive', async () => {
  const result = await importer.import(survivalZip.path);

  assert.ok(Object.isFrozen(result));
  assert.notEqual(result.instanceId, survival.id, 'import must generate a new id');
  assert.equal(result.name, 'Survival');
  assert.deepEqual({ ...result.manifest }, {
    format: 1,
    name: 'Survival',
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    fabricLoaderVersion: '0.15.7',
  });
  assert.equal(result.files, 6);
  assert.ok(result.bytes > 0);

  const meta = await manager.get(result.instanceId);
  assert.equal(meta.minecraftVersion, '1.20.1');
  assert.equal(meta.loader, 'fabric');
  assert.equal(meta.fabricLoaderVersion, '0.15.7');

  const gameDir = manager.paths(result.instanceId).gameDir;
  assert.equal(fs.readFileSync(path.join(gameDir, 'mods', 'iris.jar'), 'utf8'), 'iris mod');
  assert.equal(fs.readFileSync(path.join(gameDir, 'config', 'sub', 'x.toml'), 'utf8'), 'x=1');
  assert.equal(fs.readFileSync(path.join(gameDir, 'saves', 'world', 'level.dat'), 'utf8'), 'level');
  assert.equal(fs.readFileSync(path.join(gameDir, 'resourcepacks', 'pack.zip'), 'utf8'), 'pack');
  assert.equal(fs.readFileSync(path.join(gameDir, 'shaderpacks', 'shaders.zip'), 'utf8'), 'shaders');
  assert.equal(fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8'), 'fov:70\n');
  assert.equal(fs.statSync(path.join(gameDir, 'saves', 'emptyworld')).isDirectory(), true, 'empty directories survive the round trip');

  assert.deepEqual(fs.readdirSync(tempRoot), [], 'temp directory must be cleaned up');
});

test('the imported instance is completely independent of the source', async () => {
  const result = await importer.import(survivalZip.path);
  const src = manager.paths(survival.id);
  const dst = manager.paths(result.instanceId);
  assert.notEqual(src.dir, dst.dir);

  fs.writeFileSync(path.join(dst.modsDir, 'iris.jar'), 'modified copy');
  assert.equal(fs.readFileSync(path.join(src.modsDir, 'iris.jar'), 'utf8'), 'iris mod', 'editing the copy must never touch the source');

  const srcMeta = JSON.parse(fs.readFileSync(src.metaFile, 'utf8'));
  const dstMeta = JSON.parse(fs.readFileSync(dst.metaFile, 'utf8'));
  assert.equal(srcMeta.id, 'survival1');
  assert.equal(dstMeta.id, result.instanceId);
  assert.notEqual(srcMeta.id, dstMeta.id);

  fs.writeFileSync(path.join(dst.gameDir, 'options.txt'), 'fov:90\n');
  assert.equal(fs.readFileSync(path.join(src.gameDir, 'options.txt'), 'utf8'), 'fov:70\n');
});

test('inspect reports the manifest without writing anything', async () => {
  const instancesBefore = fs.readdirSync(instancesDir).sort();
  const tempBefore = fs.readdirSync(tempRoot);

  const { manifest, entries } = await importer.inspect(survivalZip.path);
  assert.deepEqual({ ...manifest }, {
    format: 1,
    name: 'Survival',
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    fabricLoaderVersion: '0.15.7',
  });
  assert.ok(Object.isFrozen(manifest));
  assert.equal(entries.some((entry) => entry.normalized === 'instance.json'), true);

  assert.deepEqual(fs.readdirSync(instancesDir).sort(), instancesBefore, 'inspect must not create instances');
  assert.deepEqual(fs.readdirSync(tempRoot), tempBefore, 'inspect must not create temp directories');
});

test('malformed archives are rejected before anything is created', async () => {
  const instancesBefore = fs.readdirSync(instancesDir).sort();

  const garbage = path.join(root, 'garbage.zip');
  fs.writeFileSync(garbage, 'this is not a zip file at all');
  await assert.rejects(importer.import(garbage), (err) => err.code === 'IMPORT_INVALID_ZIP');

  await assert.rejects(importer.import(path.join(root, 'missing.zip')), (err) => err.code === 'IMPORT_INVALID_ZIP');

  const noManifest = path.join(root, 'nomanifest.zip');
  fs.writeFileSync(noManifest, buildZip([{ name: 'minecraft/mods/a.jar', data: 'x' }]));
  await assert.rejects(importer.import(noManifest), (err) => err.code === 'IMPORT_NO_MANIFEST');

  const badJson = path.join(root, 'badjson.zip');
  fs.writeFileSync(badJson, buildZip([{ name: 'instance.json', data: '{not json' }]));
  await assert.rejects(importer.import(badJson), (err) => err.code === 'IMPORT_NO_MANIFEST');

  const unknown = path.join(root, 'unknown.zip');
  fs.writeFileSync(unknown, buildZip([
    { name: 'instance.json', data: MANIFEST_JSON },
    { name: 'evil.txt', data: 'x' },
  ]));
  await assert.rejects(importer.import(unknown), (err) => err.code === 'IMPORT_UNKNOWN_ENTRY');

  const futureFormat = path.join(root, 'future.zip');
  fs.writeFileSync(futureFormat, buildZip([
    { name: 'instance.json', data: JSON.stringify({ format: 2, name: 'Pack', minecraftVersion: '1.20.1', loader: 'fabric', fabricLoaderVersion: '0.15.7' }) },
  ]));
  await assert.rejects(importer.import(futureFormat), (err) => err.code === 'EXPORT_MANIFEST_UNSUPPORTED' && err.details.format === 2);

  const forge = path.join(root, 'forge.zip');
  fs.writeFileSync(forge, buildZip([
    { name: 'instance.json', data: JSON.stringify({ format: 1, name: 'Pack', minecraftVersion: '1.20.1', loader: 'forge', fabricLoaderVersion: '0.15.7' }) },
  ]));
  await assert.rejects(importer.import(forge), (err) => err.code === 'EXPORT_MANIFEST_INVALID' && err.details.field === 'loader');

  const corrupt = path.join(root, 'corrupt.zip');
  fs.writeFileSync(corrupt, buildZip([
    { name: 'instance.json', data: MANIFEST_JSON, tamper: 'checksum' },
  ]));
  await assert.rejects(importer.import(corrupt), (err) => err.code === 'IMPORT_INVALID_ZIP');

  const duplicate = path.join(root, 'duplicate.zip');
  fs.writeFileSync(duplicate, buildZip([
    { name: 'instance.json', data: MANIFEST_JSON },
    { name: 'instance.json', data: MANIFEST_JSON },
  ]));
  await assert.rejects(importer.import(duplicate), (err) => err.code === 'ZIP_DUPLICATE_ENTRY');

  assert.deepEqual(fs.readdirSync(instancesDir).sort(), instancesBefore, 'no rejected archive may create an instance');
  assert.deepEqual(fs.readdirSync(tempRoot), [], 'no rejected archive may leave a temp directory');
});

test('zip slip entry names are rejected and nothing is written outside', async () => {
  const instancesBefore = fs.readdirSync(instancesDir).sort();

  const cases = ['../../escape.txt', 'minecraft/../../escape.txt', '..\\escape.txt', '/etc/passwd'];
  const files = cases.map((name) => {
    const file = path.join(root, `slip-${Buffer.from(name).toString('hex')}.zip`);
    fs.writeFileSync(file, buildZip([
      { name: 'instance.json', data: MANIFEST_JSON },
      { name, data: 'pwned' },
    ]));
    return file;
  });
  const rootBefore = fs.readdirSync(root).sort();

  for (const file of files) {
    const name = cases[files.indexOf(file)];
    await assert.rejects(importer.import(file), (err) => err.code === 'ZIP_INVALID_ENTRY_NAME', `entry "${name}" must be rejected`);
  }

  assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
  assert.equal(fs.existsSync(path.join(os.tmpdir(), 'escape.txt')), false);
  assert.deepEqual(fs.readdirSync(instancesDir).sort(), instancesBefore);
  assert.deepEqual(fs.readdirSync(root).sort(), rootBefore, 'no stray files next to the workspace');
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('a failed import leaves no partial instance and no temp directory', async () => {
  const instancesBefore = fs.readdirSync(instancesDir).sort();

  const collide = path.join(root, 'collide.zip');
  fs.writeFileSync(collide, buildZip([
    { name: 'instance.json', data: MANIFEST_JSON },
    { name: 'minecraft/mods', data: 'i am a file, not a directory' },
  ]));

  await assert.rejects(importer.import(collide), (err) => err.code === 'EISDIR' || err.code === 'ENOTDIR' || err.code === 'EPERM');
  assert.deepEqual(fs.readdirSync(instancesDir).sort(), instancesBefore, 'the created instance must be rolled back');
  assert.deepEqual(fs.readdirSync(tempRoot), [], 'the temp directory must be deleted');
});

test('id and name overrides are validated before any work', async () => {
  const instancesBefore = fs.readdirSync(instancesDir).sort();

  await assert.rejects(importer.import(survivalZip.path, { id: 'BAD ID' }), { code: 'INVALID_INSTANCE_ID' });
  await assert.rejects(importer.import(survivalZip.path, { name: 'x'.repeat(81) }), { code: 'INVALID_INSTANCE_NAME' });
  assert.deepEqual(fs.readdirSync(instancesDir).sort(), instancesBefore, 'validation failures must not create anything');
  assert.deepEqual(fs.readdirSync(tempRoot), []);

  const result = await importer.import(survivalZip.path, { name: 'Imported Copy', id: 'imported1' });
  assert.equal(result.instanceId, 'imported1');
  assert.equal(result.name, 'Imported Copy');
  const meta = await manager.get('imported1');
  assert.equal(meta.name, 'Imported Copy');
  assert.equal(fs.readFileSync(path.join(manager.paths('imported1').modsDir, 'iris.jar'), 'utf8'), 'iris mod');

  await assert.rejects(importer.import(survivalZip.path, { id: 'imported1' }), { code: 'INSTANCE_EXISTS', status: 409 });
});

test('cancelled imports create nothing', async () => {
  const instancesBefore = fs.readdirSync(instancesDir).sort();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(importer.import(survivalZip.path, { signal: controller.signal }), (err) => err instanceof CancelledError);
  assert.deepEqual(fs.readdirSync(instancesDir).sort(), instancesBefore);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('importer validates collaborators', () => {
  assert.throws(() => createInstanceImporter({}), (err) => err.code === 'INVALID_INSTANCE_MANAGER');
  assert.throws(() => createInstanceImporter({ manager: { create() {} } }), (err) => err.code === 'INVALID_INSTANCE_MANAGER');
  const ok = createInstanceImporter({ manager });
  assert.equal(typeof ok.inspect, 'function');
  assert.equal(typeof ok.import, 'function');
});
