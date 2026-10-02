// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createInstanceManager } from '../../src/instance/manager.js';
import {
  validateInstanceMeta,
  validateInstanceId,
  validateInstanceName,
  parseMemory,
} from '../../src/instance/validate.js';

const BASE = Object.freeze({
  name: 'Survival',
  minecraftVersion: '1.20.1',
  fabricLoaderVersion: '0.15.7',
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tml-instance-'));
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
        cwd: opts.gameDir,
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

function createFakeInstaller() {
  const statusCalls = [];
  const installCalls = [];
  let ready = false;
  return {
    statusCalls,
    installCalls,
    setReady(value) {
      ready = value;
    },
    async status(version) {
      statusCalls.push(version);
      return { id: version, ready };
    },
    async install(version) {
      installCalls.push(version);
      ready = true;
      return { id: version };
    },
  };
}

const FABRIC_ID = 'fabric-loader-0.15.7-1.20.1';

function createFakeFabric() {
  const versionForCalls = [];
  const installCalls = [];
  const versions = new Map();
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
      if (!versions.has(id)) versions.set(id, { id: FABRIC_ID, mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient' });
      return { id: FABRIC_ID, installed: true };
    },
  };
}

const versionValue = (value) => (value && typeof value === 'object' ? value.id : value);

test('create builds the instance structure with metadata', async () => {
  const dir = tmpDir();
  const manager = createInstanceManager({ instancesDir: dir });

  const meta = await manager.create({ ...BASE });

  assert.ok(Object.isFrozen(meta));
  assert.match(meta.id, /^[a-z0-9]{8}$/);
  assert.equal(meta.loader, 'fabric');
  assert.equal(meta.java, 'minecraft-bundled');
  assert.deepEqual(meta.memory, { min: '512M', max: '4096M' });

  const instanceDir = path.join(dir, meta.id);
  for (const rel of [
    'instance.json',
    'minecraft/mods',
    'minecraft/config',
    'minecraft/saves',
    'minecraft/resourcepacks',
    'minecraft/shaderpacks',
    'minecraft/options.txt',
  ]) {
    assert.ok(fs.existsSync(path.join(instanceDir, rel)), `missing ${rel}`);
  }

  const onDisk = JSON.parse(fs.readFileSync(path.join(instanceDir, 'instance.json'), 'utf8'));
  assert.deepEqual(onDisk, meta);
});

test('validation rejects unsupported or unsafe instance input', async () => {
  const dir = tmpDir();
  const manager = createInstanceManager({ instancesDir: dir });

  const cases = [
    [{ ...BASE, id: '../evil' }, 'INVALID_INSTANCE_ID'],
    [{ ...BASE, id: 'UPPER' }, 'INVALID_INSTANCE_ID'],
    [{ ...BASE, id: 'a/b' }, 'INVALID_INSTANCE_ID'],
    [{ ...BASE, name: '   ' }, 'INVALID_INSTANCE_NAME'],
    [{ ...BASE, minecraftVersion: '../../x' }, 'INVALID_VERSION_ID'],
    [{ ...BASE, fabricLoaderVersion: '' }, 'INVALID_VERSION_ID'],
    [{ ...BASE, loader: 'forge' }, 'INVALID_LOADER'],
    [{ ...BASE, java: 'openjdk' }, 'INVALID_JAVA'],
    [{ ...BASE, memory: { min: 'lots', max: '4096M' } }, 'INVALID_MEMORY'],
    [{ ...BASE, memory: { min: '8G', max: '4G' } }, 'INVALID_MEMORY'],
    [{ ...BASE, memory: { min: '1G' } }, 'INVALID_MEMORY'],
    [{ ...BASE, loader: null }, 'INVALID_LOADER'],
    [{ ...BASE, extraJvmArgs: '-Xmx2G' }, 'INVALID_EXTRA_ARGS'],
    [{ ...BASE, extraJvmArgs: [''] }, 'INVALID_EXTRA_ARGS'],
    [{ ...BASE, extraGameArgs: [42] }, 'INVALID_EXTRA_ARGS'],
    [{ ...BASE, extraGameArgs: [`x${String.fromCharCode(7)}`] }, 'INVALID_EXTRA_ARGS'],
  ];

  for (const [input, code] of cases) {
    await assert.rejects(manager.create(input), { code }, `expected ${code}`);
  }
  assert.deepEqual(fs.readdirSync(dir), []);

  await assert.rejects(manager.create(null), { code: 'INVALID_INSTANCE_NAME' });
  await assert.rejects(manager.create({}), { code: 'INVALID_INSTANCE_NAME' });
});

test('create refuses to overwrite an existing instance', async () => {
  const dir = tmpDir();
  const manager = createInstanceManager({ instancesDir: dir });

  await manager.create({ ...BASE, id: 'alpha1' });
  await assert.rejects(manager.create({ ...BASE, id: 'alpha1' }), {
    code: 'INSTANCE_EXISTS',
    status: 409,
  });
});

test('get returns metadata, list sorts by name and skips corrupt entries', async () => {
  const dir = tmpDir();
  const warnings = [];
  const logger = {
    debug() {},
    info() {},
    error() {},
    warn: (message, meta) => warnings.push({ message, meta }),
  };
  const manager = createInstanceManager({ instancesDir: dir, logger });

  await manager.create({ ...BASE, id: 'aaa', name: 'Bravo' });
  await manager.create({ ...BASE, id: 'bbb', name: 'Alpha' });

  const got = await manager.get('aaa');
  assert.equal(got.name, 'Bravo');
  await assert.rejects(manager.get('nope'), { code: 'INSTANCE_NOT_FOUND', status: 404 });

  const listed = await manager.list();
  assert.deepEqual(
    listed.map((entry) => entry.id),
    ['bbb', 'aaa']
  );

  fs.mkdirSync(path.join(dir, 'ccc'));
  fs.writeFileSync(path.join(dir, 'ccc', 'instance.json'), '{oops');
  const afterCorrupt = await manager.list();
  assert.equal(afterCorrupt.length, 2);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].meta.id, 'ccc');
  assert.equal(warnings[0].meta.code, 'INSTANCE_CORRUPT');
  await assert.rejects(manager.get('ccc'), { code: 'INSTANCE_CORRUPT' });

  const fresh = createInstanceManager({ instancesDir: path.join(dir, 'does-not-exist') });
  assert.deepEqual(await fresh.list(), []);
});

test('rename updates only the metadata name and keeps the id', async () => {
  const dir = tmpDir();
  const manager = createInstanceManager({ instancesDir: dir });
  await manager.create({ ...BASE, id: 'keep' });

  const renamed = await manager.rename('keep', 'Renamed!');
  assert.equal(renamed.name, 'Renamed!');
  assert.equal(renamed.id, 'keep');
  assert.ok(fs.existsSync(path.join(dir, 'keep', 'minecraft')));

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'keep', 'instance.json'), 'utf8'));
  assert.equal(onDisk.name, 'Renamed!');

  await assert.rejects(manager.rename('keep', '   '), { code: 'INVALID_INSTANCE_NAME' });
  await assert.rejects(manager.rename('ghost', 'X'), { code: 'INSTANCE_NOT_FOUND' });
});

test('duplicate copies every file and never shares state with the original', async () => {
  const dir = tmpDir();
  const manager = createInstanceManager({ instancesDir: dir });
  const alpha = await manager.create({ ...BASE, id: 'alpha' });

  const sodium = path.join(dir, 'alpha', 'minecraft', 'mods', 'sodium.jar');
  fs.writeFileSync(sodium, 'v1');
  const bait = path.join(dir, 'bait.txt');
  fs.writeFileSync(bait, 'bait');
  fs.symlinkSync(bait, path.join(dir, 'alpha', 'minecraft', 'config', 'link.cfg'));

  const beta = await manager.duplicate('alpha');
  assert.notEqual(beta.id, 'alpha');
  assert.equal(beta.name, `${alpha.name} (copy)`);

  const betaFile = path.join(dir, beta.id, 'minecraft', 'mods', 'sodium.jar');
  assert.equal(fs.readFileSync(betaFile, 'utf8'), 'v1');

  fs.writeFileSync(sodium, 'v2');
  assert.equal(fs.readFileSync(betaFile, 'utf8'), 'v1');

  const betaLink = path.join(dir, beta.id, 'minecraft', 'config', 'link.cfg');
  const linkStat = fs.lstatSync(betaLink);
  assert.ok(linkStat.isFile() && !linkStat.isSymbolicLink());
  assert.equal(fs.readFileSync(betaLink, 'utf8'), 'bait');

  assert.notEqual(
    fs.realpathSync(path.join(dir, 'alpha')),
    fs.realpathSync(path.join(dir, beta.id))
  );

  const gamma = await manager.duplicate('alpha');
  assert.notEqual(gamma.id, beta.id);
});

test('delete removes exactly one instance directory', async () => {
  const dir = tmpDir();
  const manager = createInstanceManager({ instancesDir: dir });
  await manager.create({ ...BASE, id: 'gone' });
  await manager.create({ ...BASE, id: 'stay' });
  fs.writeFileSync(path.join(dir, 'sentinel.txt'), 'keep me');

  const result = await manager.delete('gone');
  assert.deepEqual(result, { id: 'gone', deleted: true });

  assert.ok(!fs.existsSync(path.join(dir, 'gone')));
  assert.ok(fs.existsSync(path.join(dir, 'stay', 'instance.json')));
  assert.equal(fs.readFileSync(path.join(dir, 'sentinel.txt'), 'utf8'), 'keep me');

  await assert.rejects(manager.delete('gone'), { code: 'INSTANCE_NOT_FOUND', status: 404 });
  await assert.rejects(manager.delete('../outside'), { code: 'INVALID_INSTANCE_ID' });
});

test('instances never share mods, config or game directory', async () => {
  const dir = tmpDir();
  const manager = createInstanceManager({ instancesDir: dir });
  await manager.create({ ...BASE, id: 'a1', name: 'A' });
  await manager.create({ ...BASE, id: 'b2', name: 'B' });

  fs.writeFileSync(path.join(dir, 'a1', 'minecraft', 'mods', 'iris.jar'), 'iris');

  assert.ok(fs.existsSync(path.join(dir, 'a1', 'minecraft', 'mods', 'iris.jar')));
  assert.ok(!fs.existsSync(path.join(dir, 'b2', 'minecraft', 'mods', 'iris.jar')));

  const pathsA = manager.paths('a1');
  const pathsB = manager.paths('b2');
  assert.notEqual(pathsA.gameDir, pathsB.gameDir);
  assert.notEqual(fs.realpathSync(pathsA.gameDir), fs.realpathSync(pathsB.gameDir));
});

test('launch installs the instance version and starts in its own game directory', async () => {
  const dir = tmpDir();
  const launcher = createFakeLauncher();
  const installer = createFakeInstaller();
  const fabric = createFakeFabric();
  fabric.put('play1', { id: FABRIC_ID });
  const manager = createInstanceManager({ instancesDir: dir, launcher, installer, fabric });

  await manager.create({ ...BASE, id: 'play1', minecraftVersion: '1.20.1', extraJvmArgs: ['-Dtml.probe=1'], extraGameArgs: ['--tml-flag'] });
  const result = await manager.launch('play1', { auth: { username: 'Steve' } });

  assert.deepEqual(installer.statusCalls.map(versionValue), [FABRIC_ID], 'installer must receive the fabric version, not the vanilla id');
  assert.deepEqual(installer.installCalls.map(versionValue), [FABRIC_ID]);
  assert.deepEqual(fabric.versionForCalls, ['play1']);
  assert.deepEqual(fabric.installCalls, [], 'fabric version file already exists');
  assert.equal(launcher.calls.length, 1);
  assert.equal(launcher.calls[0].version.id, FABRIC_ID);
  assert.equal(launcher.calls[0].opts.gameDir, path.join(dir, 'play1', 'minecraft'));
  assert.deepEqual(launcher.calls[0].opts.extraJvmArgs, ['-Dtml.probe=1'], 'custom jvm args must reach the launcher');
  assert.deepEqual(launcher.calls[0].opts.extraGameArgs, ['--tml-flag'], 'custom game args must reach the launcher');
  assert.equal(result.gameDir, path.join(dir, 'play1', 'minecraft'));
  assert.equal(result.version, FABRIC_ID);
  assert.equal(result.source, 'fabric');
  assert.equal(result.pid, launcher.handles[0].pid);
  const live = manager.status('play1');
  assert.deepEqual(
    { id: live.id, running: live.running, pid: live.pid },
    { id: 'play1', running: true, pid: result.pid }
  );
  assert.ok(live.sessionSeconds >= 0, 'status reports live session seconds while running');

  await manager.stop('play1');
  await manager.launch('play1');
  assert.equal(installer.installCalls.length, 1);
  await manager.stop('play1');
});

test('two instances run side by side and stop independently (no global state)', async () => {
  const dir = tmpDir();
  const launcher = createFakeLauncher();
  const fabric = createFakeFabric();
  fabric.put('one', { id: FABRIC_ID });
  fabric.put('two', { id: FABRIC_ID });
  const manager = createInstanceManager({ instancesDir: dir, launcher, fabric });

  await manager.create({ ...BASE, id: 'one' });
  await manager.create({ ...BASE, id: 'two' });

  const first = await manager.launch('one');
  const second = await manager.launch('two');
  assert.notEqual(first.gameDir, second.gameDir);
  assert.notEqual(first.pid, second.pid);
  assert.deepEqual(fabric.versionForCalls, ['one', 'two'], 'each instance resolves fabric through its own id');

  await assert.rejects(manager.launch('one'), {
    code: 'INSTANCE_ALREADY_RUNNING',
    status: 409,
  });

  await manager.stop('one');
  assert.equal(manager.status('one').running, false);
  assert.equal(manager.status('two').running, true);

  await manager.stop('two');
  await assert.rejects(manager.stop('one'), { code: 'INSTANCE_NOT_RUNNING', status: 404 });

  const deleted = await manager.delete('two');
  assert.equal(deleted.deleted, true);
  assert.ok(!fs.existsSync(path.join(dir, 'two')));
});

test('an exited process frees the instance and running instances cannot be deleted', async () => {
  const dir = tmpDir();
  const launcher = createFakeLauncher();
  const fabric = createFakeFabric();
  fabric.put('solo', { id: FABRIC_ID });
  const manager = createInstanceManager({ instancesDir: dir, launcher, fabric });

  await manager.create({ ...BASE, id: 'solo' });
  await manager.launch('solo');
  await assert.rejects(manager.delete('solo'), { code: 'INSTANCE_RUNNING', status: 409 });

  launcher.handles[0].finish({ code: 0, signal: null, error: null });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(manager.status('solo').running, false);

  const relaunched = await manager.launch('solo');
  assert.equal(relaunched.pid, launcher.handles[1].pid);
  await manager.stop('solo');
});

test('validation helpers normalize and reject', () => {
  assert.equal(parseMemory('512M'), 536870912);
  assert.equal(parseMemory('2G'), 2 * 1024 ** 3);
  assert.equal(validateInstanceName('  Packed  '), 'Packed');
  assert.equal(validateInstanceId('abc_1'), 'abc_1');
  assert.throws(() => validateInstanceId('a/b'), { code: 'INVALID_INSTANCE_ID' });
  assert.throws(() => parseMemory('0M'), { code: 'INVALID_MEMORY' });

  const bellName = `bad${String.fromCharCode(7)}bell`;
  assert.throws(() => validateInstanceName(bellName), { code: 'INVALID_INSTANCE_NAME' });

  const meta = validateInstanceMeta({
    id: 'x1',
    name: 'N',
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    fabricLoaderVersion: '0.15.7',
  });
  assert.equal(meta.java, 'minecraft-bundled');
  assert.deepEqual(meta.memory, { min: '512M', max: '4096M' });
  assert.deepEqual(meta.extraJvmArgs, [], 'extra args default to empty');
  assert.deepEqual(meta.extraGameArgs, [], 'extra args default to empty');
  assert.equal(meta.playSeconds, 0, 'playSeconds defaults to 0');
  assert.equal(meta.lastPlayedAt, null, 'lastPlayedAt defaults to null');
  assert.ok(Object.isFrozen(meta));
  assert.ok(Object.isFrozen(meta.extraJvmArgs));

  const withArgs = validateInstanceMeta({
    id: 'x2',
    name: 'N',
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    fabricLoaderVersion: '0.15.7',
    extraJvmArgs: ['-Dfoo=1'],
    extraGameArgs: ['--demo'],
  });
  assert.deepEqual(withArgs.extraJvmArgs, ['-Dfoo=1']);
  assert.deepEqual(withArgs.extraGameArgs, ['--demo']);

  assert.throws(
    () => validateInstanceMeta({ id: 'x3', name: 'N', minecraftVersion: '1.20.1', loader: 'fabric', fabricLoaderVersion: '0.15.7', extraJvmArgs: ['a'.repeat(600)] }),
    { code: 'INVALID_EXTRA_ARGS' }
  );
  assert.throws(
    () => validateInstanceMeta({ id: 'x4', name: 'N', minecraftVersion: '1.20.1', loader: 'fabric', fabricLoaderVersion: '0.15.7', extraGameArgs: new Array(65).fill('--x') }),
    { code: 'INVALID_EXTRA_ARGS' }
  );

  const ptBase = { id: 'x5', name: 'N', minecraftVersion: '1.20.1', loader: 'fabric', fabricLoaderVersion: '0.15.7' };
  assert.equal(validateInstanceMeta({ ...ptBase, playSeconds: 42 }).playSeconds, 42);
  assert.equal(validateInstanceMeta({ ...ptBase, lastPlayedAt: '2026-10-02T10:00:00.000Z' }).lastPlayedAt, '2026-10-02T10:00:00.000Z');
  assert.throws(() => validateInstanceMeta({ ...ptBase, playSeconds: -1 }), { code: 'INVALID_PLAY_SECONDS' });
  assert.throws(() => validateInstanceMeta({ ...ptBase, playSeconds: 1.5 }), { code: 'INVALID_PLAY_SECONDS' });
  assert.throws(() => validateInstanceMeta({ ...ptBase, playSeconds: '10' }), { code: 'INVALID_PLAY_SECONDS' });
  assert.throws(() => validateInstanceMeta({ ...ptBase, lastPlayedAt: 'nope' }), { code: 'INVALID_LAST_PLAYED_AT' });
});

test('playtime accumulates across sessions and status ticks live seconds', async () => {
  const dir = tmpDir();
  const launcher = createFakeLauncher();
  const installer = createFakeInstaller();
  const fabric = createFakeFabric();
  fabric.put('ptime', { id: FABRIC_ID });
  const manager = createInstanceManager({ instancesDir: dir, launcher, installer, fabric });

  await manager.create({ ...BASE, id: 'ptime', minecraftVersion: '1.20.1' });

  const fresh = JSON.parse(fs.readFileSync(path.join(dir, 'ptime', 'instance.json'), 'utf8'));
  assert.equal(fresh.playSeconds, 0, 'new instances start at 0 seconds');
  assert.equal(fresh.lastPlayedAt, null, 'new instances have never been played');

  await manager.launch('ptime');
  assert.ok(manager.status('ptime').sessionSeconds >= 0);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(manager.status('ptime').sessionSeconds >= 1, 'session seconds tick while the game runs');

  await manager.stop('ptime');
  let meta = JSON.parse(fs.readFileSync(path.join(dir, 'ptime', 'instance.json'), 'utf8'));
  assert.ok(meta.playSeconds >= 1, `session time must persist on exit, got ${meta.playSeconds}`);
  assert.ok(meta.lastPlayedAt, 'lastPlayedAt must be recorded on exit');
  assert.equal(manager.status('ptime').sessionSeconds, 0, 'no session seconds when stopped');

  await manager.launch('ptime');
  await manager.stop('ptime');
  meta = JSON.parse(fs.readFileSync(path.join(dir, 'ptime', 'instance.json'), 'utf8'));
  assert.ok(meta.playSeconds >= 1, 'second session accumulates on top of the first');
  assert.ok(meta.lastPlayedAt, 'lastPlayedAt survives later sessions');
});
