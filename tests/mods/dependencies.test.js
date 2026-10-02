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

import { NotFoundError, SourceNotAllowedError, ValidationError } from '../../src/core/errors.js';
import { hashBuffer } from '../../src/download/hash.js';
import { createInstanceManager } from '../../src/instance/manager.js';
import { createModInstaller } from '../../src/mods/install.js';
import { createDependencyResolver } from '../../src/mods/dependencies.js';

const localOnly = (input) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new SourceNotAllowedError(`Host not allowed: ${url.hostname}`, {
      details: { host: url.hostname },
    });
  }
  return url;
};

const rootBytes = Buffer.from('root mod jar\n'.repeat(4));
const depbBytes = Buffer.from('dep b jar\n'.repeat(4));
const grandBytes = Buffer.from('grand dep jar\n'.repeat(4));
const fapiBytes = Buffer.from('fabric api jar v0.14\n'.repeat(4));

const BASE = Object.freeze({ minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });

let server;
let baseUrl;
const routes = new Map();

function hashesOf(bytes) {
  return hashBuffer(bytes, ['sha1', 'sha512']);
}

function modFile(filename, bytes) {
  const hashes = hashesOf(bytes);
  return {
    filename,
    url: `${baseUrl}/files/${filename}`,
    primary: true,
    size: bytes.length,
    sha1: hashes.sha1,
    sha512: hashes.sha512,
  };
}

function makeVersion(id, projectId, files, dependencies = []) {
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
    dependencies,
  };
}

const dep = (projectId, versionId, dependencyType = 'required') => ({
  projectId,
  versionId,
  fileName: null,
  dependencyType,
});

before(async () => {
  routes.set('/files/root-1.0.0.jar', rootBytes);
  routes.set('/files/depb-1.jar', depbBytes);
  routes.set('/files/grand-1.jar', grandBytes);
  routes.set('/files/fabric-api-0.14.0.jar', fapiBytes);

  server = http.createServer((req, res) => {
    const bytes = routes.get(req.url);
    if (!bytes) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/java-archive', 'content-length': String(bytes.length) });
    res.end(bytes);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

function fixtureVersions() {
  return {
    ROOT: makeVersion('ROOT', 'PRJROOT', [modFile('root-1.0.0.jar', rootBytes)], [
      dep('PRJDEPB', 'DEPB'),
      dep('PRJFAPI', null),
      dep('PRJDEPB', 'DEPB'),
      dep('PRJOPT', 'OPT', 'optional'),
      dep('PRJINCOMPAT', 'INCOMPAT', 'incompatible'),
      dep('PRJROOT', 'ROOT'),
    ]),
    DEPB: makeVersion('DEPB', 'PRJDEPB', [modFile('depb-1.jar', depbBytes)], [
      dep('PRJGRAND', 'GRAND'),
      dep('PRJDEPB', 'DEPB'),
    ]),
    GRAND: makeVersion('GRAND', 'PRJGRAND', [modFile('grand-1.jar', grandBytes)], [
      dep('PRJEMBED', null, 'embedded'),
    ]),
    FAPI_R1: makeVersion('FAPI_R1', 'PRJFAPI', [modFile('fabric-api-0.14.0.jar', fapiBytes)]),
    FAPI_A: {
      ...makeVersion('FAPI_A', 'PRJFAPI', [modFile('fabric-api-0.14.0.jar', fapiBytes)]),
      versionType: 'alpha',
    },
  };
}

function createFakeModrinth(versions, lists = {}) {
  const versionCalls = [];
  const listCalls = [];
  return {
    versionCalls,
    listCalls,
    async getVersion(id) {
      versionCalls.push(id);
      const version = versions[id];
      if (!version) {
        throw new NotFoundError(`Modrinth version not found: ${id}`, {
          code: 'MODRINTH_VERSION_NOT_FOUND',
          details: { id },
        });
      }
      return version;
    },
    async listVersions(projectId, filters) {
      listCalls.push({ projectId, filters });
      return lists[projectId] ?? [];
    },
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-deps-'));
  const manager = createInstanceManager({ instancesDir: dir });
  const modrinth = createFakeModrinth(fixtureVersions(), {
    PRJFAPI: [fixtureVersions().FAPI_A, fixtureVersions().FAPI_R1],
  });
  const modInstaller = createModInstaller({ manager, modrinth, validator: localOnly, retries: 0 });

  const statusCalls = [];
  const installCalls = [];
  const spyInstaller = {
    async status(instanceId, versionId) {
      statusCalls.push(instanceId);
      return modInstaller.status(instanceId, versionId);
    },
    async install(instanceId, versionId, opts) {
      installCalls.push(instanceId);
      return modInstaller.install(instanceId, versionId, opts);
    },
    list: (instanceId) => modInstaller.list(instanceId),
  };

  const resolver = createDependencyResolver({ manager, modrinth, installer: spyInstaller });
  return { dir, manager, modrinth, modInstaller, resolver, statusCalls, installCalls };
}

test('resolves required dependencies transitively with instance-driven filters', async () => {
  const { manager, resolver, modrinth, statusCalls } = setup();
  const a = await manager.create({ name: 'A', ...BASE });

  const plan = await resolver.resolveDependencies(a.id, 'ROOT');

  assert.ok(Object.isFrozen(plan));
  assert.deepEqual(plan.root, { projectId: 'PRJROOT', versionId: 'ROOT' });
  assert.equal(plan.dependencies.length, 3, 'duplicates and cycles must collapse');

  const [depb, fapi, grand] = plan.dependencies;
  assert.deepEqual(
    { projectId: depb.projectId, versionId: depb.versionId, depth: depb.depth, installed: depb.installed },
    { projectId: 'PRJDEPB', versionId: 'DEPB', depth: 1, installed: false },
  );
  assert.deepEqual(depb.files, ['depb-1.jar']);
  assert.deepEqual(
    { projectId: fapi.projectId, versionId: fapi.versionId, depth: fapi.depth, installed: fapi.installed },
    { projectId: 'PRJFAPI', versionId: 'FAPI_R1', depth: 1, installed: false },
    'release version must win over alpha when versionId is null',
  );
  assert.deepEqual(
    { projectId: grand.projectId, versionId: grand.versionId, depth: grand.depth, installed: grand.installed },
    { projectId: 'PRJGRAND', versionId: 'GRAND', depth: 2, installed: false },
    'transitive dependency must resolve at depth 2',
  );
  assert.equal(plan.dependencies.some((entry) => entry.projectId === 'PRJROOT'), false, 'root never listed as its own dependency');
  assert.equal(plan.missing.length, 3);
  assert.deepEqual(plan.skipped, { optional: ['PRJOPT'], incompatible: ['PRJINCOMPAT'], embedded: ['PRJEMBED'] });

  assert.deepEqual(
    modrinth.versionCalls,
    ['ROOT', 'DEPB', 'DEPB', 'FAPI_R1', 'GRAND', 'GRAND'],
    'skipped and unused versions must never be fetched (resolver + status each resolve the chosen version once)',
  );
  assert.equal(modrinth.versionCalls.includes('OPT'), false);
  assert.equal(modrinth.versionCalls.includes('INCOMPAT'), false);
  assert.equal(modrinth.versionCalls.includes('FAPI_A'), false);
  assert.deepEqual(modrinth.listCalls, [
    { projectId: 'PRJFAPI', filters: { gameVersions: ['1.20.1'], loaders: ['fabric'] } },
  ]);
  assert.ok(statusCalls.length >= 3 && statusCalls.every((id) => id === a.id));
  assert.ok(Object.isFrozen(plan.dependencies));
  assert.ok(Object.isFrozen(plan.dependencies[0]));
  assert.ok(Object.isFrozen(plan.missing));
  assert.ok(Object.isFrozen(plan.skipped.optional));
});

test('never reads mods from another instance (isolation)', async () => {
  const { manager, resolver, modInstaller, statusCalls, installCalls } = setup();
  const a = await manager.create({ name: 'Instance A', ...BASE });
  const b = await manager.create({ name: 'Instance B', ...BASE });

  await modInstaller.install(b.id, 'FAPI_R1');
  const bFile = path.join(manager.paths(b.id).modsDir, 'fabric-api-0.14.0.jar');
  const bSnapshot = fs.readFileSync(bFile, 'utf8');
  const beforeB = await modInstaller.list(b.id);
  assert.equal(beforeB.length, 1);

  const planA = await resolver.resolveDependencies(a.id, 'ROOT');
  const fapiA = planA.dependencies.find((entry) => entry.projectId === 'PRJFAPI');
  assert.equal(fapiA.installed, false, 'the same file living in instance B must not count for instance A');
  assert.equal(planA.missing.length, 3);
  assert.ok(statusCalls.every((id) => id === a.id), 'resolver must only ever query the requested instance');

  const result = await resolver.installDependencies(a.id, 'ROOT');
  assert.equal(result.installed.length, 3);
  assert.ok(installCalls.length >= 3 && installCalls.every((id) => id === a.id), 'installs must target instance A only');

  const modsA = fs.readdirSync(manager.paths(a.id).modsDir).sort();
  assert.deepEqual(modsA, ['depb-1.jar', 'fabric-api-0.14.0.jar', 'grand-1.jar']);
  assert.equal(fs.existsSync(path.join(manager.paths(a.id).modsDir, 'root-1.0.0.jar')), false, 'installDependencies handles dependencies only');

  const afterB = await modInstaller.list(b.id);
  assert.deepEqual(afterB.map((mod) => mod.filename), beforeB.map((mod) => mod.filename));
  assert.equal(fs.readFileSync(bFile, 'utf8'), bSnapshot, 'instance B must stay byte-identical');

  const planAgain = await resolver.resolveDependencies(a.id, 'ROOT');
  assert.equal(planAgain.missing.length, 0);
  assert.ok(planAgain.dependencies.every((entry) => entry.installed));

  const rerun = await resolver.installDependencies(a.id, 'ROOT');
  assert.equal(rerun.installed.length, 0, 'a second run must have nothing left to install');
});

test('validates inputs and surfaces resolution errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-deps-err-'));
  const manager = createInstanceManager({ instancesDir: dir });
  const fakeInstaller = {
    async status() {
      return { installed: false, files: [] };
    },
    async install() {
      return { files: [] };
    },
    async list() {
      return [];
    },
  };

  assert.throws(() => createDependencyResolver(), (err) => err instanceof ValidationError && err.code === 'INVALID_INSTANCE_MANAGER');
  assert.throws(
    () => createDependencyResolver({ manager }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_MODRINTH_API',
  );
  assert.throws(
    () => createDependencyResolver({ manager, modrinth: { getVersion: async () => null, listVersions: async () => [] } }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_MOD_INSTALLER',
  );

  const meta = await manager.create({ name: 'Errors', ...BASE });
  const makeResolver = (versions, lists = {}) => {
    const modrinth = createFakeModrinth(versions, lists);
    return { modrinth, resolver: createDependencyResolver({ manager, modrinth, installer: fakeInstaller }) };
  };
  const rootWith = (dependencies) => ({ V1: makeVersion('V1', 'PRJV1', [modFile('v1.jar', rootBytes)], dependencies) });

  {
    const { resolver } = makeResolver({});
    await assert.rejects(resolver.resolveDependencies('missing1', 'V1'), { code: 'INSTANCE_NOT_FOUND', status: 404 });
    await assert.rejects(resolver.resolveDependencies(meta.id, 42), { code: 'INVALID_DEPENDENCY_ROOT' });
    await assert.rejects(resolver.resolveDependencies(meta.id, { id: 'V1' }), { code: 'INVALID_DEPENDENCY_ROOT' });
  }

  {
    const { resolver } = makeResolver(rootWith([{}]));
    await assert.rejects(resolver.resolveDependencies(meta.id, 'V1'), { code: 'INVALID_DEPENDENCY_ENTRY' });
  }

  {
    const { resolver } = makeResolver(rootWith([{ projectId: 'PRJQ', versionId: null, fileName: null, dependencyType: 'maybe' }]));
    await assert.rejects(resolver.resolveDependencies(meta.id, 'V1'), { code: 'INVALID_DEPENDENCY_ENTRY' });
  }

  {
    const { resolver, modrinth } = makeResolver(rootWith([{ projectId: 'PRJEMPTY', versionId: null, fileName: null, dependencyType: 'required' }]));
    await assert.rejects(resolver.resolveDependencies(meta.id, 'V1'), {
      code: 'DEPENDENCY_VERSION_NOT_FOUND',
      details: { projectId: 'PRJEMPTY', minecraftVersion: '1.20.1', loader: 'fabric' },
    });
    assert.deepEqual(modrinth.listCalls, [
      { projectId: 'PRJEMPTY', filters: { gameVersions: ['1.20.1'], loaders: ['fabric'] } },
    ]);
  }

  {
    const { resolver } = makeResolver(rootWith([dep('PRJNOPE', 'NOPE')]));
    await assert.rejects(resolver.resolveDependencies(meta.id, 'V1'), (err) => err instanceof NotFoundError && err.code === 'MODRINTH_VERSION_NOT_FOUND');
  }

  {
    const { resolver } = makeResolver(rootWith([dep('PRJFAPI', null)]), {});
    await assert.rejects(resolver.resolveDependencies(meta.id, 'V1'), { code: 'DEPENDENCY_VERSION_NOT_FOUND' });
  }
});

test('live: resolves and installs the fabric-api dependency of create-fabric for 1.20.1', { skip: !process.env.TML_LIVE }, async () => {
  const { createModrinthApi } = await import('../../src/modrinth/api.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-deps-live-'));
  const manager = createInstanceManager({ instancesDir: dir });
  const modrinth = createModrinthApi();
  const modInstaller = createModInstaller({ manager, modrinth });

  const statusCalls = [];
  const installCalls = [];
  const spyInstaller = {
    async status(instanceId, versionId) {
      statusCalls.push(instanceId);
      return modInstaller.status(instanceId, versionId);
    },
    async install(instanceId, versionId, opts) {
      installCalls.push(instanceId);
      return modInstaller.install(instanceId, versionId, opts);
    },
    list: (instanceId) => modInstaller.list(instanceId),
  };
  const resolver = createDependencyResolver({ manager, modrinth, installer: spyInstaller });

  const a = await manager.create({ name: 'Live A', ...BASE });
  const b = await manager.create({ name: 'Live B', ...BASE });

  const indium = await resolver.resolveDependencies(a.id, 'nQHYSjxO');
  assert.equal(indium.dependencies.length, 1);
  assert.equal(indium.dependencies[0].projectId, 'AANobbMI');
  assert.equal(indium.dependencies[0].versionId, 'ygf8cVZg');
  assert.equal(indium.dependencies[0].installed, false);
  assert.equal(indium.missing.length, 1);

  const plan = await resolver.resolveDependencies(a.id, 'HAqwA6X1');
  assert.ok(plan.dependencies.length >= 1);
  const fapi = plan.dependencies.find((entry) => entry.projectId === 'P7dR8mSH');
  assert.ok(fapi, 'create-fabric must depend on fabric-api');
  assert.ok(typeof fapi.versionId === 'string' && fapi.versionId.length >= 8, 'null versionId must resolve to a concrete version');
  assert.ok(fapi.files.some((filename) => filename.startsWith('fabric-api-')), `unexpected dependency file ${fapi.files.join(', ')}`);
  assert.equal(fapi.installed, false, 'instance A starts without the dependency');

  const beforeB = fs.readdirSync(manager.paths(b.id).modsDir);
  const result = await resolver.installDependencies(a.id, 'HAqwA6X1');
  assert.equal(result.installed.length, 1);
  assert.equal(result.installed[0].projectId, 'P7dR8mSH');

  const modsA = fs.readdirSync(manager.paths(a.id).modsDir);
  assert.equal(modsA.length, 1);
  assert.ok(modsA[0].startsWith('fabric-api-'));
  assert.ok(fs.statSync(path.join(manager.paths(a.id).modsDir, modsA[0])).size > 0);

  const after = await resolver.resolveDependencies(a.id, 'HAqwA6X1');
  assert.equal(after.missing.length, 0);

  assert.deepEqual(fs.readdirSync(manager.paths(b.id).modsDir), beforeB, 'instance B must stay empty');
  const allCalls = [...statusCalls, ...installCalls];
  assert.ok(allCalls.length > 0 && allCalls.every((id) => id === a.id), 'resolver must never touch instance B');
});
