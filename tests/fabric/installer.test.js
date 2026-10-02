// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CorruptDataError, NotFoundError, ValidationError } from '../../src/core/errors.js';
import { createInstanceManager } from '../../src/instance/manager.js';
import { parseVersionJson } from '../../src/minecraft/versions.js';
import { planVersion } from '../../src/minecraft/install.js';
import {
  FABRIC_MAVEN_BASE_URL,
  buildFabricVersion,
  createFabricInstaller,
  fabricVersionId,
  toMojangLibrary,
} from '../../src/fabric/installer.js';
import { createFabricApi } from '../../src/fabric/api.js';

const GAME = '1.20.1';
const LOADER_A = '0.15.7';
const LOADER_B = '0.16.9';
const KNOT_CLIENT = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
const FABRIC_HOST = 'https://maven.fabricmc.net/';

function parentRaw(id) {
  return {
    id,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '1.20',
    assetIndex: {
      id: '1.20',
      sha1: 'a'.repeat(40),
      size: 42,
      totalSize: 400,
      url: 'https://piston-meta.mojang.com/v1/packages/aaa/1.20.json',
    },
    downloads: {
      client: {
        sha1: 'b'.repeat(40),
        size: 200,
        url: `https://piston-data.mojang.com/client-${id}.jar`,
      },
      server: {
        sha1: 'c'.repeat(40),
        size: 100,
        url: `https://piston-data.mojang.com/server-${id}.jar`,
      },
    },
    libraries: [
      {
        name: 'com.mojang:brigadier:1.0.18',
        downloads: {
          artifact: {
            path: 'com/mojang/brigadier/1.0.18/brigadier-1.0.18.jar',
            sha1: 'd'.repeat(40),
            size: 50,
            url: 'https://libraries.minecraft.net/com/mojang/brigadier/1.0.18/brigadier-1.0.18.jar',
          },
        },
      },
      {
        name: 'com.mojang:authlib:4.0.43',
        downloads: {
          artifact: {
            path: 'com/mojang/authlib/4.0.43/authlib-4.0.43.jar',
            sha1: 'e'.repeat(40),
            size: 60,
            url: 'https://libraries.minecraft.net/com/mojang/authlib/4.0.43/authlib-4.0.43.jar',
          },
        },
      },
    ],
    arguments: {
      game: ['--demo'],
      jvm: ['-Djava.library.path=${natives_directory}'],
    },
    javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
    releaseTime: '2023-06-12T13:25:51+00:00',
    time: '2023-06-12T13:25:51+00:00',
    complianceLevel: 1,
  };
}

function makeProfile(game, loader, { asm = '9.6', sponge = '0.12.5+mixin.0.8.5' } = {}) {
  return Object.freeze({
    gameVersion: game,
    loaderVersion: loader,
    loader: Object.freeze({ separator: '.', build: 7, maven: `net.fabricmc:fabric-loader:${loader}`, version: loader, stable: true }),
    intermediary: Object.freeze({ maven: `net.fabricmc:intermediary:${game}`, version: game, stable: true }),
    launcherMeta: {
      version: 2,
      min_java_version: 8,
      libraries: {
        client: [],
        common: [
          { name: `org.ow2.asm:asm:${asm}`, url: FABRIC_HOST, sha1: '1'.repeat(40), size: 1000 },
          { name: `org.ow2.asm:asm-tree:${asm}`, url: FABRIC_HOST, sha1: '2'.repeat(40), size: 500 },
          { name: `net.fabricmc:sponge-mixin:${sponge}`, url: FABRIC_HOST, sha1: '3'.repeat(40), size: 1451874 },
        ],
        server: [],
        development: [
          { name: 'io.github.llamalad7:mixinextras-fabric:0.3.5', url: FABRIC_HOST },
        ],
      },
      mainClass: { client: KNOT_CLIENT, server: 'net.fabricmc.loader.impl.launch.knot.KnotServer' },
    },
  });
}

function createFakeMinecraft(parents) {
  const calls = [];
  return {
    calls,
    async getVersion(id) {
      calls.push(id);
      const raw = parents[id];
      if (!raw) {
        throw new NotFoundError(`Minecraft version not found: ${id}`, {
          code: 'VERSION_NOT_FOUND',
          details: { id },
        });
      }
      return { version: parseVersionJson(raw), source: 'fake' };
    },
  };
}

function createFakeFabric(profiles) {
  const profileCalls = [];
  return {
    profileCalls,
    async listGameVersions() {
      return [{ version: GAME, stable: true }];
    },
    async listLoaderVersions() {
      return [{ version: LOADER_A, stable: true, maven: `net.fabricmc:fabric-loader:${LOADER_A}`, build: 7 }];
    },
    async getProfile(game, loader) {
      profileCalls.push(`${game}/${loader}`);
      const profile = profiles[`${game}/${loader}`];
      if (!profile) {
        throw new NotFoundError(`Fabric profile not found: ${game} + ${loader}`, {
          code: 'FABRIC_PROFILE_NOT_FOUND',
          details: { gameVersion: game, loaderVersion: loader },
        });
      }
      return profile;
    },
  };
}

function setup({ profiles = {}, parents = { [GAME]: parentRaw(GAME) } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-fabric-'));
  const manager = createInstanceManager({ instancesDir: dir });
  const minecraft = createFakeMinecraft(parents);
  const fabric = createFakeFabric(profiles);
  const fabricInstaller = createFabricInstaller({ fabric, minecraft, manager });
  return { dir, manager, minecraft, fabric, fabricInstaller };
}

function fakeHttpClient(handler) {
  const calls = [];
  return {
    calls,
    async getJson(url, opts) {
      calls.push({ url, opts });
      return handler(url, opts);
    },
  };
}

test('install builds a merged, plan-ready fabric version inside the instance', async () => {
  const profiles = { [`${GAME}/${LOADER_A}`]: makeProfile(GAME, LOADER_A) };
  const { manager, minecraft, fabric, fabricInstaller } = setup({ profiles });
  const meta = await manager.create({
    name: 'Fabric A',
    minecraftVersion: GAME,
    fabricLoaderVersion: LOADER_A,
  });

  const result = await fabricInstaller.install(meta.id);

  assert.equal(result.installed, true);
  assert.equal(result.skipped, false);
  assert.equal(result.id, `fabric-loader-${LOADER_A}-${GAME}`);
  assert.equal(result.mainClass, KNOT_CLIENT);
  assert.equal(minecraft.calls[0], GAME);
  assert.deepEqual(fabric.profileCalls, [`${GAME}/${LOADER_A}`]);

  const file = manager.paths(meta.id).fabricVersionFile;
  assert.ok(fs.existsSync(file));
  assert.ok(file.startsWith(manager.paths(meta.id).dir));

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const parsed = parseVersionJson(saved);
  assert.equal(parsed.id, result.id);
  assert.equal(saved.mainClass, KNOT_CLIENT);
  assert.equal(saved.assets, '1.20');
  assert.equal(saved.downloads.client.sha1, 'b'.repeat(40));
  assert.deepEqual(saved.arguments, { game: ['--demo'], jvm: ['-Djava.library.path=${natives_directory}'] });
  assert.equal(saved.tmlFabric.minecraftVersion, GAME);
  assert.equal(saved.tmlFabric.fabricLoaderVersion, LOADER_A);

  const names = saved.libraries.map((lib) => lib.name);
  assert.deepEqual(names.slice(0, 2), ['com.mojang:brigadier:1.0.18', 'com.mojang:authlib:4.0.43']);
  assert.deepEqual(names.slice(2), [
    `net.fabricmc:fabric-loader:${LOADER_A}`,
    `net.fabricmc:intermediary:${GAME}`,
    'org.ow2.asm:asm:9.6',
    'org.ow2.asm:asm-tree:9.6',
    'net.fabricmc:sponge-mixin:0.12.5+mixin.0.8.5',
  ]);
  assert.ok(!names.some((name) => name.includes('mixinextras')), 'development libraries must stay excluded');

  const loaderLib = saved.libraries.find((lib) => lib.name === `net.fabricmc:fabric-loader:${LOADER_A}`);
  assert.equal(loaderLib.downloads.artifact.path, `net/fabricmc/fabric-loader/${LOADER_A}/fabric-loader-${LOADER_A}.jar`);
  assert.equal(loaderLib.downloads.artifact.url, `${FABRIC_HOST}net/fabricmc/fabric-loader/${LOADER_A}/fabric-loader-${LOADER_A}.jar`);

  const asmLib = saved.libraries.find((lib) => lib.name === 'org.ow2.asm:asm:9.6');
  assert.equal(asmLib.downloads.artifact.sha1, '1'.repeat(40));
  assert.equal(asmLib.downloads.artifact.size, 1000);
  assert.equal(asmLib.downloads.artifact.url, `${FABRIC_HOST}org/ow2/asm/asm/9.6/asm-9.6.jar`);

  const plan = planVersion(parsed);
  assert.equal(plan.libraries.length, 7);
});

test('same Minecraft version with different loaders stays isolated per instance', async () => {
  const profiles = {
    [`${GAME}/${LOADER_A}`]: makeProfile(GAME, LOADER_A, { asm: '9.6' }),
    [`${GAME}/${LOADER_B}`]: makeProfile(GAME, LOADER_B, { asm: '9.7', sponge: '0.13.3+mixin.0.8.5' }),
  };
  const { manager, fabricInstaller } = setup({ profiles });

  const a = await manager.create({ name: 'Instance A', minecraftVersion: GAME, fabricLoaderVersion: LOADER_A });
  const b = await manager.create({ name: 'Instance B', minecraftVersion: GAME, fabricLoaderVersion: LOADER_B });

  const first = await fabricInstaller.install(a.id);
  const fileA = manager.paths(a.id).fabricVersionFile;
  const snapshotA = fs.readFileSync(fileA, 'utf8');

  const second = await fabricInstaller.install(b.id);
  const fileB = manager.paths(b.id).fabricVersionFile;

  assert.notEqual(fileA, fileB);
  assert.equal(first.id, `fabric-loader-${LOADER_A}-${GAME}`);
  assert.equal(second.id, `fabric-loader-${LOADER_B}-${GAME}`);
  assert.equal(fs.readFileSync(fileA, 'utf8'), snapshotA, 'instance A file must be untouched by instance B install');

  const parsedA = parseVersionJson(JSON.parse(snapshotA));
  const parsedB = parseVersionJson(JSON.parse(fs.readFileSync(fileB, 'utf8')));
  assert.ok(parsedA.raw.libraries.some((lib) => lib.name === `net.fabricmc:fabric-loader:${LOADER_A}`));
  assert.ok(parsedA.raw.libraries.some((lib) => lib.name === 'org.ow2.asm:asm:9.6'));
  assert.ok(parsedB.raw.libraries.some((lib) => lib.name === `net.fabricmc:fabric-loader:${LOADER_B}`));
  assert.ok(parsedB.raw.libraries.some((lib) => lib.name === 'org.ow2.asm:asm:9.7'));

  const statusA = await fabricInstaller.status(a.id);
  assert.deepEqual(statusA, { instanceId: a.id, id: `fabric-loader-${LOADER_A}-${GAME}`, installed: true, stale: false });
  const statusB = await fabricInstaller.status(b.id);
  assert.deepEqual(statusB, { instanceId: b.id, id: `fabric-loader-${LOADER_B}-${GAME}`, installed: true, stale: false });
});

test('install is idempotent, detects stale loader metadata and supports force', async () => {
  const profiles = {
    [`${GAME}/${LOADER_A}`]: makeProfile(GAME, LOADER_A),
    [`${GAME}/${LOADER_B}`]: makeProfile(GAME, LOADER_B, { asm: '9.7' }),
  };
  const { dir, manager, fabric, fabricInstaller } = setup({ profiles });
  const meta = await manager.create({
    name: 'Stale',
    minecraftVersion: GAME,
    fabricLoaderVersion: LOADER_A,
  });

  const first = await fabricInstaller.install(meta.id);
  const again = await fabricInstaller.install(meta.id);
  assert.equal(first.skipped, false);
  assert.equal(again.skipped, true);
  assert.equal(again.id, first.id);
  assert.equal(fabric.profileCalls.length, 1);

  const forced = await fabricInstaller.install(meta.id, { force: true });
  assert.equal(forced.skipped, false);
  assert.equal(fabric.profileCalls.length, 2);

  const staleMeta = { ...meta, fabricLoaderVersion: LOADER_B };
  fs.writeFileSync(path.join(dir, meta.id, 'instance.json'), `${JSON.stringify(staleMeta, null, 2)}\n`);

  const staleStatus = await fabricInstaller.status(meta.id);
  assert.equal(staleStatus.installed, true);
  assert.equal(staleStatus.stale, true);
  assert.equal(staleStatus.id, `fabric-loader-${LOADER_A}-${GAME}`);
  assert.equal(await fabricInstaller.versionFor(meta.id), null);

  const reinstalled = await fabricInstaller.install(meta.id);
  assert.equal(reinstalled.skipped, false);
  assert.equal(reinstalled.id, `fabric-loader-${LOADER_B}-${GAME}`);
  assert.equal(fabric.profileCalls.length, 3);

  const freshStatus = await fabricInstaller.status(meta.id);
  assert.deepEqual(freshStatus, {
    instanceId: meta.id,
    id: `fabric-loader-${LOADER_B}-${GAME}`,
    installed: true,
    stale: false,
  });
});

test('versionFor returns a parsed fabric version only when fresh', async () => {
  const profiles = { [`${GAME}/${LOADER_A}`]: makeProfile(GAME, LOADER_A) };
  const { manager, fabricInstaller } = setup({ profiles });
  const meta = await manager.create({
    name: 'Version for',
    minecraftVersion: GAME,
    fabricLoaderVersion: LOADER_A,
  });

  assert.equal(await fabricInstaller.versionFor(meta.id), null);

  await fabricInstaller.install(meta.id);
  const version = await fabricInstaller.versionFor(meta.id);

  assert.ok(version);
  assert.equal(version.id, `fabric-loader-${LOADER_A}-${GAME}`);
  assert.equal(version.mainClass, KNOT_CLIENT);
  assert.equal(version.raw.tmlFabric.minecraftVersion, GAME);
  assert.equal(version.raw.tmlFabric.fabricLoaderVersion, LOADER_A);
});

test('install surfaces instance, profile and parent-version errors', async () => {
  const profiles = { [`${GAME}/${LOADER_A}`]: makeProfile(GAME, LOADER_A) };
  const { manager, minecraft, fabric, fabricInstaller } = setup({ profiles });

  await assert.rejects(fabricInstaller.install('missing1'), { code: 'INSTANCE_NOT_FOUND', status: 404 });

  const noProfile = await manager.create({
    name: 'No profile',
    minecraftVersion: GAME,
    fabricLoaderVersion: '0.99.0',
  });
  await assert.rejects(fabricInstaller.install(noProfile.id), { code: 'FABRIC_PROFILE_NOT_FOUND', status: 404 });
  assert.equal(fabric.profileCalls.length, 1);

  const noParent = await manager.create({
    name: 'No parent',
    minecraftVersion: '1.19.99',
    fabricLoaderVersion: LOADER_A,
  });
  await assert.rejects(fabricInstaller.install(noParent.id), { code: 'VERSION_NOT_FOUND', status: 404 });
  assert.equal(minecraft.calls.at(-1), '1.19.99');

  await assert.rejects(fabricInstaller.status('missing1'), { code: 'INSTANCE_NOT_FOUND', status: 404 });
  await assert.rejects(fabricInstaller.versionFor('missing1'), { code: 'INSTANCE_NOT_FOUND', status: 404 });
});

test('createFabricInstaller validates its collaborators', () => {
  const minecraft = { getVersion: async () => null };
  const manager = { get: async () => null, paths: () => ({}) };

  assert.throws(() => createFabricInstaller({ manager }), (err) => err instanceof ValidationError && err.code === 'INVALID_MINECRAFT_API');
  assert.throws(() => createFabricInstaller({ minecraft }), (err) => err instanceof ValidationError && err.code === 'INVALID_INSTANCE_MANAGER');
  assert.throws(
    () => createFabricInstaller({ minecraft, manager, fabric: {} }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_FABRIC_API',
  );
});

test('toMojangLibrary converts fabric maven coordinates into Mojang library entries', () => {
  const converted = toMojangLibrary({
    name: 'org.ow2.asm:asm:9.6',
    url: FABRIC_HOST,
    sha1: 'AB'.repeat(20),
    size: 12,
  });
  assert.deepEqual(converted, {
    name: 'org.ow2.asm:asm:9.6',
    downloads: {
      artifact: {
        path: 'org/ow2/asm/asm/9.6/asm-9.6.jar',
        url: `${FABRIC_HOST}org/ow2/asm/asm/9.6/asm-9.6.jar`,
        sha1: 'ab'.repeat(20),
        size: 12,
      },
    },
  });

  const plain = toMojangLibrary('net.fabricmc:intermediary:1.20.1');
  assert.equal(plain.downloads.artifact.path, 'net/fabricmc/intermediary/1.20.1/intermediary-1.20.1.jar');
  assert.equal(plain.downloads.artifact.url, `${FABRIC_MAVEN_BASE_URL}net/fabricmc/intermediary/1.20.1/intermediary-1.20.1.jar`);
  assert.ok(!('sha1' in plain.downloads.artifact));
  assert.ok(!('size' in plain.downloads.artifact));

  const noSlash = toMojangLibrary({ name: 'net.fabricmc:fabric-loader:0.15.7', url: 'https://maven.fabricmc.net' });
  assert.ok(noSlash.downloads.artifact.url.startsWith('https://maven.fabricmc.net/net/fabricmc/'));

  assert.throws(
    () => toMojangLibrary({ name: 'missing-colon' }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_MAVEN_COORDINATE',
  );
  assert.throws(
    () => toMojangLibrary({ url: FABRIC_HOST }),
    (err) => err instanceof CorruptDataError && err.code === 'FABRIC_LIBRARY_INVALID',
  );
  assert.throws(
    () => toMojangLibrary(42),
    (err) => err instanceof CorruptDataError && err.code === 'FABRIC_LIBRARY_INVALID',
  );
});

test('buildFabricVersion rejects invalid parent and profile input', () => {
  const profile = makeProfile(GAME, LOADER_A);

  assert.throws(
    () => buildFabricVersion({ parent: null, profile }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_PARENT_VERSION',
  );
  assert.throws(
    () => buildFabricVersion({ parent: parseVersionJson(parentRaw(GAME)), profile: null }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_FABRIC_PROFILE',
  );
  assert.throws(
    () => buildFabricVersion({ parent: { id: 'x' }, profile }),
    (err) => err instanceof CorruptDataError,
  );
  assert.throws(
    () => buildFabricVersion({ parent: parseVersionJson(parentRaw(GAME)), profile: { ...profile, gameVersion: '' } }),
    (err) => err instanceof CorruptDataError && err.code === 'FABRIC_PROFILE_INVALID',
  );

  assert.equal(fabricVersionId({ minecraftVersion: GAME, fabricLoaderVersion: LOADER_A }), `fabric-loader-${LOADER_A}-${GAME}`);
  assert.throws(
    () => fabricVersionId({ minecraftVersion: '', fabricLoaderVersion: LOADER_A }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_FABRIC_META',
  );
});

test('fabric api fetches meta with source fabric and maps missing profiles to 404', async () => {
  const client = fakeHttpClient((url) => {
    if (url === 'https://meta.fabricmc.net/v2/versions/game') {
      return { status: 200, data: [{ version: GAME, stable: true }, { version: '24w14a' }] };
    }
    if (url === 'https://meta.fabricmc.net/v2/versions/loader') {
      return { status: 200, data: [{ version: LOADER_A, stable: true, maven: `net.fabricmc:fabric-loader:${LOADER_A}`, build: 7 }, { version: '0.16.0' }] };
    }
    if (url === `https://meta.fabricmc.net/v2/versions/loader/${GAME}/${LOADER_A}`) {
      return { status: 404, data: null };
    }
    throw new Error(`unexpected url: ${url}`);
  });
  const api = createFabricApi({ client });

  const games = await api.listGameVersions();
  assert.deepEqual(games, [{ version: GAME, stable: true }, { version: '24w14a', stable: false }]);

  const loaders = await api.listLoaderVersions();
  assert.deepEqual(loaders, [
    { version: LOADER_A, stable: true, maven: `net.fabricmc:fabric-loader:${LOADER_A}`, build: 7 },
    { version: '0.16.0', stable: false, maven: null, build: null },
  ]);

  assert.ok(client.calls.every((call) => call.opts.source === 'fabric'));

  await assert.rejects(api.getProfile(GAME, LOADER_A), {
    code: 'FABRIC_PROFILE_NOT_FOUND',
    status: 404,
    details: { gameVersion: GAME, loaderVersion: LOADER_A },
  });
  await assert.rejects(api.getProfile(GAME, '../evil'), (err) => err instanceof ValidationError && err.code === 'INVALID_VERSION_ID');
});

test('fabric api validates profile shape and rejects corrupt meta', async () => {
  const validProfile = {
    loader: { separator: '.', build: 7, maven: `net.fabricmc:fabric-loader:${LOADER_A}`, version: LOADER_A, stable: true },
    intermediary: { maven: `net.fabricmc:intermediary:${GAME}`, version: GAME, stable: true },
    launcherMeta: {
      version: 2,
      min_java_version: 8,
      libraries: { client: [], common: [{ name: 'org.ow2.asm:asm:9.6', url: FABRIC_HOST }], server: [], development: [] },
      mainClass: { client: KNOT_CLIENT, server: 'net.fabricmc.loader.impl.launch.knot.KnotServer' },
    },
  };
  const client = fakeHttpClient((url) => {
    if (url === 'https://meta.fabricmc.net/v2/versions/game') return { status: 200, data: { not: 'an array' } };
    if (url === `https://meta.fabricmc.net/v2/versions/loader/${GAME}/${LOADER_A}`) return { status: 200, data: validProfile };
    if (url === `https://meta.fabricmc.net/v2/versions/loader/${GAME}/0.9.0`) return { status: 200, data: { ...validProfile, loader: { ...validProfile.loader, version: '0.8.0' } } };
    if (url === `https://meta.fabricmc.net/v2/versions/loader/${GAME}/0.1.0`) return { status: 200, data: { loader: validProfile.loader } };
    throw new Error(`unexpected url: ${url}`);
  });
  const api = createFabricApi({ client });

  await assert.rejects(api.listGameVersions(), (err) => err instanceof CorruptDataError && err.code === 'FABRIC_META_INVALID');

  const profile = await api.getProfile(GAME, LOADER_A);
  assert.ok(Object.isFrozen(profile));
  assert.equal(profile.gameVersion, GAME);
  assert.equal(profile.loaderVersion, LOADER_A);
  assert.equal(profile.loader.maven, `net.fabricmc:fabric-loader:${LOADER_A}`);
  assert.equal(profile.intermediary.maven, `net.fabricmc:intermediary:${GAME}`);
  assert.equal(profile.launcherMeta.mainClass.client, KNOT_CLIENT);

  await assert.rejects(api.getProfile(GAME, '0.9.0'), (err) => err instanceof CorruptDataError && err.code === 'FABRIC_PROFILE_INVALID');
  await assert.rejects(api.getProfile(GAME, '0.1.0'), (err) => err instanceof CorruptDataError && err.code === 'FABRIC_PROFILE_INVALID');
});

test('live: builds a real fabric version for 1.20.1 from fabric meta and Mojang metadata', { skip: !process.env.TML_LIVE }, async () => {
  const { loadConfig } = await import('../../src/core/config.js');
  const { createMinecraftApi } = await import('../../src/minecraft/api.js');

  const config = loadConfig();
  const minecraft = createMinecraftApi({ config });
  const fabric = createFabricApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-fabric-live-'));
  const manager = createInstanceManager({ instancesDir: dir });
  const fabricInstaller = createFabricInstaller({ fabric, minecraft, manager });

  const games = await fabric.listGameVersions();
  assert.ok(games.some((entry) => entry.version === GAME && entry.stable === true));
  const loaders = await fabric.listLoaderVersions();
  assert.ok(loaders.some((entry) => /^\d+\.\d+\.\d+$/.test(entry.version) && typeof entry.stable === 'boolean'));

  const meta = await manager.create({
    name: 'Live Fabric',
    minecraftVersion: GAME,
    fabricLoaderVersion: LOADER_A,
  });
  const result = await fabricInstaller.install(meta.id);
  assert.equal(result.id, `fabric-loader-${LOADER_A}-${GAME}`);
  assert.equal(result.mainClass, KNOT_CLIENT);

  const saved = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  const parsed = parseVersionJson(saved);
  assert.equal(parsed.id, result.id);
  assert.equal(parsed.mainClass, KNOT_CLIENT);
  assert.equal(saved.tmlFabric.minecraftVersion, GAME);
  assert.equal(saved.tmlFabric.fabricLoaderVersion, LOADER_A);

  const names = saved.libraries.map((lib) => lib.name);
  assert.ok(names.includes(`net.fabricmc:fabric-loader:${LOADER_A}`));
  assert.ok(names.includes(`net.fabricmc:intermediary:${GAME}`));
  assert.ok(names.includes('org.ow2.asm:asm:9.6'));
  assert.ok(names.includes('net.fabricmc:sponge-mixin:0.12.5+mixin.0.8.5'));
  assert.ok(!names.some((name) => name.includes('mixinextras')));

  const fabricLibs = saved.libraries.filter((lib) => lib.downloads?.artifact?.url?.startsWith(FABRIC_HOST));
  assert.ok(fabricLibs.length >= 8);
  const hashed = fabricLibs.filter((lib) => /^[0-9a-f]{40}$/.test(lib.downloads.artifact.sha1 ?? ''));
  assert.ok(hashed.length >= 6, 'fabric common libraries must carry sha1 hashes');

  const status = await fabricInstaller.status(meta.id);
  assert.deepEqual(status, { instanceId: meta.id, id: result.id, installed: true, stale: false });

  const again = await fabricInstaller.install(meta.id);
  assert.equal(again.skipped, true);
});
