// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InstanceError, ValidationError } from '../../src/core/errors.js';
import { createInstanceManager } from '../../src/instance/manager.js';
import { resolveLaunchVersion } from '../../src/instance/launch.js';

const BASE = Object.freeze({
  minecraftVersion: '1.20.1',
  fabricLoaderVersion: '0.15.7',
});
const KNOT_CLIENT = 'net.fabricmc.loader.impl.launch.knot.KnotClient';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tml-launch-'));
}

function createFakeLauncher() {
  const calls = [];
  const handles = [];
  return {
    calls,
    handles,
    async launch(version, opts) {
      calls.push({ version, opts });
      let settle;
      const exited = new Promise((resolve) => {
        settle = resolve;
      });
      const handle = {
        pid: 4200 + handles.length,
        kill: (killSignal = 'SIGTERM') => {
          setTimeout(() => settle({ code: null, signal: killSignal, error: null }), 0);
        },
        finish: (result) => settle(result),
        exited,
      };
      handles.push(handle);
      return handle;
    },
  };
}

function createFakeFabric(options = {}) {
  const versionForCalls = [];
  const installCalls = [];
  const versions = new Map();
  const install = options.install ?? null;
  return {
    versionForCalls,
    installCalls,
    versions,
    put(id, version) {
      versions.set(id, version);
    },
    async versionFor(id) {
      versionForCalls.push(id);
      return versions.get(id) ?? null;
    },
    async install(id) {
      installCalls.push(id);
      if (install === 'noop') return { id: 'never-written', installed: false };
      if (!versions.has(id)) versions.set(id, { id: `fabric-loader-${BASE.fabricLoaderVersion}-${BASE.minecraftVersion}`, mainClass: KNOT_CLIENT });
      return { id: `fabric-loader-${BASE.fabricLoaderVersion}-${BASE.minecraftVersion}`, installed: true };
    },
  };
}

test('resolveLaunchVersion returns the installed fabric version object frozen', async () => {
  const version = { id: 'fabric-loader-0.15.7-1.20.1', mainClass: KNOT_CLIENT };
  const fabric = createFakeFabric();
  fabric.put('a1', version);

  const resolved = await resolveLaunchVersion({ id: 'a1', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' }, { fabric });

  assert.deepEqual(resolved, {
    id: version.id,
    version,
    source: 'fabric',
    cached: true,
  });
  assert.equal(resolved.version, version, 'the launcher must receive the very object fabric returned');
  assert.ok(Object.isFrozen(resolved));
  assert.deepEqual(fabric.installCalls, []);
});

test('resolveLaunchVersion installs fabric when the instance file is missing', async () => {
  const fabric = createFakeFabric();
  const meta = { id: 'fresh1', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' };

  const resolved = await resolveLaunchVersion(meta, { fabric });

  assert.equal(resolved.source, 'fabric');
  assert.equal(resolved.cached, false);
  assert.equal(resolved.id, 'fabric-loader-0.15.7-1.20.1');
  assert.deepEqual(fabric.installCalls, ['fresh1'], 'install must be called with the instance id');
  assert.deepEqual(fabric.versionForCalls, ['fresh1', 'fresh1']);
});

test('resolveLaunchVersion validation and error paths', async () => {
  await assert.rejects(resolveLaunchVersion(null, {}), { code: 'INVALID_INSTANCE_META' });
  await assert.rejects(resolveLaunchVersion({ id: 'x' }, {}), { code: 'INVALID_INSTANCE_META' });

  await assert.rejects(
    resolveLaunchVersion({ id: 'x', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' }, {}),
    (err) => err instanceof ValidationError && err.code === 'NO_FABRIC' && err.status === 400,
  );
  await assert.rejects(
    resolveLaunchVersion({ id: 'x', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' }, { fabric: { versionFor: async () => null } }),
    { code: 'NO_FABRIC' },
  );

  const broken = createFakeFabric({ install: 'noop' });
  await assert.rejects(
    resolveLaunchVersion({ id: 'x', minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' }, { fabric: broken }),
    (err) => err instanceof InstanceError && err.code === 'FABRIC_NOT_INSTALLED',
  );
  assert.deepEqual(broken.installCalls, ['x']);

  const vanilla = await resolveLaunchVersion(
    { id: 'legacy', minecraftVersion: '1.12.2' },
    {},
  );
  assert.deepEqual(vanilla, { id: '1.12.2', version: '1.12.2', source: 'vanilla', cached: true });
  assert.ok(Object.isFrozen(vanilla));
});

test('launch reports staged progress while installing and clears it afterwards', async () => {
  const dir = tmpDir();
  const launcher = createFakeLauncher();
  const fabric = createFakeFabric();
  const snapshots = [];
  let ready = false;
  const installer = {
    async status() {
      return { ready };
    },
    async install(version, opts = {}) {
      snapshots.push(manager.getLaunchProgress(meta.id));
      opts.onProgress?.({ stage: 'libraries', loaded: 5, total: 10, percent: 50 });
      snapshots.push(manager.getLaunchProgress(meta.id));
      ready = true;
      return { id: version.id };
    },
  };
  const manager = createInstanceManager({ instancesDir: dir, launcher, installer, fabric });
  const meta = await manager.create({ name: 'Progress', ...BASE });
  fabric.put(meta.id, { id: 'fabric-loader-0.15.7-1.20.1', mainClass: KNOT_CLIENT });

  const idle = manager.getLaunchProgress(meta.id);
  assert.deepEqual(idle, {
    instanceId: meta.id,
    launching: false,
    stage: 'idle',
    percent: 0,
    loaded: 0,
    total: 0,
  });

  const result = await manager.launch(meta.id);
  assert.equal(result.pid, 4200);

  assert.equal(snapshots.length, 2, 'the installer received an onProgress hook');
  assert.deepEqual(snapshots[0], {
    instanceId: meta.id,
    launching: true,
    stage: 'resolve',
    percent: 0,
    loaded: 0,
    total: 0,
  });
  assert.deepEqual(snapshots[1], {
    instanceId: meta.id,
    launching: true,
    stage: 'libraries',
    percent: 50,
    loaded: 5,
    total: 10,
  });

  assert.equal(typeof launcher.calls[0].opts.onProgress, 'function', 'the launcher launch call receives the progress hook');

  const after = manager.getLaunchProgress(meta.id);
  assert.equal(after.launching, false, 'progress is cleared once the spawn resolves');
  assert.equal(after.stage, 'idle');

  await manager.stop(meta.id);

  const failing = createInstanceManager({ instancesDir: tmpDir(), launcher: createFakeLauncher() });
  const badMeta = await failing.create({ name: 'No Fabric', ...BASE });
  await assert.rejects(failing.launch(badMeta.id), { code: 'NO_FABRIC' });
  assert.equal(failing.getLaunchProgress(badMeta.id).launching, false, 'a failed launch clears its progress too');
  assert.throws(() => failing.getLaunchProgress('BAD ID!'), { code: 'INVALID_INSTANCE_ID' });
});

test('launch without a fabric collaborator fails before any spawn', async () => {
  const dir = tmpDir();
  const launcher = createFakeLauncher();
  const manager = createInstanceManager({ instancesDir: dir, launcher });
  const meta = await manager.create({ name: 'No Fabric', ...BASE });

  await assert.rejects(manager.launch(meta.id), (err) => err instanceof ValidationError && err.code === 'NO_FABRIC');
  assert.equal(launcher.calls.length, 0, 'nothing must spawn when the version cannot be resolved');
});

test('two instances launch concurrently with their own fabric version, game dir and folders', async () => {
  const dir = tmpDir();
  const launcher = createFakeLauncher();
  const fabric = createFakeFabric();
  const manager = createInstanceManager({ instancesDir: dir, launcher, fabric });

  const a = await manager.create({ name: 'Instance A', id: 'inst-a', ...BASE });
  const b = await manager.create({ name: 'Instance B', id: 'inst-b', ...BASE, fabricLoaderVersion: '0.14.22' });
  const versionA = { id: 'fabric-loader-0.15.7-1.20.1', mainClass: KNOT_CLIENT };
  const versionB = { id: 'fabric-loader-0.14.22-1.20.1', mainClass: KNOT_CLIENT };
  fabric.put(a.id, versionA);
  fabric.put(b.id, versionB);

  const first = await manager.launch(a.id);
  const second = await manager.launch(b.id);

  assert.notEqual(first.pid, second.pid);
  assert.notEqual(first.gameDir, second.gameDir);
  assert.equal(first.version, versionA.id);
  assert.equal(second.version, versionB.id);
  assert.equal(launcher.calls[0].version, versionA, 'each spawn receives its own instance fabric version object');
  assert.equal(launcher.calls[1].version, versionB);
  assert.deepEqual(fabric.versionForCalls, [a.id, b.id], 'each instance resolves fabric through its own id only');

  for (const [instanceId, gameDir] of [[a.id, first.gameDir], [b.id, second.gameDir]]) {
    assert.equal(gameDir, path.join(dir, instanceId, 'minecraft'));
    for (const rel of ['mods', 'config', 'saves', 'options.txt']) {
      assert.ok(fs.existsSync(path.join(gameDir, rel)), `${instanceId} must own its own ${rel}`);
    }
  }

  assert.equal(manager.status(a.id).running, true);
  assert.equal(manager.status(b.id).running, true);
  await manager.stop(a.id);
  assert.equal(manager.status(a.id).running, false);
  assert.equal(manager.status(b.id).running, true);
  await manager.stop(b.id);
});

test('installer receives the resolved fabric version and launches only when ready', async () => {
  const dir = tmpDir();
  const launcher = createFakeLauncher();
  const fabric = createFakeFabric();
  const statusCalls = [];
  const installCalls = [];
  let ready = false;
  const installer = {
    async status(version) {
      statusCalls.push(version);
      return { ready };
    },
    async install(version) {
      installCalls.push(version);
      ready = true;
      return { id: version.id };
    },
  };
  const manager = createInstanceManager({ instancesDir: dir, launcher, installer, fabric });
  const meta = await manager.create({ name: 'Ready Check', ...BASE });
  fabric.put(meta.id, { id: 'fabric-loader-0.15.7-1.20.1', mainClass: KNOT_CLIENT });

  const first = await manager.launch(meta.id);
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].id, 'fabric-loader-0.15.7-1.20.1', 'status must receive the fabric version, not "1.20.1"');
  assert.equal(installCalls.length, 1);
  assert.equal(launcher.calls.length, 1);
  assert.equal(first.source, 'fabric');

  await manager.stop(meta.id);
  await manager.launch(meta.id);
  assert.equal(installCalls.length, 1, 'a ready instance must not reinstall');
  assert.equal(launcher.calls.length, 2);
  await manager.stop(meta.id);
});

test('live: resolves a real fabric version and installs its libraries from the real maven', { skip: !process.env.TML_LIVE }, async () => {
  const { loadConfig } = await import('../../src/core/config.js');
  const { createMinecraftApi } = await import('../../src/minecraft/api.js');
  const { createFabricApi } = await import('../../src/fabric/api.js');
  const { createFabricInstaller } = await import('../../src/fabric/installer.js');
  const { createInstaller } = await import('../../src/minecraft/install.js');

  const config = loadConfig();
  const minecraft = createMinecraftApi({ config });
  const dir = tmpDir();
  const manager = createInstanceManager({ instancesDir: dir });
  const fabricInstaller = createFabricInstaller({ fabric: createFabricApi(), minecraft, manager });
  const installer = createInstaller({ cacheDir: path.join(dir, 'cache'), minecraft, config });

  const meta = await manager.create({ name: 'Live Launch', ...BASE });
  const resolved = await resolveLaunchVersion(meta, { fabric: fabricInstaller });

  assert.equal(resolved.source, 'fabric');
  assert.equal(resolved.id, `fabric-loader-${BASE.fabricLoaderVersion}-${BASE.minecraftVersion}`);
  assert.equal(resolved.version.mainClass, KNOT_CLIENT);
  assert.equal(resolved.cached, false, 'a fresh instance installs its fabric version on first launch');

  const include = ['libraries'];
  const before = await installer.status(resolved.version, { include });
  assert.equal(before.ready, false, 'fabric libraries are not part of the vanilla install');

  const result = await installer.install(resolved.version, { include });
  assert.ok(result.files.total > 0, 'fabric and vanilla libraries must download');

  const after = await installer.status(resolved.version, { include });
  assert.equal(after.ready, true);

  const plan = await installer.plan(resolved.version);
  assert.equal(plan.mainClass, KNOT_CLIENT);
  const fabricLoaderLib = plan.libraries.find((library) => library.path.startsWith('net/fabricmc/fabric-loader/'));
  assert.ok(fabricLoaderLib, 'the merged plan must include the fabric loader library');
  assert.ok(fabricLoaderLib.url.startsWith('https://maven.fabricmc.net/'));
  assert.ok(fs.existsSync(fabricLoaderLib.dest), 'fabric loader jar must land in the shared cache');

  const again = await installer.install(resolved.version, { include });
  assert.equal(again.files.downloaded, 0, 'a second run must serve every library from cache');

  const second = await resolveLaunchVersion(meta, { fabric: fabricInstaller });
  assert.equal(second.cached, true, 'the instance fabric version file now exists');
});
