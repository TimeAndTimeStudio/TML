// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CancelledError, InstanceError, ValidationError } from '../../src/core/errors.js';
import { hashFile } from '../../src/download/hash.js';
import { writeZipFile } from '../../src/archive/zip.js';
import { extractZip, listZipEntries, readZipEntry } from '../../src/archive/unzip.js';
import { createInstanceManager } from '../../src/instance/manager.js';
import {
  assertExportableMeta,
  buildExportManifest,
  createInstanceExporter,
  sanitizeExportName,
  serializeExportManifest,
  validateExportManifest,
} from '../../src/instance/export.js';

const BASE = Object.freeze({
  minecraftVersion: '1.20.1',
  fabricLoaderVersion: '0.15.7',
});

const EXPECTED_FILES = Object.freeze([
  'instance.json',
  'minecraft/config/sub/x.toml',
  'minecraft/mods/iris.jar',
  'minecraft/options.txt',
  'minecraft/resourcepacks/pack.zip',
  'minecraft/saves/world/level.dat',
  'minecraft/shaderpacks/shaders.zip',
]);

const EXPECTED_DIRS = Object.freeze([
  'minecraft/',
  'minecraft/config/',
  'minecraft/config/sub/',
  'minecraft/mods/',
  'minecraft/resourcepacks/',
  'minecraft/saves/',
  'minecraft/saves/world/',
  'minecraft/shaderpacks/',
]);

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
        pid: 9000 + handles.length,
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

function listFilesRecursive(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      out.push(rel);
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
    }
  };
  walk(dir, '');
  return out;
}

let root;
let instancesDir;
let exportsDir;
let manager;
let exporter;
let meta;
let other;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-export-'));
  instancesDir = path.join(root, 'instances');
  exportsDir = path.join(root, 'exports');
  manager = createInstanceManager({ instancesDir, launcher: createFakeLauncher(), fabric: createFakeFabric() });
  exporter = createInstanceExporter({ manager, writeZip: writeZipFile, exportsDir });

  meta = await manager.create({ name: 'Survival', id: 'survival1', ...BASE });
  const paths = manager.paths(meta.id);
  fs.writeFileSync(path.join(paths.modsDir, 'iris.jar'), 'iris mod');
  fs.mkdirSync(path.join(paths.gameDir, 'config', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(paths.gameDir, 'config', 'sub', 'x.toml'), 'x=1');
  fs.mkdirSync(path.join(paths.gameDir, 'saves', 'world'), { recursive: true });
  fs.writeFileSync(path.join(paths.gameDir, 'saves', 'world', 'level.dat'), 'level');
  fs.writeFileSync(path.join(paths.gameDir, 'resourcepacks', 'pack.zip'), 'pack');
  fs.writeFileSync(path.join(paths.gameDir, 'shaderpacks', 'shaders.zip'), 'shaders');

  fs.writeFileSync(path.join(paths.dir, 'fabric-version.json'), '{"id":"fabric-loader-x"}');
  fs.mkdirSync(path.join(paths.gameDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(paths.gameDir, 'logs', 'latest.log'), 'log noise');
  fs.writeFileSync(path.join(paths.gameDir, 'other.txt'), 'not exportable');

  other = await manager.create({ name: 'Other', id: 'other1', ...BASE });
  fs.writeFileSync(path.join(manager.paths(other.id).modsDir, 'other.jar'), 'other mod');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('plan lists exactly the exportable content of one instance', async () => {
  const plan = await exporter.plan(meta.id);

  assert.ok(Object.isFrozen(plan));
  const names = plan.entries.map((entry) => entry.name);
  assert.deepEqual(names, [...EXPECTED_FILES, ...EXPECTED_DIRS].sort());
  assert.equal(plan.fileCount, EXPECTED_FILES.length);
  assert.equal(plan.dirCount, EXPECTED_DIRS.length);
  assert.equal(plan.totalBytes, plan.entries.reduce((sum, entry) => sum + entry.size, 0));
  assert.ok(plan.totalBytes > 0);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.name, 'Survival');
  assert.equal(plan.instanceDir, manager.paths(meta.id).dir);
  assert.ok(Object.isFrozen(plan.entries));
  assert.ok(Object.isFrozen(plan.entries[0]));
  assert.deepEqual(plan.manifest, {
    name: 'Survival',
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    fabricLoaderVersion: '0.15.7',
    type: 'client',
  });
  const manifestEntry = plan.entries.find((entry) => entry.name === 'instance.json');
  assert.equal(manifestEntry.src, null, 'instance.json is generated, not copied from disk');
  assert.equal(manifestEntry.data.toString(), serializeExportManifest(plan.manifest));
  assert.equal(manifestEntry.size, manifestEntry.data.length);

  for (const forbidden of ['fabric-version.json', 'latest.log', 'other.txt', 'logs/']) {
    assert.equal(names.some((name) => name.includes(forbidden)), false, `${forbidden} must not be exported`);
  }
});

test('plan records symlinks as skipped instead of following them', async () => {
  const paths = manager.paths(meta.id);
  fs.symlinkSync(path.join(paths.modsDir, 'iris.jar'), path.join(paths.modsDir, 'linked.jar'));
  fs.symlinkSync(root, path.join(paths.modsDir, 'linkeddir'));

  try {
    const plan = await exporter.plan(meta.id);
    assert.deepEqual(plan.skipped, [
      { name: 'minecraft/mods/linked.jar', reason: 'symlink' },
      { name: 'minecraft/mods/linkeddir', reason: 'symlink' },
    ]);
    const names = plan.entries.map((entry) => entry.name);
    assert.equal(names.some((name) => name.includes('linked')), false, 'symlinks must never enter the archive');
  } finally {
    fs.rmSync(path.join(paths.modsDir, 'linked.jar'), { force: true });
    fs.rmSync(path.join(paths.modsDir, 'linkeddir'), { force: true });
  }
});

test('export writes a zip that round-trips through the official reader', async () => {
  const result = await exporter.export(meta.id);

  assert.ok(Object.isFrozen(result));
  assert.equal(result.filename, 'Survival-1.20.1.zip');
  assert.equal(result.path, path.join(exportsDir, 'Survival-1.20.1.zip'));
  assert.equal(result.files, EXPECTED_FILES.length);
  assert.equal(result.dirs, EXPECTED_DIRS.length);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.sha1, (await hashFile(result.path, ['sha1'])).sha1);
  assert.equal(result.bytes, fs.statSync(result.path).size);

  const plan = await exporter.plan(meta.id);
  const entries = await listZipEntries(result.path);
  assert.deepEqual(entries.map((entry) => entry.name), plan.entries.map((entry) => entry.name));
  for (const name of ['fabric-version.json', 'latest.log', 'other.txt']) {
    assert.equal(entries.some((entry) => entry.name.includes(name)), false, `${name} must stay out of the zip`);
  }

  const metaEntry = entries.find((entry) => entry.name === 'instance.json');
  const manifestBytes = await readZipEntry(result.path, metaEntry);
  const manifest = JSON.parse(manifestBytes.toString());
  assert.deepEqual(manifest, {
    name: 'Survival',
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    fabricLoaderVersion: '0.15.7',
    type: 'client',
  });
  assert.equal(manifestBytes.toString(), `${JSON.stringify(manifest, null, 2)}\n`, 'manifest must use the writeJson style');
  const onDisk = JSON.parse(fs.readFileSync(manager.paths(meta.id).metaFile, 'utf8'));
  assert.equal(onDisk.id, 'survival1');
  assert.equal(manifest.id, undefined, 'the exported manifest carries no instance id (import creates a fresh one)');
  const jarEntry = entries.find((entry) => entry.name === 'minecraft/mods/iris.jar');
  assert.equal((await readZipEntry(result.path, jarEntry)).toString(), 'iris mod');

  const extractDir = path.join(root, 'roundtrip');
  await extractZip(result.path, extractDir);
  assert.equal(fs.readFileSync(path.join(extractDir, 'minecraft', 'mods', 'iris.jar'), 'utf8'), 'iris mod');
  assert.equal(fs.readFileSync(path.join(extractDir, 'instance.json'), 'utf8').includes('"Survival"'), true);
  assert.equal(fs.existsSync(path.join(extractDir, 'minecraft', 'logs')), false);
});

test('exporting one instance never touches another instance', async () => {
  const snapshotBefore = listFilesRecursive(instancesDir);

  const a = await exporter.export(meta.id, { force: true });
  const b = await exporter.export(other.id);

  assert.deepEqual(fs.readdirSync(exportsDir).sort(), ['Other-1.20.1.zip', 'Survival-1.20.1.zip']);
  assert.deepEqual(listFilesRecursive(instancesDir), snapshotBefore, 'instances directory must stay byte-identical');

  const namesA = (await listZipEntries(a.path)).map((entry) => entry.name);
  const namesB = (await listZipEntries(b.path)).map((entry) => entry.name);
  assert.equal(namesA.some((name) => name.includes('other.jar') || name.includes('other1')), false);
  assert.equal(namesB.some((name) => name.includes('iris.jar') || name.includes('survival1')), false);
  assert.equal(namesB.includes('minecraft/mods/other.jar'), true);
});

test('export names are sanitized and collisions require force', async () => {
  assert.equal(sanitizeExportName('My: Pack?'), 'My_ Pack_');
  assert.equal(sanitizeExportName('  spaced  '), 'spaced');
  assert.equal(sanitizeExportName('a/b'), 'a_b');
  assert.equal(sanitizeExportName('...'), null);
  assert.equal(sanitizeExportName('   '), null);
  assert.equal(sanitizeExportName(null), null);
  assert.equal(sanitizeExportName('x'.repeat(400)).length, 150);

  const weird = await exporter.export(meta.id, { name: 'Weird/Name:v2' });
  assert.equal(weird.filename, 'Weird_Name_v2.zip');

  const fallback = await exporter.export(meta.id, { name: ' ... ' });
  assert.equal(fallback.filename, `${meta.id}.zip`);

  await assert.rejects(exporter.export(meta.id), (err) => err instanceof InstanceError && err.code === 'EXPORT_EXISTS' && err.status === 409);
  const forced = await exporter.export(meta.id, { force: true });
  assert.equal(forced.filename, 'Survival-1.20.1.zip');

  await assert.rejects(exporter.export(meta.id, { name: 42 }), { code: 'INVALID_EXPORT_NAME' });

  const files = fs.readdirSync(exportsDir);
  assert.equal(files.includes('Weird_Name_v2.zip'), true);
  assert.equal(files.includes(`${meta.id}.zip`), true);
  assert.equal(files.some((name) => name.includes('/') || name.startsWith('.')), false, 'filenames must stay flat and visible');
  assert.equal(files.every((name) => name.endsWith('.zip')), true);
});

test('export accepts a custom destination path and validates it', async () => {
  const destDir = path.join(root, 'chosen', 'folder');

  const result = await exporter.export(meta.id, { name: 'Away', path: destDir });
  assert.equal(result.path, path.join(destDir, 'Away.zip'));
  assert.equal(fs.existsSync(result.path), true, 'missing destination folders are created recursively');
  assert.equal(fs.existsSync(path.join(exportsDir, 'Away.zip')), false, 'the default exportsDir stays untouched');

  await assert.rejects(
    exporter.export(meta.id, { name: 'Away', path: destDir }),
    (err) => err instanceof InstanceError && err.code === 'EXPORT_EXISTS' && err.status === 409,
    'collision detection applies inside the custom folder too',
  );
  const forced = await exporter.export(meta.id, { name: 'Away', path: destDir, force: true });
  assert.equal(forced.path, path.join(destDir, 'Away.zip'));

  await assert.rejects(exporter.export(meta.id, { path: 'relative/dir' }), (err) => err instanceof ValidationError && err.code === 'INVALID_EXPORT_PATH' && err.status === 400 && err.details.field === 'path');
  await assert.rejects(exporter.export(meta.id, { path: '' }), { code: 'INVALID_EXPORT_PATH' });
  await assert.rejects(exporter.export(meta.id, { path: '   ' }), { code: 'INVALID_EXPORT_PATH' });
  await assert.rejects(exporter.export(meta.id, { path: 42 }), { code: 'INVALID_EXPORT_PATH' });

  const fileInTheWay = path.join(root, 'plain-file');
  fs.writeFileSync(fileInTheWay, 'not a directory');
  await assert.rejects(
    exporter.export(meta.id, { name: 'Blocked', path: fileInTheWay }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_EXPORT_PATH' && err.details.path === fileInTheWay,
    'a destination that cannot become a directory fails with INVALID_EXPORT_PATH',
  );
});

test('export refuses while the instance is running', async () => {
  await manager.launch(meta.id);
  try {
    await assert.rejects(exporter.export(meta.id, { force: true }), (err) => err instanceof InstanceError && err.code === 'INSTANCE_RUNNING' && err.status === 409);
  } finally {
    await manager.stop(meta.id);
  }
  const plan = await exporter.plan(meta.id);
  assert.ok(plan.entries.length > 0, 'planning a stopped instance still works');
});

test('cancelled exports leave no archive behind', async () => {
  const controller = new AbortController();
  controller.abort();
  const before = fs.readdirSync(exportsDir).sort();

  await assert.rejects(
    exporter.export(meta.id, { name: 'Cancelled', signal: controller.signal }),
    (err) => err instanceof CancelledError,
  );

  assert.deepEqual(fs.readdirSync(exportsDir).sort(), before);
  assert.equal(fs.existsSync(path.join(exportsDir, 'Cancelled.zip.part')), false);
});

test('secret fields are refused before an export can start', () => {
  assert.throws(() => assertExportableMeta({ accessToken: 'x' }), (err) => err instanceof InstanceError && err.code === 'EXPORT_FORBIDDEN_DATA');
  assert.throws(() => assertExportableMeta({ auth: { refreshToken: 'y' } }), { code: 'EXPORT_FORBIDDEN_DATA' });
  assert.throws(() => assertExportableMeta({ items: [{ clientSecret: 'z' }] }), { code: 'EXPORT_FORBIDDEN_DATA' });
  assert.throws(() => assertExportableMeta({ headers: { Authorization: 'Bearer q' } }), { code: 'EXPORT_FORBIDDEN_DATA' });
});

test('exporter validates collaborators and instance ids', async () => {
  assert.throws(() => createInstanceExporter({}), (err) => err instanceof ValidationError && err.code === 'INVALID_INSTANCE_MANAGER');
  assert.throws(
    () => createInstanceExporter({ manager: { get() {}, paths() {} } }),
    (err) => err.code === 'INVALID_INSTANCE_MANAGER',
  );
  assert.throws(() => createInstanceExporter({ manager }), (err) => err.code === 'NO_ZIP_WRITER');
  assert.throws(() => createInstanceExporter({ manager, writeZip: writeZipFile }), (err) => err.code === 'INVALID_EXPORTS_DIR');

  await assert.rejects(exporter.plan('nope'), { code: 'INSTANCE_NOT_FOUND', status: 404 });
  await assert.rejects(exporter.export('nope'), { code: 'INSTANCE_NOT_FOUND', status: 404 });

  const realMeta = await manager.get(meta.id);
  assert.equal(assertExportableMeta(realMeta), realMeta, 'a real instance metadata must pass the secret scan');
});

test('export manifest contains exactly the documented fields', async () => {
  const realMeta = await manager.get(meta.id);
  const manifest = buildExportManifest(realMeta);
  assert.deepEqual(Object.keys(manifest), ['name', 'minecraftVersion', 'loader', 'fabricLoaderVersion', 'type']);
  assert.deepEqual({ ...manifest }, {
    name: 'Survival',
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    fabricLoaderVersion: '0.15.7',
    type: 'client',
  });
  assert.ok(Object.isFrozen(manifest));
  assert.equal(serializeExportManifest(manifest), `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => assertExportableMeta({ ...realMeta, oauthToken: 'x' }), { code: 'EXPORT_FORBIDDEN_DATA' });
});

test('validateExportManifest accepts manifests (legacy format field ignored) and rejects malformed ones', () => {
  const valid = validateExportManifest({
    format: 1,
    name: 'Survival',
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    fabricLoaderVersion: '0.15.7',
    extraField: 'ignored',
  });
  assert.deepEqual(Object.keys(valid), ['name', 'minecraftVersion', 'loader', 'fabricLoaderVersion', 'type']);
  assert.equal(valid.format, undefined, 'legacy format field must not leak into the parsed manifest');
  assert.deepEqual({ type: valid.type }, { type: 'client' }, 'archives without a type are client instances');
  assert.ok(Object.isFrozen(valid));

  assert.throws(() => validateExportManifest(null), (err) => err instanceof ValidationError && err.code === 'EXPORT_MANIFEST_INVALID' && err.details.field === 'manifest');
  assert.throws(() => validateExportManifest('x'), { code: 'EXPORT_MANIFEST_INVALID' });
  assert.throws(() => validateExportManifest([1]), { code: 'EXPORT_MANIFEST_INVALID' });
  assert.throws(
    () => validateExportManifest({ format: 1, name: '', minecraftVersion: '1.20.1', loader: 'fabric', fabricLoaderVersion: '0.15.7' }),
    (err) => err.code === 'EXPORT_MANIFEST_INVALID' && err.details.field === 'name',
  );
  assert.throws(
    () => validateExportManifest({ format: 1, name: 'ok', minecraftVersion: '../../etc', loader: 'fabric', fabricLoaderVersion: '0.15.7' }),
    (err) => err.code === 'EXPORT_MANIFEST_INVALID' && err.details.field === 'minecraftVersion',
  );
  assert.throws(
    () => validateExportManifest({ format: 1, name: 'ok', minecraftVersion: '1.20.1', loader: 'forge', fabricLoaderVersion: '0.15.7' }),
    (err) => err.code === 'EXPORT_MANIFEST_INVALID' && err.details.field === 'loader',
  );
  assert.throws(
    () => validateExportManifest({ format: 1, name: 'ok', minecraftVersion: '1.20.1', loader: 'fabric', fabricLoaderVersion: '' }),
    (err) => err.code === 'EXPORT_MANIFEST_INVALID' && err.details.field === 'fabricLoaderVersion',
  );
  assert.throws(
    () => validateExportManifest({ format: 1, name: 'ok', minecraftVersion: '1.20.1', loader: 'fabric', fabricLoaderVersion: '0.15.7', type: 'banana' }),
    (err) => err.code === 'EXPORT_MANIFEST_INVALID' && err.details.field === 'type',
  );
});

test('the manifest written by export survives validation (round-trip for import)', async () => {
  const plan = await exporter.plan(meta.id);
  const checked = validateExportManifest(JSON.parse(serializeExportManifest(plan.manifest)));
  assert.deepEqual({ ...checked }, { ...plan.manifest });

  const result = await exporter.export(meta.id, { name: 'Manifest', force: true });
  const entries = await listZipEntries(result.path);
  const metaEntry = entries.find((entry) => entry.name === 'instance.json');
  const parsed = JSON.parse((await readZipEntry(result.path, metaEntry)).toString());
  const fromZip = validateExportManifest(parsed);
  assert.equal(fromZip.format, undefined);
  assert.equal(fromZip.loader, 'fabric');
  assert.equal(fromZip.minecraftVersion, '1.20.1');
});
