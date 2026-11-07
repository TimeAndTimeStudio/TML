import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installBundledInstances } from '../../src/instance/bundled.js';
import { createInstanceManager } from '../../src/instance/manager.js';

test('bundled client installs once without replacing user data or deleted instances', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tml-bundled-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const bundledDir = path.join(root, 'bundles');
  const dataDir = path.join(root, 'user');
  const instancesDir = path.join(dataDir, 'instances');
  const options = { bundledDir, dataDir, instancesDir };
  const template = path.join(bundledDir, 'Main-26.2');
  await fsp.mkdir(path.join(template, 'minecraft', 'mods'), { recursive: true });
  await fsp.writeFile(path.join(template, 'instance.json'), JSON.stringify({
    name: 'Main', type: 'client', minecraftVersion: '26.2', loader: 'fabric', fabricLoaderVersion: '0.20.1',
  }));
  await fsp.writeFile(path.join(template, 'minecraft', 'mods', 'test.jar'), 'client');
  const ids = await installBundledInstances(options);
  assert.equal(ids.length, 1);
  const manager = createInstanceManager({ instancesDir });
  const instances = await manager.list();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].type, 'client');
  const client = instances[0];
  const clientMod = path.join(manager.paths(client.id).gameDir, 'mods', 'test.jar');
  assert.equal(await fsp.readFile(clientMod, 'utf8'), 'client');

  // A second run is a no-op - user data is never replaced.
  await fsp.writeFile(clientMod, 'user modified');
  assert.deepEqual(await installBundledInstances(options), []);
  assert.equal(await fsp.readFile(clientMod, 'utf8'), 'user modified');

  // A deleted instance is not restored while the first-run marker is complete.
  await fsp.rm(manager.paths(client.id).dir, { recursive: true });
  assert.deepEqual(await installBundledInstances(options), []);
  assert.deepEqual(await fsp.readdir(instancesDir), []);
  assert.deepEqual(await manager.list(), []);

  // Losing the first-run marker re-runs first-run setup and restores the bundle.
  await fsp.rm(path.join(dataDir, 'bundled-instances.json'));
  assert.equal((await installBundledInstances(options)).length, 1);
  assert.equal(await fsp.readFile(clientMod, 'utf8'), 'client');
});

test('a failed bundled copy does not publish a partial instance', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tml-bundled-failed-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const bundledDir = path.join(root, 'bundles');
  const source = path.join(bundledDir, 'broken');
  await fsp.mkdir(source, { recursive: true });
  await fsp.writeFile(path.join(source, 'instance.json'), JSON.stringify({
    name: 'Broken', type: 'client', minecraftVersion: '26.2', loader: 'fabric', fabricLoaderVersion: '0.20.1',
  }));
  await fsp.writeFile(path.join(source, 'minecraft'), 'not a directory');
  const instancesDir = path.join(root, 'instances');
  await assert.rejects(installBundledInstances({ bundledDir, dataDir: root, instancesDir }));
  assert.deepEqual(await fsp.readdir(instancesDir), []);
});

