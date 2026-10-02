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

import {
  ChecksumMismatchError,
  NotFoundError,
  SourceNotAllowedError,
  UpstreamError,
  ValidationError,
} from '../../src/core/errors.js';
import { hashBuffer } from '../../src/download/hash.js';
import { createInstanceManager } from '../../src/instance/manager.js';
import {
  createModInstaller,
  pickModFiles,
  safeModFilename,
} from '../../src/mods/install.js';

const localOnly = (input) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new SourceNotAllowedError(`Host not allowed: ${url.hostname}`, {
      details: { host: url.hostname },
    });
  }
  return url;
};

const sodiumBytes = Buffer.from('sodium mod jar bytes v1\n'.repeat(4));
const sodiumV2Bytes = Buffer.from('sodium mod jar bytes v2\n'.repeat(4));
const irisBytes = Buffer.from('iris mod jar bytes\n'.repeat(4));
const sodiumBytesHashes = hashBuffer(sodiumBytes, ['sha1', 'sha512']);
const sodiumV2Hashes = hashBuffer(sodiumV2Bytes, ['sha1', 'sha512']);
const irisHashes = hashBuffer(irisBytes, ['sha1', 'sha512']);

const sodiumFile = {
  filename: 'sodium-1.jar',
  url: 'PLACEHOLDER/sodium-1.jar',
  primary: true,
  size: sodiumBytes.length,
  sha1: sodiumBytesHashes.sha1,
  sha512: sodiumBytesHashes.sha512,
};

function makeVersion(id, projectId, files) {
  return {
    id,
    projectId,
    versionNumber: '1.0.0',
    name: id,
    changelog: '',
    gameVersions: ['1.20.1'],
    loaders: ['fabric'],
    versionType: 'release',
    status: 'listed',
    datePublished: '2026-01-01T00:00:00Z',
    downloads: 1,
    featured: false,
    files,
    dependencies: [],
  };
}

let server;
let baseUrl;
const hits = new Map();
const routes = new Map();

function register(route, bytes) {
  routes.set(route, bytes);
}

before(async () => {
  register('/files/sodium-1.jar', sodiumBytes);
  register('/files/sodium-2.jar', sodiumV2Bytes);
  register('/files/iris-1.jar', irisBytes);
  register('/files/shared-a.jar', sodiumBytes);
  register('/files/shared-b.jar', sodiumV2Bytes);
  register('/files/wrong-hash.jar', sodiumBytes);
  register('/files/extra-sources.jar', irisBytes);

  server = http.createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
    const bytes = routes.get(req.url);
    if (!bytes) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/java-archive',
      'content-length': String(bytes.length),
    });
    res.end(bytes);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  sodiumFile.url = `${baseUrl}/files/sodium-1.jar`;
});

after(() => {
  server?.close();
});

function hitCount(route) {
  return hits.get(route) ?? 0;
}

function createFakeModrinth(versions) {
  const calls = [];
  return {
    calls,
    async getVersion(id) {
      calls.push(id);
      const version = versions[id];
      if (!version) {
        throw new NotFoundError(`Modrinth version not found: ${id}`, {
          code: 'MODRINTH_VERSION_NOT_FOUND',
          details: { id },
        });
      }
      return version;
    },
  };
}

function setup({ versions = {} } = {}) {
  hits.clear();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-mod-'));
  const manager = createInstanceManager({ instancesDir: dir });
  const modrinth = createFakeModrinth(versions);
  const modInstaller = createModInstaller({
    manager,
    modrinth,
    validator: localOnly,
    retries: 0,
  });
  return { dir, manager, modrinth, modInstaller };
}

function versionFixtures(baseUrlOverride = baseUrl) {
  return {
    SODIUM: makeVersion('SODIUM', 'PRJSODIUM', [
      { ...sodiumFile, url: `${baseUrlOverride}/files/sodium-1.jar` },
      {
        filename: 'extra-sources.jar',
        url: `${baseUrlOverride}/files/extra-sources.jar`,
        primary: false,
        size: irisBytes.length,
        sha1: irisHashes.sha1,
        sha512: irisHashes.sha512,
      },
    ]),
    IRIS: makeVersion('IRIS', 'PRJIRIS', [
      {
        filename: 'iris-1.jar',
        url: `${baseUrlOverride}/files/iris-1.jar`,
        primary: true,
        size: irisBytes.length,
        sha1: irisHashes.sha1,
        sha512: irisHashes.sha512,
      },
    ]),
    SHARED_V1: makeVersion('SHARED_V1', 'PRJSHARED', [
      {
        filename: 'shared.jar',
        url: `${baseUrlOverride}/files/shared-a.jar`,
        primary: true,
        size: sodiumBytes.length,
        sha1: sodiumBytesHashes.sha1,
        sha512: sodiumBytesHashes.sha512,
      },
    ]),
    SHARED_V2: makeVersion('SHARED_V2', 'PRJSHARED', [
      {
        filename: 'shared.jar',
        url: `${baseUrlOverride}/files/shared-b.jar`,
        primary: true,
        size: sodiumV2Bytes.length,
        sha1: sodiumV2Hashes.sha1,
        sha512: sodiumV2Hashes.sha512,
      },
    ]),
    WRONG_HASH: makeVersion('WRONG_HASH', 'PRJWRONG', [
      {
        filename: 'wrong-hash.jar',
        url: `${baseUrlOverride}/files/wrong-hash.jar`,
        primary: true,
        size: sodiumBytes.length,
        sha1: '0'.repeat(40),
        sha512: null,
      },
    ]),
    MISSING_ROUTE: makeVersion('MISSING_ROUTE', 'PRJMISSING', [
      {
        filename: 'missing-404.jar',
        url: `${baseUrlOverride}/files/does-not-exist.jar`,
        primary: true,
        size: 10,
        sha1: '1'.repeat(40),
        sha512: null,
      },
    ]),
    NO_FILES: makeVersion('NO_FILES', 'PRJEMPTY', []),
    UNSAFE_NAME: makeVersion('UNSAFE_NAME', 'PRJUNSAFE', [
      {
        filename: '../evil.jar',
        url: `${baseUrlOverride}/files/sodium-1.jar`,
        primary: true,
        size: sodiumBytes.length,
        sha1: sodiumBytesHashes.sha1,
        sha512: sodiumBytesHashes.sha512,
      },
    ]),
  };
}

test('install downloads the primary mod file into the selected instance mods dir', async () => {
  const { manager, modInstaller } = setup({ versions: versionFixtures() });
  const meta = await manager.create({ name: 'Mod A', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });

  const result = await modInstaller.install(meta.id, 'SODIUM');

  assert.equal(result.installed, true);
  assert.equal(result.skipped, false);
  assert.equal(result.projectId, 'PRJSODIUM');
  assert.equal(result.versionId, 'SODIUM');
  assert.equal(result.versionNumber, '1.0.0');

  const modsDir = manager.paths(meta.id).modsDir;
  const dest = path.join(modsDir, 'sodium-1.jar');
  assert.ok(dest.startsWith(manager.paths(meta.id).dir), 'mod must live inside the instance');
  assert.deepEqual(fs.readFileSync(dest), sodiumBytes);
  assert.equal(fs.existsSync(path.join(modsDir, 'extra-sources.jar')), false, 'non-primary file must not install');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].filename, 'sodium-1.jar');
  assert.equal(result.files[0].cached, false);
  assert.equal(result.files[0].bytes, sodiumBytes.length);
  assert.equal(result.files[0].sha1, sodiumBytesHashes.sha1);
  assert.equal(hitCount('/files/sodium-1.jar'), 1);
});

test('install is idempotent through hash cache and force re-downloads', async () => {
  const { manager, modInstaller } = setup({ versions: versionFixtures() });
  const meta = await manager.create({ name: 'Idem', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });

  const first = await modInstaller.install(meta.id, 'SODIUM');
  const second = await modInstaller.install(meta.id, 'SODIUM');
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(second.files[0].cached, true);
  assert.equal(hitCount('/files/sodium-1.jar'), 1, 'second install must not hit the network');

  const forced = await modInstaller.install(meta.id, 'SODIUM', { force: true });
  assert.equal(forced.skipped, false);
  assert.equal(forced.files[0].cached, false);
  assert.equal(hitCount('/files/sodium-1.jar'), 2, 'force must re-download');
});

test('mods stay isolated between instances', async () => {
  const { manager, modInstaller } = setup({ versions: versionFixtures() });
  const a = await manager.create({ name: 'Instance A', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });
  const b = await manager.create({ name: 'Instance B', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });

  await modInstaller.install(a.id, 'SODIUM');
  const fileA = path.join(manager.paths(a.id).modsDir, 'sodium-1.jar');
  const snapshotA = fs.readFileSync(fileA, 'utf8');

  await modInstaller.install(b.id, 'IRIS');
  const fileB = path.join(manager.paths(b.id).modsDir, 'iris-1.jar');

  assert.notEqual(manager.paths(a.id).modsDir, manager.paths(b.id).modsDir);
  assert.deepEqual(fs.readFileSync(fileB), irisBytes);
  assert.equal(fs.readFileSync(fileA, 'utf8'), snapshotA, 'installing into B must not touch A');
  assert.equal(fs.existsSync(path.join(manager.paths(a.id).modsDir, 'iris-1.jar')), false, 'iris must not leak into A');
  assert.equal(fs.existsSync(path.join(manager.paths(b.id).modsDir, 'sodium-1.jar')), false, 'sodium must not leak into B');

  const listA = await modInstaller.list(a.id);
  assert.deepEqual(listA.map((mod) => mod.filename), ['sodium-1.jar']);
  assert.equal(listA[0].size, sodiumBytes.length);
  const listB = await modInstaller.list(b.id);
  assert.deepEqual(listB.map((mod) => mod.filename), ['iris-1.jar']);

  const statusSodiumA = await modInstaller.status(a.id, 'SODIUM');
  assert.equal(statusSodiumA.installed, true);
  const statusIrisA = await modInstaller.status(a.id, 'IRIS');
  assert.equal(statusIrisA.installed, false);
  assert.deepEqual(statusIrisA.files.map((file) => file.present), [false]);
  const statusIrisB = await modInstaller.status(b.id, 'IRIS');
  assert.equal(statusIrisB.installed, true);
});

test('install replaces a same-name file coming from a newer version', async () => {
  const { manager, modInstaller } = setup({ versions: versionFixtures() });
  const meta = await manager.create({ name: 'Update', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });
  const dest = path.join(manager.paths(meta.id).modsDir, 'shared.jar');

  await modInstaller.install(meta.id, 'SHARED_V1');
  assert.deepEqual(fs.readFileSync(dest), sodiumBytes);

  const second = await modInstaller.install(meta.id, 'SHARED_V2');
  assert.equal(second.skipped, false);
  assert.equal(second.files[0].cached, false, 'hash mismatch must trigger a re-download');
  assert.deepEqual(fs.readFileSync(dest), sodiumV2Bytes);
  assert.equal(hitCount('/files/shared-a.jar'), 1);
  assert.equal(hitCount('/files/shared-b.jar'), 1);

  assert.equal((await modInstaller.status(meta.id, 'SHARED_V2')).installed, true);
  assert.equal((await modInstaller.status(meta.id, 'SHARED_V1')).installed, false);
});

test('status reports missing, installed and tampered files', async () => {
  const { manager, modInstaller } = setup({ versions: versionFixtures() });
  const meta = await manager.create({ name: 'Status', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });

  const beforeInstall = await modInstaller.status(meta.id, 'SODIUM');
  assert.equal(beforeInstall.installed, false);
  assert.deepEqual(beforeInstall.files, [
    {
      filename: 'sodium-1.jar',
      path: path.join(manager.paths(meta.id).modsDir, 'sodium-1.jar'),
      present: false,
      verified: false,
    },
  ]);

  await modInstaller.install(meta.id, 'SODIUM');
  const installed = await modInstaller.status(meta.id, 'SODIUM');
  assert.equal(installed.installed, true);
  assert.deepEqual(installed.files.map((file) => ({ present: file.present, verified: file.verified })), [
    { present: true, verified: true },
  ]);

  const dest = path.join(manager.paths(meta.id).modsDir, 'sodium-1.jar');
  fs.writeFileSync(dest, 'tampered content');
  const tampered = await modInstaller.status(meta.id, 'SODIUM');
  assert.equal(tampered.installed, false);
  assert.equal(tampered.files[0].present, true);
  assert.equal(tampered.files[0].verified, false);
});

test('filename and file selection guards keep the mods dir safe', async () => {
  assert.equal(safeModFilename('fabric-api-0.161.2+26.4.jar'), 'fabric-api-0.161.2+26.4.jar');
  assert.equal(safeModFilename('My Mod (1.2).jar'), 'My Mod (1.2).jar');

  for (const bad of ['../evil.jar', 'a/b.jar', 'a\\b.jar', '..', '.', '', 'x\u0000y', 'x\u001fy', 'n'.repeat(201)]) {
    assert.throws(
      () => safeModFilename(bad),
      (err) => err instanceof ValidationError && err.code === 'INVALID_MOD_FILENAME',
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }

  const primary = { filename: 'a.jar', primary: true };
  const secondary = { filename: 'b.jar', primary: false };
  assert.deepEqual(pickModFiles({ files: [primary, secondary] }), [primary]);
  assert.deepEqual(pickModFiles({ files: [secondary, primary] }), [primary]);
  assert.deepEqual(pickModFiles({ files: [secondary] }), [secondary]);
  assert.deepEqual(pickModFiles({ files: [] }), []);
  assert.deepEqual(pickModFiles({}), []);

  const { manager, modInstaller } = setup({ versions: versionFixtures() });
  const meta = await manager.create({ name: 'Unsafe', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });
  await assert.rejects(modInstaller.install(meta.id, 'UNSAFE_NAME'), { code: 'INVALID_MOD_FILENAME' });
  assert.equal(hitCount('/files/sodium-1.jar'), 0, 'unsafe filename must fail before any download');
});

test('install and list surface instance, version and download errors', async () => {
  const versions = versionFixtures();
  const { manager, modrinth, modInstaller } = setup({ versions });

  await assert.rejects(modInstaller.install('missing1', 'SODIUM'), { code: 'INSTANCE_NOT_FOUND', status: 404 });
  await assert.rejects(modInstaller.list('missing1'), { code: 'INSTANCE_NOT_FOUND', status: 404 });

  const meta = await manager.create({ name: 'Errors', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });
  await assert.rejects(modInstaller.install(meta.id, 'NOPE'), (err) => err instanceof NotFoundError && err.code === 'MODRINTH_VERSION_NOT_FOUND');
  assert.equal(modrinth.calls[0], 'NOPE', 'missing instance must fail before any metadata call');

  await assert.rejects(modInstaller.install(meta.id, 'NO_FILES'), { code: 'MOD_VERSION_NO_FILES' });
  const emptyStatus = await modInstaller.status(meta.id, 'NO_FILES');
  assert.equal(emptyStatus.installed, false);
  assert.deepEqual(emptyStatus.files, []);

  await assert.rejects(modInstaller.install(meta.id, 'MISSING_ROUTE'), (err) => err instanceof UpstreamError && err.upstreamStatus === 404);
  await assert.rejects(modInstaller.install(meta.id, 'WRONG_HASH'), (err) => err instanceof ChecksumMismatchError);

  assert.throws(() => createModInstaller(), (err) => err instanceof ValidationError && err.code === 'INVALID_INSTANCE_MANAGER');
  assert.throws(
    () => createModInstaller({ manager, modrinth: {} }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_MODRINTH_API',
  );

  assert.deepEqual(await modInstaller.list(meta.id), [], 'empty mods dir lists nothing');
});

test('live: installs fabric-api into a real instance with hash verification', { skip: !process.env.TML_LIVE }, async () => {
  const { createModrinthApi } = await import('../../src/modrinth/api.js');

  const modrinth = createModrinthApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-mod-live-'));
  const manager = createInstanceManager({ instancesDir: dir });
  const modInstaller = createModInstaller({ manager, modrinth });

  const versions = await modrinth.listVersions('fabric-api', { gameVersions: ['1.20.1'], loaders: ['fabric'], limit: 5 });
  const target = versions.find((version) => version.versionType === 'release' && version.files.length > 0);
  assert.ok(target, 'expected a fabric-api release for 1.20.1');
  const file = target.files.find((entry) => entry.primary) ?? target.files[0];

  const meta = await manager.create({ name: 'Live Mod', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });
  const result = await modInstaller.install(meta.id, target.id);
  assert.equal(result.installed, true);
  assert.equal(result.skipped, false);
  assert.equal(result.projectId, 'P7dR8mSH');
  assert.equal(result.files[0].filename, file.filename);

  const dest = path.join(manager.paths(meta.id).modsDir, file.filename);
  assert.ok(fs.existsSync(dest));
  assert.equal(fs.statSync(dest).size, file.size);

  const status = await modInstaller.status(meta.id, target.id);
  assert.equal(status.installed, true);

  const again = await modInstaller.install(meta.id, target.id);
  assert.equal(again.skipped, true);

  const mods = await modInstaller.list(meta.id);
  assert.deepEqual(mods.map((mod) => mod.filename), [file.filename]);
});
