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
import { readModRegistry } from '../../src/mods/registry.js';
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

function createCheckableModrinth({ versions = {}, versionFiles = {}, versionLists = {} } = {}) {
  const base = createFakeModrinth(versions);
  const hashCalls = [];
  const listVersionCalls = [];
  return {
    calls: base.calls,
    getVersion: base.getVersion,
    hashCalls,
    listVersionCalls,
    async getVersionFiles(hashes) {
      hashCalls.push([...hashes]);
      const found = {};
      for (const hash of hashes) {
        if (versionFiles[hash]) found[hash] = versionFiles[hash];
      }
      return found;
    },
    async listVersions(projectId, options) {
      listVersionCalls.push({ projectId, options });
      const list = versionLists[projectId];
      if (!list) {
        throw new NotFoundError(`Modrinth project not found: ${projectId}`, {
          code: 'MODRINTH_PROJECT_NOT_FOUND',
          details: { id: projectId },
        });
      }
      return list;
    },
  };
}

function setup({ versions = {}, modrinth = null } = {}) {
  hits.clear();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-mod-'));
  const manager = createInstanceManager({ instancesDir: dir });
  const modrinthApi = modrinth ?? createFakeModrinth(versions);
  const modInstaller = createModInstaller({
    manager,
    modrinth: modrinthApi,
    validator: localOnly,
    retries: 0,
  });
  return { dir, manager, modrinth: modrinthApi, modInstaller };
}

async function placeFile(manager, instanceId, kind, filename, bytes) {
  const dir =
    kind === 'mods' ? manager.paths(instanceId).modsDir : path.join(manager.paths(instanceId).gameDir, kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), bytes);
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

test('check adopts hand-placed jars via hash, flags updates and honors adopt:false', async () => {
  const adoptedVersion = {
    ...makeVersion('SODIUM_OLD', 'PRJSODIUM', [{ ...sodiumFile }]),
    versionNumber: '0.9.0',
  };
  const newerVersion = makeVersion('SODIUM_NEW', 'PRJSODIUM', [{ ...sodiumFile }]);
  const modrinth = createCheckableModrinth({
    versionFiles: { [sodiumBytesHashes.sha1]: adoptedVersion },
    versionLists: { PRJSODIUM: [newerVersion, adoptedVersion] },
  });
  const { manager, modInstaller } = setup({ modrinth });
  const meta = await manager.create({ name: 'Check', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });
  await placeFile(manager, meta.id, 'mods', 'sodium-1.jar', sodiumBytes);

  const noAdopt = await modInstaller.check(meta.id, { adopt: false });
  assert.equal(noAdopt.instanceId, meta.id);
  assert.equal(noAdopt.kind, 'mods');
  assert.equal(noAdopt.checked, 1);
  assert.deepEqual(noAdopt.adopted, [], 'adopt:false must not query Modrinth by hash');
  assert.equal(noAdopt.files[0].status, 'unmatched');
  assert.equal(noAdopt.updateCount, 0);
  assert.equal(modrinth.hashCalls.length, 0);

  const progress = [];
  const first = await modInstaller.check(meta.id, {
    onProgress: (event) => progress.push(event),
  });
  assert.deepEqual(first.adopted, ['sodium-1.jar']);
  assert.equal(first.files[0].status, 'checked');
  assert.equal(first.files[0].projectId, 'PRJSODIUM');
  assert.equal(first.files[0].versionId, 'SODIUM_OLD');
  assert.equal(first.files[0].versionNumber, '0.9.0');
  assert.equal(first.files[0].updateAvailable, true);
  assert.deepEqual(first.files[0].latest, { versionId: 'SODIUM_NEW', versionNumber: '1.0.0' });
  assert.equal(first.updateCount, 1);
  assert.deepEqual(first.updates, [
    {
      filename: 'sodium-1.jar',
      projectId: 'PRJSODIUM',
      from: '0.9.0',
      to: '1.0.0',
      versionId: 'SODIUM_NEW',
    },
  ]);
  assert.deepEqual(modrinth.listVersionCalls[0].options, {
    gameVersions: ['1.20.1'],
    loaders: ['fabric'],
  });

  const registry = await readModRegistry(manager.paths(meta.id).dir);
  assert.equal(registry['sodium-1.jar'].versionId, 'SODIUM_OLD');
  assert.equal(registry['sodium-1.jar'].kind, 'mods');

  assert.deepEqual(
    progress.map((event) => event.phase),
    ['scan', 'hash', 'lookup', 'lookup', 'compare', 'done'],
    'progress walks scan → hash → lookup → compare → done',
  );
  const hashPhase = progress.find((event) => event.phase === 'hash');
  assert.equal(hashPhase.total, 1, 'one unverified file to hash');
  const comparePhase = progress.find((event) => event.phase === 'compare');
  assert.equal(comparePhase.total, 1, 'one file to compare');
  for (const event of progress) {
    assert.equal(typeof event.message, 'string');
    assert.ok(event.message.length > 0);
    assert.ok(event.total >= 1);
  }

  const second = await modInstaller.check(meta.id);
  assert.deepEqual(second.adopted, [], 'already-tracked files must not hash again');
  assert.equal(second.updateCount, 1, 'the tracked version is still behind');

  await placeFile(manager, meta.id, 'mods', 'mystery.jar', Buffer.from('mystery jar'));
  const third = await modInstaller.check(meta.id);
  const mystery = third.files.find((entry) => entry.filename === 'mystery.jar');
  assert.equal(mystery.status, 'unmatched');
  assert.equal(third.checked, 2);

  await assert.rejects(modInstaller.check('missing1'), { code: 'INSTANCE_NOT_FOUND', status: 404 });
  await assert.rejects(modInstaller.check(meta.id, { kind: 'bogus' }), { code: 'INVALID_PACK_KIND' });
});

test('check honors a minecraftVersion override and reports incompatible and unavailable', async () => {
  const adoptedVersion = {
    ...makeVersion('SODIUM_OLD', 'PRJSODIUM', [{ ...sodiumFile }]),
    versionNumber: '0.9.0',
  };
  const newerVersion = makeVersion('SODIUM_NEW', 'PRJSODIUM', [{ ...sodiumFile }]);

  // (1) preview: listVersions must filter on the candidate, and the instance must keep its stored version
  const overrideApi = createCheckableModrinth({
    versionFiles: { [sodiumBytesHashes.sha1]: adoptedVersion },
    versionLists: { PRJSODIUM: [newerVersion, adoptedVersion] },
  });
  const overrideSetup = setup({ modrinth: overrideApi });
  const overrideMeta = await overrideSetup.manager.create({
    name: 'Override',
    minecraftVersion: '1.20.1',
    fabricLoaderVersion: '0.15.7',
  });
  await placeFile(overrideSetup.manager, overrideMeta.id, 'mods', 'sodium-1.jar', sodiumBytes);
  const preview = await overrideSetup.modInstaller.check(overrideMeta.id, { minecraftVersion: '1.19.4' });
  assert.deepEqual(overrideApi.listVersionCalls[0].options, {
    gameVersions: ['1.19.4'],
    loaders: ['fabric'],
  });
  assert.equal(preview.checked, 1);
  assert.equal(preview.files[0].status, 'checked');
  assert.equal(
    (await overrideSetup.manager.get(overrideMeta.id)).minecraftVersion,
    '1.20.1',
    'a preview check must not persist the candidate version',
  );

  // (2) incompatible: the fetch succeeds but nothing matches the candidate version
  const emptyApi = createCheckableModrinth({
    versionFiles: { [sodiumBytesHashes.sha1]: adoptedVersion },
    versionLists: { PRJSODIUM: [] },
  });
  const emptySetup = setup({ modrinth: emptyApi });
  const emptyMeta = await emptySetup.manager.create({
    name: 'Incompatible',
    minecraftVersion: '1.20.1',
    fabricLoaderVersion: '0.15.7',
  });
  await placeFile(emptySetup.manager, emptyMeta.id, 'mods', 'sodium-1.jar', sodiumBytes);
  const incompat = await emptySetup.modInstaller.check(emptyMeta.id, { minecraftVersion: '1.18.2' });
  assert.equal(incompat.files[0].status, 'incompatible');
  assert.equal(incompat.incompatible, 1);
  assert.equal(incompat.updateCount, 0);

  // (3) unavailable: the version list cannot be fetched at all (network/404 after retries)
  const failApi = createCheckableModrinth({
    versionFiles: { [sodiumBytesHashes.sha1]: adoptedVersion },
  });
  const failSetup = setup({ modrinth: failApi });
  const failMeta = await failSetup.manager.create({
    name: 'Unavailable',
    minecraftVersion: '1.20.1',
    fabricLoaderVersion: '0.15.7',
  });
  await placeFile(failSetup.manager, failMeta.id, 'mods', 'sodium-1.jar', sodiumBytes);
  const failed = await failSetup.modInstaller.check(failMeta.id, { minecraftVersion: '1.17.1' });
  assert.equal(failed.files[0].status, 'unavailable');
  assert.equal(failed.unavailable, 1);
  assert.equal(failed.updateCount, 0);
});

test('check fetches versions in parallel, caches repeat lookups and retries a rate-limited project', async () => {
  const parallelFiles = Array.from({ length: 8 }, (_, i) => {
    const bytes = Buffer.from(`parallel mod ${i} content\n`.repeat(4));
    return {
      i,
      bytes,
      filename: `parallel-${i}.jar`,
      projectId: `PRJPAR${i}`,
      hashes: hashBuffer(bytes, ['sha1', 'sha512']),
    };
  });
  const versionLists = {};
  const versionFiles = {};
  for (const file of parallelFiles) {
    const oldVersion = makeVersion(`PAR_OLD_${file.i}`, file.projectId, [
      {
        filename: file.filename,
        url: `${baseUrl}/files/sodium-1.jar`,
        primary: true,
        size: file.bytes.length,
        sha1: file.hashes.sha1,
        sha512: file.hashes.sha512,
      },
    ]);
    const newVersion = { ...makeVersion(`PAR_NEW_${file.i}`, file.projectId, []), versionNumber: '2.0.0' };
    versionFiles[file.hashes.sha1] = oldVersion;
    versionLists[file.projectId] = [newVersion, oldVersion];
  }
  const rateLimitedProject = parallelFiles[0].projectId;
  let rateLimitConsumed = false;
  let active = 0;
  let maxActive = 0;
  let listCalls = 0;
  const fake = {
    async getVersion() {
      throw new Error('check must not call getVersion');
    },
    async getVersionFiles(hashes) {
      const found = {};
      for (const sha1 of hashes) {
        if (versionFiles[sha1]) found[sha1] = versionFiles[sha1];
      }
      return found;
    },
    async listVersions(projectId) {
      listCalls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 30);
        timer.unref?.();
      });
      active -= 1;
      if (projectId === rateLimitedProject && !rateLimitConsumed) {
        rateLimitConsumed = true;
        throw new UpstreamError('Upstream responded with HTTP 429', { upstreamStatus: 429 });
      }
      return versionLists[projectId];
    },
  };
  const { manager, modInstaller } = setup({ modrinth: fake });
  const meta = await manager.create({ name: 'Parallel', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });
  for (const file of parallelFiles) {
    await placeFile(manager, meta.id, 'mods', file.filename, file.bytes);
  }

  const first = await modInstaller.check(meta.id);
  assert.equal(first.checked, 8);
  assert.equal(first.adopted.length, 8, 'every hand-placed jar is adopted by hash');
  assert.equal(first.updateCount, 8, 'every adopted project reports its newer version');
  assert.ok(maxActive >= 2, `version lookups must run concurrently (max in flight ${maxActive})`);
  assert.equal(listCalls, 9, '8 project lookups plus exactly one retry for the rate-limited project');

  const second = await modInstaller.check(meta.id);
  assert.equal(listCalls, 9, 'a repeat check inside the TTL is served from the versions cache');
  assert.equal(second.updateCount, 8, 'cached lookups return the same latest versions');
});

test('pack installs record kind, pack checks skip loader filters and remove forgets entries', async () => {
  const packV1 = makeVersion('PACK_V1', 'PRJPACK', [
    {
      filename: 'pack.zip',
      url: `${baseUrl}/files/shared-a.jar`,
      primary: true,
      size: sodiumBytes.length,
      sha1: sodiumBytesHashes.sha1,
      sha512: sodiumBytesHashes.sha512,
    },
  ]);
  const packV2 = { ...makeVersion('PACK_V2', 'PRJPACK', []), versionNumber: '2.0.0' };
  const packList = [packV2, packV1];
  const modrinth = createCheckableModrinth({
    versions: { PACK_V1: packV1, PACK_V2: packV2 },
    versionLists: { PRJPACK: packList },
  });
  const { manager, modInstaller } = setup({ modrinth });
  const meta = await manager.create({ name: 'PackCheck', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });

  await modInstaller.install(meta.id, 'PACK_V1', { kind: 'resourcepacks' });
  const packFile = path.join(manager.paths(meta.id).gameDir, 'resourcepacks', 'pack.zip');
  assert.ok(fs.existsSync(packFile), 'resource pack lands in gameDir/resourcepacks');

  const registry = await readModRegistry(manager.paths(meta.id).dir);
  assert.equal(registry['pack.zip'].kind, 'resourcepacks');
  assert.equal(registry['pack.zip'].versionId, 'PACK_V1');

  const checked = await modInstaller.check(meta.id, { kind: 'resourcepacks' });
  assert.equal(checked.kind, 'resourcepacks');
  assert.deepEqual(checked.adopted, []);
  assert.equal(checked.files[0].status, 'checked');
  assert.equal(checked.updateCount, 1);
  assert.deepEqual(modrinth.listVersionCalls[0].options, {}, 'packs must not filter by loader or game version');

  packList.splice(0, packList.length, packV1);
  const upToDate = await modInstaller.check(meta.id, { kind: 'resourcepacks' });
  assert.equal(upToDate.updateCount, 0);
  assert.equal(upToDate.files[0].updateAvailable, false);

  const removed = await modInstaller.remove(meta.id, 'pack.zip', { kind: 'resourcepacks' });
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(packFile), false);
  const after = await readModRegistry(manager.paths(meta.id).dir);
  assert.equal(Object.hasOwn(after, 'pack.zip'), false, 'remove must forget the registry entry for every kind');

  const empty = await modInstaller.check(meta.id, { kind: 'resourcepacks' });
  assert.deepEqual(empty.files, []);
  assert.equal(empty.checked, 0);

  const modsCheck = await modInstaller.check(meta.id, { kind: 'mods' });
  assert.equal(modsCheck.checked, 0, 'packs never appear in the mods check');
});

test('pack checks stay ready when Modrinth omits Minecraft tags and always take the newest version', async () => {
  // Regression: Modrinth rarely tags resource packs with the instance MC (e.g. 26.2) — an
  // untagged pack still works in-game, so it must come back 'checked', never 'incompatible'.
  const packFile = {
    filename: 'pack.zip',
    url: `${baseUrl}/files/shared-a.jar`,
    primary: true,
    size: sodiumBytes.length,
    sha1: sodiumBytesHashes.sha1,
    sha512: sodiumBytesHashes.sha512,
  };
  const untaggedOld = {
    ...makeVersion('UNTAG_OLD', 'PRJUNTAG', [packFile]),
    gameVersions: ['1.21.4'],
    versionNumber: '1.0.0',
  };
  const untaggedNew = {
    ...makeVersion('UNTAG_NEW', 'PRJUNTAG', []),
    gameVersions: ['1.21.4'],
    versionNumber: '2.0.0',
  };
  const taggedInstalled = {
    ...makeVersion('UNTAG_TAGGED', 'PRJUNTAG', [packFile]),
    gameVersions: ['26.2'],
    versionNumber: '1.5.0',
  };
  const untaggedList = [untaggedNew, untaggedOld];
  const modrinth = createCheckableModrinth({
    versions: { UNTAG_OLD: untaggedOld, UNTAG_NEW: untaggedNew, UNTAG_TAGGED: taggedInstalled },
    versionLists: { PRJUNTAG: untaggedList },
  });
  const { manager, modInstaller } = setup({ modrinth });
  const meta = await manager.create({ name: 'UntaggedPack', minecraftVersion: '26.2', fabricLoaderVersion: '0.19.5' });

  await modInstaller.install(meta.id, 'UNTAG_OLD', { kind: 'resourcepacks' });
  const checked = await modInstaller.check(meta.id, { kind: 'resourcepacks' });
  assert.equal(checked.files[0].status, 'checked', 'untagged pack must not report incompatible');
  assert.equal(checked.files[0].updateAvailable, true, 'newest overall version is offered when nothing is tagged');
  assert.equal(checked.files[0].latest.versionNumber, '2.0.0');
  assert.deepEqual(modrinth.listVersionCalls[0].options, {}, 'pack lookups must not filter by game version');

  // Packs ignore Minecraft tags entirely — newest overall wins even when the installed version is tagged
  // (mutate in place: the versions cache holds this same array reference)
  const meta2 = await manager.create({ name: 'TaggedPack', minecraftVersion: '26.2', fabricLoaderVersion: '0.19.5' });
  await modInstaller.install(meta2.id, 'UNTAG_TAGGED', { kind: 'resourcepacks' });
  untaggedList.splice(0, untaggedList.length, untaggedNew, taggedInstalled);
  const newest = await modInstaller.check(meta2.id, { kind: 'resourcepacks' });
  assert.equal(newest.files[0].status, 'checked');
  assert.equal(
    newest.files[0].updateAvailable,
    true,
    'packs take the newest version regardless of game-version tags',
  );
  assert.equal(newest.files[0].latest.versionNumber, '2.0.0');
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
