// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { SourceNotAllowedError } from '../../src/core/errors.js';
import { hashBuffer, hashFile } from '../../src/download/hash.js';
import { writeZipFile } from '../../src/archive/zip.js';
import { listZipEntries, readZipEntry } from '../../src/archive/unzip.js';
import { createInstanceManager } from '../../src/instance/manager.js';
import { createInstanceExporter } from '../../src/instance/export.js';
import { createInstanceImporter } from '../../src/instance/import.js';
import { createModpackExporter, buildModpackIndex, MODPACK_INDEX_FILE } from '../../src/modpack/export.js';
import { createModInstaller } from '../../src/mods/install.js';
import { readModRegistry, recordInstalledMods } from '../../src/mods/registry.js';

const localOnly = (input) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new SourceNotAllowedError(`Host not allowed: ${url.hostname}`, {
      details: { host: url.hostname },
    });
  }
  return url;
};

const BASE = Object.freeze({
  minecraftVersion: '1.20.1',
  fabricLoaderVersion: '0.15.7',
});

const SODIUM_BYTES = Buffer.from('sodium jar bytes for pack\n'.repeat(4));
const IRIS_BYTES = Buffer.from('iris jar bytes for pack\n'.repeat(4));
const SODIUM_URL = 'https://cdn.modrinth.com/data/AAA/versions/1.0.0/sodium.jar';

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

let root;
let instancesDir;
let exportsDir;
let manager;
let modpackExporter;
let instanceExporter;
let importer;
let pack;
let plain;
const warns = [];

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-modpack-'));
  instancesDir = path.join(root, 'instances');
  exportsDir = path.join(root, 'exports');
  const logger = { warn: (...args) => warns.push(args), info() {}, debug() {} };

  manager = createInstanceManager({ instancesDir, launcher: createFakeLauncher(), fabric: createFakeFabric() });
  modpackExporter = createModpackExporter({ manager, writeZip: writeZipFile, exportsDir, logger });
  instanceExporter = createInstanceExporter({ manager, writeZip: writeZipFile, exportsDir, logger });
  importer = createInstanceImporter({ manager, tempRoot: path.join(root, 'tmp'), logger });

  pack = await manager.create({ name: 'Speedrun', id: 'pack1', ...BASE });
  const paths = manager.paths(pack.id);
  fs.writeFileSync(path.join(paths.modsDir, 'sodium.jar'), SODIUM_BYTES);
  fs.writeFileSync(path.join(paths.modsDir, 'iris.jar'), IRIS_BYTES);

  const sodiumHashes = await hashFile(path.join(paths.modsDir, 'sodium.jar'), ['sha1', 'sha512']);
  await recordInstalledMods(paths.dir, { projectId: 'sodiumproj', id: 'sodiumver', versionNumber: '1.0.0' }, [
    { filename: 'sodium.jar', url: SODIUM_URL, sha1: sodiumHashes.sha1, sha512: sodiumHashes.sha512, size: SODIUM_BYTES.length },
  ]);

  plain = await manager.create({ name: 'VanillaOnly', id: 'plain1', ...BASE });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('plan builds a Modrinth-format index with hashes and dependencies', async () => {
  const plan = await modpackExporter.plan(pack.id);

  assert.ok(Object.isFrozen(plan));
  assert.equal(plan.modCount, 2);
  assert.equal(plan.fileCount, 3);
  assert.equal(plan.name, 'Speedrun');
  assert.deepEqual(plan.entries.map((entry) => entry.name), [MODPACK_INDEX_FILE, 'mods/iris.jar', 'mods/sodium.jar']);
  assert.equal(plan.totalBytes, plan.entries.reduce((sum, entry) => sum + entry.size, 0));

  const index = plan.index;
  assert.ok(Object.isFrozen(index));
  assert.equal(index.formatVersion, 1);
  assert.equal(index.game, 'minecraft');
  assert.equal(index.versionId, 'pack1');
  assert.equal(index.name, 'Speedrun');
  assert.deepEqual({ ...index.dependencies }, { minecraft: '1.20.1', 'fabric-loader': '0.15.7' });

  assert.deepEqual(index.files.map((file) => file.path), ['mods/iris.jar', 'mods/sodium.jar']);
  const [iris, sodium] = index.files;
  assert.deepEqual({ ...iris.env }, { client: 'required', server: 'unsupported' });
  assert.deepEqual(iris.downloads, [], 'jars without a registry record carry no urls');
  assert.deepEqual(sodium.downloads, [SODIUM_URL]);

  const paths = manager.paths(pack.id);
  const irisHashes = await hashFile(path.join(paths.modsDir, 'iris.jar'), ['sha1', 'sha512']);
  assert.equal(iris.hashes.sha1, irisHashes.sha1);
  assert.equal(iris.hashes.sha512, irisHashes.sha512);
  assert.equal(iris.fileSize, IRIS_BYTES.length);
  assert.equal(sodium.hashes.sha1, (await hashFile(path.join(paths.modsDir, 'sodium.jar'), ['sha1'])).sha1);
  assert.equal(sodium.fileSize, SODIUM_BYTES.length);
});

test('export writes a self-contained modpack zip kept apart from instance export', async () => {
  const result = await modpackExporter.export(pack.id);
  assert.ok(Object.isFrozen(result));
  assert.equal(result.filename, 'Speedrun-modpack.zip');
  assert.equal(result.path, path.join(exportsDir, 'Speedrun-modpack.zip'));
  assert.equal(result.mods, 2);
  assert.equal(result.files, 3);
  assert.equal(result.sha1, (await hashFile(result.path, ['sha1'])).sha1);
  assert.equal(result.bytes, fs.statSync(result.path).size);

  const plan = await modpackExporter.plan(pack.id);
  const entries = await listZipEntries(result.path);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [MODPACK_INDEX_FILE, 'mods/iris.jar', 'mods/sodium.jar']);

  const indexBytes = await readZipEntry(result.path, entries.find((entry) => entry.name === MODPACK_INDEX_FILE));
  assert.equal(indexBytes.toString(), `${JSON.stringify(plan.index, null, 2)}\n`);
  assert.deepEqual(JSON.parse(indexBytes.toString()), { ...plan.index });

  const sodiumEntry = entries.find((entry) => entry.name === 'mods/sodium.jar');
  assert.equal((await readZipEntry(result.path, sodiumEntry)).equals(SODIUM_BYTES), true);

  const instanceZip = await instanceExporter.export(pack.id, { force: true });
  const instanceEntries = await listZipEntries(instanceZip.path);
  assert.equal(instanceEntries.some((entry) => entry.name === MODPACK_INDEX_FILE), false, 'instance export never carries the modpack index');

  await assert.rejects(importer.inspect(result.path), (err) => err.code === 'IMPORT_UNKNOWN_ENTRY' && err.details.entry === MODPACK_INDEX_FILE);
  const { manifest } = await importer.inspect(instanceZip.path);
  assert.equal(manifest.name, 'Speedrun', 'the instance zip still imports directly');
});

test('modpack export follows collision, naming and running rules', async () => {
  await assert.rejects(modpackExporter.export(pack.id), (err) => err.code === 'MODPACK_EXISTS' && err.status === 409);
  const forced = await modpackExporter.export(pack.id, { force: true });
  assert.equal(forced.filename, 'Speedrun-modpack.zip');

  const renamed = await modpackExporter.export(pack.id, { name: 'My/Pack', force: true });
  assert.equal(renamed.filename, 'My_Pack-modpack.zip');

  await assert.rejects(modpackExporter.export(pack.id, { name: 42 }), (err) => err.code === 'INVALID_EXPORT_NAME');

  const emptyPlan = await modpackExporter.plan(plain.id);
  assert.equal(emptyPlan.modCount, 0);
  assert.deepEqual(emptyPlan.index.files, []);
  const emptyZip = await modpackExporter.export(plain.id);
  assert.equal(emptyZip.mods, 0);
  const entries = await listZipEntries(emptyZip.path);
  assert.deepEqual(entries.map((entry) => entry.name), [MODPACK_INDEX_FILE]);

  await manager.launch(pack.id);
  try {
    await assert.rejects(modpackExporter.export(pack.id, { force: true }), (err) => err.code === 'INSTANCE_RUNNING' && err.status === 409);
  } finally {
    await manager.stop(pack.id);
  }
});

test('a corrupt registry falls back to an index without urls', async () => {
  const paths = manager.paths(pack.id);
  const registryFile = path.join(paths.dir, 'mod-registry.json');
  const backup = fs.readFileSync(registryFile, 'utf8');
  fs.writeFileSync(registryFile, '{not json');
  warns.length = 0;

  try {
    const plan = await modpackExporter.plan(pack.id);
    assert.equal(plan.modCount, 2);
    assert.deepEqual(plan.index.files.map((file) => file.downloads), [[], []]);
    assert.ok(warns.length > 0, 'the fallback must be logged');
  } finally {
    fs.writeFileSync(registryFile, backup);
  }

  const restored = await modpackExporter.plan(pack.id);
  assert.deepEqual(restored.index.files.find((file) => file.path === 'mods/sodium.jar').downloads, [SODIUM_URL]);
});

test('install records a mod registry entry that modpack export picks up', async () => {
  const jarBytes = Buffer.from('recorded mod jar\n'.repeat(4));
  const server = http.createServer((req, res) => {
    if (req.url === '/files/recorded.jar') {
      res.writeHead(200, { 'content-type': 'application/java-archive' });
      res.end(jarBytes);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const jarHashes = hashBuffer(jarBytes, ['sha1', 'sha512']);
    const modrinth = {
      async getVersion(versionId) {
        return {
          id: versionId,
          projectId: 'recordedproj',
          versionNumber: '2.0.0',
          gameVersions: ['1.20.1'],
          loaders: ['fabric'],
          files: [
            {
              filename: 'recorded.jar',
              url: `${base}/files/recorded.jar`,
              primary: true,
              size: jarBytes.length,
              sha1: jarHashes.sha1,
              sha512: jarHashes.sha512,
            },
          ],
          dependencies: [],
        };
      },
    };
    const installer = createModInstaller({ manager, modrinth, validator: localOnly });
    const installed = await installer.install(plain.id, 'recorded-1');
    assert.equal(installed.installed, true);

    const registry = await readModRegistry(manager.paths(plain.id).dir);
    assert.equal(Object.hasOwn(registry, 'recorded.jar'), true);
    const record = registry['recorded.jar'];
    assert.equal(record.projectId, 'recordedproj');
    assert.equal(record.versionId, 'recorded-1');
    assert.equal(record.versionNumber, '2.0.0');
    assert.equal(record.url, `${base}/files/recorded.jar`);
    assert.equal(record.sha1, (await hashFile(path.join(manager.paths(plain.id).modsDir, 'recorded.jar'), ['sha1'])).sha1);

    const plan = await modpackExporter.plan(plain.id);
    const file = plan.index.files.find((entry) => entry.path === 'mods/recorded.jar');
    assert.deepEqual(file.downloads, [`${base}/files/recorded.jar`]);
    assert.equal(file.hashes.sha1, record.sha1);
    assert.equal(file.fileSize, jarBytes.length);
  } finally {
    server.close();
  }
});

test('index builder and exporter reject secret metadata and bad collaborators', async () => {
  const realMeta = await manager.get(pack.id);
  assert.throws(
    () => buildModpackIndex({ meta: { ...realMeta, accessToken: 'x' }, mods: [], registry: {} }),
    (err) => err.code === 'EXPORT_FORBIDDEN_DATA',
  );
  assert.throws(
    () => buildModpackIndex({ meta: { ...realMeta, auth: { refreshToken: 'y' } }, mods: [], registry: {} }),
    (err) => err.code === 'EXPORT_FORBIDDEN_DATA',
  );

  assert.throws(() => createModpackExporter({}), (err) => err.code === 'INVALID_INSTANCE_MANAGER');
  assert.throws(() => createModpackExporter({ manager: { get() {}, paths() {} } }), (err) => err.code === 'INVALID_INSTANCE_MANAGER');
  assert.throws(() => createModpackExporter({ manager }), (err) => err.code === 'NO_ZIP_WRITER');
  assert.throws(() => createModpackExporter({ manager, writeZip: writeZipFile }), (err) => err.code === 'INVALID_EXPORTS_DIR');

  await assert.rejects(modpackExporter.plan('nope'), (err) => err.code === 'INSTANCE_NOT_FOUND' && err.status === 404);
  await assert.rejects(modpackExporter.export('nope'), (err) => err.code === 'INSTANCE_NOT_FOUND' && err.status === 404);
});
