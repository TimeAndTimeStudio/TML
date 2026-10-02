// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { SourceNotAllowedError } from '../../src/core/errors.js';
import { hashBuffer } from '../../src/download/hash.js';
import { writeZipFile } from '../../src/archive/zip.js';
import { createInstanceManager } from '../../src/instance/manager.js';
import { createInstanceExporter } from '../../src/instance/export.js';
import { createInstanceImporter } from '../../src/instance/import.js';
import { createModInstaller } from '../../src/mods/install.js';

const localOnly = (input) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new SourceNotAllowedError(`Host not allowed: ${url.hostname}`, {
      details: { host: url.hostname },
    });
  }
  return url;
};

const BASE = Object.freeze({ minecraftVersion: '1.20.1', fabricLoaderVersion: '0.15.7' });

const A_MOD = Buffer.from('sodium jar for the DoD workflow\n'.repeat(4));
const A_MOD_HASHES = hashBuffer(A_MOD, ['sha1', 'sha512']);

const SODIUM_VERSION = Object.freeze({
  id: 'sodium-dod',
  projectId: 'sodium-project',
  versionNumber: '0.5.8',
  name: 'Sodium',
  changelog: '',
  gameVersions: ['1.20.1'],
  loaders: ['fabric'],
  versionType: 'release',
  status: 'listed',
  datePublished: '2026-01-01T00:00:00Z',
  downloads: 1,
  featured: false,
  files: Object.freeze([
    Object.freeze({
      filename: 'sodium-dod.jar',
      url: 'PLACEHOLDER/sodium-dod.jar',
      primary: true,
      size: A_MOD.length,
      sha1: A_MOD_HASHES.sha1,
      sha512: A_MOD_HASHES.sha512,
    }),
  ]),
  dependencies: Object.freeze([]),
});

function createFakeLauncher() {
  const handles = [];
  return {
    handles,
    async launch(version, opts) {
      let settle;
      const exited = new Promise((resolve) => {
        settle = resolve;
      });
      const handle = {
        pid: 9700 + handles.length,
        cwd: opts.gameDir,
        version,
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

function createFakeInstaller() {
  let ready = false;
  return {
    async status(version) {
      return { id: version, ready };
    },
    async install(version) {
      ready = true;
      return { id: version };
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
let upstream;
let manager;
let exporter;
let importer;
let installer;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-dod-'));
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });

  upstream = http.createServer((req, res) => {
    if (req.url === '/sodium-dod.jar') {
      res.writeHead(200, { 'content-type': 'application/java-archive' });
      res.end(A_MOD);
      return;
    }
    res.writeHead(404).end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const base = `http://127.0.0.1:${upstream.address().port}`;

  const modrinth = {
    async getVersion(versionId) {
      if (versionId !== SODIUM_VERSION.id) {
        const err = new Error('not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      return {
        ...SODIUM_VERSION,
        files: SODIUM_VERSION.files.map((file) => ({ ...file, url: `${base}${file.url.replace('PLACEHOLDER', '')}` })),
      };
    },
  };

  manager = createInstanceManager({
    instancesDir: path.join(root, 'instances'),
    launcher: createFakeLauncher(),
    fabric: createFakeFabric(),
    installer: createFakeInstaller(),
  });
  exporter = createInstanceExporter({ manager, writeZip: writeZipFile, exportsDir: path.join(root, 'exports') });
  importer = createInstanceImporter({ manager, tempRoot: path.join(root, 'tmp') });
  installer = createModInstaller({ manager, modrinth, validator: localOnly });
});

after(async () => {
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

test('A, B and C stay fully independent through the whole workflow', async () => {
  // Create Instance A and Instance B
  const a = await manager.create({ id: 'packa', name: 'Pack A', ...BASE });
  const b = await manager.create({ id: 'packb', name: 'Pack B', ...BASE });
  assert.notEqual(a.id, b.id);

  // Install mods → A เท่านั้น
  const installed = await installer.install(a.id, SODIUM_VERSION.id);
  assert.equal(installed.installed, true);
  const aMods = await installer.list(a.id);
  const bMods = await installer.list(b.id);
  assert.equal(aMods.length, 1, 'A must have exactly one mod');
  assert.equal(bMods.length, 0, 'B must not inherit mods from A');
  assert.equal(
    fs.existsSync(path.join(manager.paths(b.id).modsDir, 'sodium-dod.jar')),
    false,
    'B mods directory must stay empty on disk'
  );

  // Changing A config never changes B
  const bConfigBefore = fs.readFileSync(path.join(manager.paths(b.id).gameDir, 'options.txt'), 'utf8');
  fs.writeFileSync(path.join(manager.paths(a.id).gameDir, 'options.txt'), 'fov:110\n');
  assert.equal(
    fs.readFileSync(path.join(manager.paths(b.id).gameDir, 'options.txt'), 'utf8'),
    bConfigBefore,
    'B must keep its own options.txt'
  );

  // PLAY A then PLAY B — two processes, two game directories
  const playA = await manager.launch(a.id);
  const playB = await manager.launch(b.id);
  assert.notEqual(playA.pid, playB.pid);
  assert.notEqual(playA.gameDir, playB.gameDir);
  assert.equal(playA.gameDir, manager.paths(a.id).gameDir);
  assert.equal(playB.gameDir, manager.paths(b.id).gameDir);
  await manager.stop(a.id);
  await manager.stop(b.id);

  // Export A → Import → Instance C
  const zip = await exporter.export(a.id);
  const c = await importer.import(zip.path, { id: 'packc', name: 'Pack C' });
  assert.equal(c.instanceId, 'packc');

  // แก้ C แล้วตรวจ A ต้องไม่เปลี่ยน
  fs.writeFileSync(path.join(manager.paths(c.instanceId).modsDir, 'sodium-dod.jar'), 'tampered in C');
  fs.writeFileSync(path.join(manager.paths(c.instanceId).gameDir, 'options.txt'), 'fov:99\n');
  assert.equal(
    fs.readFileSync(path.join(manager.paths(a.id).modsDir, 'sodium-dod.jar'), 'utf8'),
    A_MOD.toString('utf8'),
    'A mods must be untouched by edits in C'
  );
  assert.equal(
    fs.readFileSync(path.join(manager.paths(a.id).gameDir, 'options.txt'), 'utf8'),
    'fov:110\n',
    'A options must be untouched by edits in C'
  );

  // A ≠ B ≠ C — ids, directories and mod state are all distinct
  const ids = [a.id, b.id, c.instanceId];
  assert.equal(new Set(ids).size, 3);
  const dirs = ids.map((id) => fs.realpathSync(manager.paths(id).dir));
  assert.equal(new Set(dirs).size, 3, 'every instance owns a separate directory');
  assert.equal((await installer.list(a.id)).length, 1);
  assert.equal((await installer.list(b.id)).length, 0);
  assert.equal((await installer.list(c.instanceId)).length, 1);

  // Delete B — only instances/packb disappears
  await manager.delete(b.id);
  assert.equal(fs.existsSync(manager.paths(b.id).dir), false);
  assert.equal(fs.existsSync(manager.paths(a.id).dir), true);
  assert.equal(fs.existsSync(manager.paths(c.instanceId).dir), true);
  assert.equal((await installer.list(a.id)).length, 1, 'deleting B must not touch A');
});
