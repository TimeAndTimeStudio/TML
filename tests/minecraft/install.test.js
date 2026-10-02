// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildZip } from '../helpers/zip.js';
import { hashBuffer } from '../../src/download/hash.js';
import {
  ASSET_HOST,
  INSTALL_SECTIONS,
  INSTALL_STAGES,
  LIBRARY_HOST,
  buildAssetTasks,
  computeExpectedBytes,
  createInstaller,
  createLayout,
  detectPlatform,
  evaluateRules,
  mavenPath,
  normalizeInclude,
  planVersion,
} from '../../src/minecraft/install.js';
import {
  CancelledError,
  ConfigError,
  CorruptDataError,
  InstallError,
  SourceNotAllowedError,
  ValidationError,
} from '../../src/core/errors.js';

const sha1 = (data) => hashBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), ['sha1']).sha1;

const localOnly = (input) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new SourceNotAllowedError(`Host not allowed: ${url.hostname}`, {
      details: { host: url.hostname },
    });
  }
  return url;
};

const clientBytes = Buffer.from('TML fake client jar\n'.repeat(8));
const coreBytes = Buffer.from('core library bytes');
const bindingBytes = Buffer.from('lwjgl binding bytes');
const winOnlyBytes = Buffer.from('windows only library');
const loggingXml = Buffer.from('<?xml version="1.0"?><configuration><root level="INFO"/></configuration>');
const assetA = Buffer.from('asset-a-bytes');
const assetB = Buffer.from('asset-b-bytes');
const nativesJar = buildZip([
  { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\n' },
  { name: 'linux/x64/org/lwjgl/liblwjgl.so', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]), method: 'deflate' },
  { name: 'license.txt', data: 'LWJGL license', method: 'deflate' },
]);

const assetAHash = sha1(assetA);
const assetBHash = sha1(assetB);

const assetIndexJson = Buffer.from(
  JSON.stringify(
    {
      objects: {
        'minecraft/notices/a.txt': { hash: assetAHash, size: assetA.length },
        'minecraft/notices/a-copy.txt': { hash: assetAHash, size: assetA.length },
        'minecraft/notices/b.txt': { hash: assetBHash, size: assetB.length },
      },
    },
    null,
    2,
  ),
);

let server;
let baseUrl;
let tmpRoot;
const routes = new Map();
const hits = new Map();

function route(pathname, body, { delayMs = 0 } = {}) {
  routes.set(pathname, { body, delayMs });
}

function hitCount(pathname) {
  return hits.get(pathname) ?? 0;
}

function makeLibraries() {
  return [
    {
      name: 'com.example:core:1.0.0',
      downloads: {
        artifact: {
          path: 'com/example/core/1.0.0/core-1.0.0.jar',
          sha1: sha1(coreBytes),
          size: coreBytes.length,
          url: `${baseUrl}/libs/core.jar`,
        },
      },
    },
    {
      name: 'com.example:win-only:1.0.0',
      rules: [{ action: 'allow', os: { name: 'windows' } }],
      downloads: {
        artifact: {
          path: 'com/example/win-only/1.0.0/win-only-1.0.0.jar',
          sha1: sha1(winOnlyBytes),
          size: winOnlyBytes.length,
          url: `${baseUrl}/libs/win-only.jar`,
        },
      },
    },
    {
      name: 'org.lwjgl.lwjgl:lwjgl:2.9.4',
      natives: { linux: 'natives-linux', osx: 'natives-osx', windows: 'natives-windows' },
      extract: { exclude: ['META-INF/'] },
      downloads: {
        artifact: {
          path: 'org/lwjgl/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4.jar',
          sha1: sha1(bindingBytes),
          size: bindingBytes.length,
          url: `${baseUrl}/libs/binding.jar`,
        },
        classifiers: {
          'natives-linux': {
            path: 'org/lwjgl/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4-natives-linux.jar',
            sha1: sha1(nativesJar),
            size: nativesJar.length,
            url: `${baseUrl}/libs/natives-linux.jar`,
          },
          'natives-windows': {
            path: 'org/lwjgl/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4-natives-windows.jar',
            sha1: '1'.repeat(40),
            size: 10,
            url: `${baseUrl}/libs/natives-windows.jar`,
          },
          'natives-osx': {
            path: 'org/lwjgl/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4-natives-osx.jar',
            sha1: '2'.repeat(40),
            size: 10,
            url: `${baseUrl}/libs/natives-osx.jar`,
          },
        },
      },
    },
  ];
}

function makeVersion(overrides = {}) {
  return {
    id: '1.99.9-tml',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: 'tml',
    assetIndex: {
      id: 'tml',
      sha1: sha1(assetIndexJson),
      size: assetIndexJson.length,
      totalSize: assetA.length + assetB.length,
      url: `${baseUrl}/asset_indexes/tml.json`,
    },
    downloads: {
      client: { sha1: sha1(clientBytes), size: clientBytes.length, url: `${baseUrl}/client.jar` },
    },
    logging: {
      client: {
        file: {
          id: 'client-1.99.xml',
          sha1: sha1(loggingXml),
          size: loggingXml.length,
          url: `${baseUrl}/logging/client-1.99.xml`,
        },
      },
    },
    javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
    libraries: makeLibraries(),
    ...overrides,
  };
}

function legacyVersion() {
  const base = 'https://libraries.minecraft.net';
  return {
    id: '1.7.10-fake',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Minecraft',
    downloads: {
      client: { url: 'https://piston-data.mojang.com/v1/objects/dead/client.jar', sha1: 'a'.repeat(40), size: 1000 },
    },
    assetIndex: {
      id: '1.7.10',
      sha1: 'b'.repeat(40),
      size: 500,
      totalSize: 999,
      url: 'https://piston-meta.mojang.com/v1/packages/bbbbbb/1.7.10.json',
    },
    libraries: [
      {
        name: 'org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209',
        natives: { windows: 'natives-windows', linux: 'natives-linux', osx: 'natives-osx' },
        extract: { exclude: ['META-INF/'] },
        downloads: {
          artifact: {
            path: 'org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209.jar',
            sha1: 'c'.repeat(40),
            size: 300,
            url: `${base}/org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209.jar`,
          },
          classifiers: {
            'natives-linux': {
              path: 'org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209-natives-linux.jar',
              sha1: 'd'.repeat(40),
              size: 400,
              url: `${base}/org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209-natives-linux.jar`,
            },
            'natives-windows': {
              path: 'org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209-natives-windows.jar',
              sha1: 'e'.repeat(40),
              size: 410,
              url: `${base}/org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209-natives-windows.jar`,
            },
            'natives-osx': {
              path: 'org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209-natives-osx.jar',
              sha1: 'f'.repeat(40),
              size: 420,
              url: `${base}/org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209-natives-osx.jar`,
            },
          },
        },
      },
      {
        name: 'com.example:arch-lib:1.0',
        natives: { linux: 'natives-linux-${arch}' },
        downloads: {
          classifiers: {
            'natives-linux-64': {
              path: 'com/example/arch-lib/1.0/arch-lib-1.0-natives-linux-64.jar',
              sha1: '9'.repeat(40),
              size: 42,
              url: `${base}/com/example/arch-lib/1.0/arch-lib-1.0-natives-linux-64.jar`,
            },
          },
        },
      },
      {
        name: 'com.example:windows-only:1.0',
        rules: [{ action: 'allow', os: { name: 'windows' } }],
        downloads: {
          artifact: {
            path: 'com/example/windows-only/1.0/windows-only-1.0.jar',
            sha1: '7'.repeat(40),
            size: 5,
            url: `${base}/com/example/windows-only/1.0/windows-only-1.0.jar`,
          },
        },
      },
      {
        name: 'com.example:osx-only:1.0',
        rules: [{ action: 'disallow' }, { action: 'allow', os: { name: 'osx' } }],
        downloads: {
          artifact: {
            path: 'com/example/osx-only/1.0/osx-only-1.0.jar',
            sha1: '6'.repeat(40),
            size: 5,
            url: `${base}/com/example/osx-only/1.0/osx-only-1.0.jar`,
          },
        },
      },
      { name: 'com.example:legacy:1.0' },
    ],
  };
}

before(async () => {
  route('/client.jar', clientBytes);
  route('/libs/core.jar', coreBytes);
  route('/libs/binding.jar', bindingBytes);
  route('/libs/natives-linux.jar', nativesJar);
  route('/asset_indexes/tml.json', assetIndexJson);
  route('/logging/client-1.99.xml', loggingXml);
  route(`/objects/${assetAHash.slice(0, 2)}/${assetAHash}`, assetA);
  route(`/objects/${assetBHash.slice(0, 2)}/${assetBHash}`, assetB);
  route('/slow/client.jar', clientBytes, { delayMs: 900 });

  server = http.createServer((req, res) => {
    res.on('error', () => {});
    const pathname = new URL(req.url, 'http://localhost').pathname;
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
    const entry = routes.get(pathname);
    const send = () => {
      if (!entry) {
        res.writeHead(404, { 'content-length': '0' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': String(entry.body.length) });
      res.end(entry.body);
    };
    if (entry?.delayMs) setTimeout(send, entry.delayMs);
    else send();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-install-'));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeInstaller(overrides = {}) {
  const cacheDir = fs.mkdtempSync(path.join(tmpRoot, 'case-'));
  const installer = createInstaller({
    cacheDir,
    validator: localOnly,
    retries: 0,
    concurrency: 2,
    assetHost: `${baseUrl}/objects`,
    ...overrides,
  });
  return { installer, cacheDir, layout: installer.layout };
}

test('detectPlatform is Linux-only', () => {
  assert.deepEqual(detectPlatform('x64'), {
    name: 'linux',
    arch: 'x86_64',
    bits: 64,
    rawPlatform: 'linux',
    rawArch: 'x64',
  });
  assert.equal(detectPlatform('ia32').name, 'linux');
  assert.equal(detectPlatform('ia32').arch, 'x86');
  assert.equal(detectPlatform('ia32').bits, 32);
  assert.equal(detectPlatform('arm64').bits, 64);
  assert.equal(detectPlatform().name, 'linux');
  assert.equal(detectPlatform().rawPlatform, 'linux');

  for (const platform of ['win32', 'darwin', 'freebsd']) {
    assert.throws(
      () => detectPlatform('x64', platform),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.code, 'UNSUPPORTED_PLATFORM');
        assert.deepEqual(err.details, { platform, supported: 'linux' });
        return true;
      },
    );
  }
});

test('evaluateRules implements launcher allow/disallow semantics', () => {
  const os = detectPlatform('x64');
  const ctx = { os, features: {} };

  assert.equal(evaluateRules(undefined, ctx), true);
  assert.equal(evaluateRules([], ctx), true);
  assert.equal(evaluateRules([{ action: 'allow' }], ctx), true);
  assert.equal(evaluateRules([{ action: 'disallow' }], ctx), false);
  assert.equal(evaluateRules([{ action: 'disallow' }, { action: 'allow', os: { name: 'windows' } }], ctx), false);
  assert.equal(evaluateRules([{ action: 'allow', os: { name: 'linux' } }], ctx), true);
  assert.equal(evaluateRules([{ action: 'allow', os: { name: 'linux', arch: 'x86_64' } }], ctx), true);
  assert.equal(evaluateRules([{ action: 'allow', os: { name: 'linux', arch: 'x86' } }], ctx), false);
  assert.equal(evaluateRules([{ action: 'allow', features: { is_demo_user: true } }], ctx), false);
  assert.equal(
    evaluateRules([{ action: 'allow', features: { is_demo_user: true } }], { os, features: { is_demo_user: true } }),
    true,
  );
});

test('mavenPath builds standard repository paths', () => {
  assert.equal(mavenPath('com.mojang:patchy:2.2'), 'com/mojang/patchy/2.2/patchy-2.2.jar');
  assert.equal(
    mavenPath('org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209:natives-linux'),
    'org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-linux.jar',
  );
  assert.equal(
    mavenPath('io.netty:netty-all:4.1.25.Final@zip'),
    'io/netty/netty-all/4.1.25.Final/netty-all-4.1.25.Final.zip',
  );
  assert.throws(() => mavenPath('not-a-coordinate'), (err) => err instanceof ValidationError && err.code === 'INVALID_MAVEN_COORDINATE');
  assert.throws(() => mavenPath('a:b:c:d:e'), (err) => err instanceof ValidationError);
});

test('normalizeInclude validates and defaults install sections', () => {
  const all = normalizeInclude();
  assert.equal(INSTALL_SECTIONS.every((section) => all[section]), true);
  assert.deepEqual(normalizeInclude(['client', 'assets']), {
    client: true,
    libraries: false,
    logging: false,
    assets: true,
    natives: false,
  });
  assert.throws(() => normalizeInclude(['client', 'nope']), (err) => err instanceof ValidationError && err.code === 'INVALID_INCLUDE');
  assert.throws(() => normalizeInclude('client'), (err) => err instanceof ValidationError && err.code === 'INVALID_INCLUDE');
});

test('buildAssetTasks deduplicates objects by hash and builds official urls', () => {
  const layout = createLayout('/tmp/tml-layout-test');
  const index = {
    objects: {
      'a.txt': { hash: assetAHash, size: assetA.length },
      'copy.txt': { hash: assetAHash, size: assetA.length },
      'b.txt': { hash: assetBHash, size: assetB.length },
    },
  };

  const tasks = buildAssetTasks(index, layout);
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map((task) => task.url).sort(),
    [
      `${ASSET_HOST}/${assetAHash.slice(0, 2)}/${assetAHash}`,
      `${ASSET_HOST}/${assetBHash.slice(0, 2)}/${assetBHash}`,
    ].sort(),
  );
  assert.equal(tasks.every((task) => task.sha1 === task.hash), true);

  const custom = buildAssetTasks(index, layout, { host: 'http://127.0.0.1:9999/objects' });
  assert.ok(custom.every((task) => task.url.startsWith('http://127.0.0.1:9999/objects/')));

  assert.throws(() => buildAssetTasks({}, layout), CorruptDataError);
  assert.throws(() => buildAssetTasks({ objects: { 'x.txt': { hash: 'nope', size: 1 } } }, layout), CorruptDataError);
  assert.throws(
    () => buildAssetTasks({ objects: { 'x.txt': { size: 1 } } }, layout),
    CorruptDataError,
  );
});

test('createLayout resolves every install path inside the cache directory', () => {
  const layout = createLayout('/tmp/tml-layout-paths');
  assert.equal(layout.clientJar('1.20.1'), path.join('/tmp/tml-layout-paths/minecraft/client/1.20.1/client.jar'));
  assert.equal(layout.nativesDir('1.20.1'), path.join('/tmp/tml-layout-paths/minecraft/natives/1.20.1'));
  assert.equal(layout.library('com/example/x/1.0/x-1.0.jar'), path.join('/tmp/tml-layout-paths/libraries/com/example/x/1.0/x-1.0.jar'));
  assert.equal(layout.assetObjectFile(assetAHash), path.join('/tmp/tml-layout-paths/assets/objects', assetAHash.slice(0, 2), assetAHash));
  assert.throws(() => layout.library('../../escape.jar'), (err) => err instanceof ValidationError && err.code === 'PATH_ESCAPE');
  assert.throws(() => layout.assetObjectFile('bad-hash'), (err) => err instanceof ValidationError && err.code === 'INVALID_HASH');
  assert.throws(() => layout.versionFile('../evil'), (err) => err instanceof ValidationError);
});

test('planVersion filters libraries by Linux rules', () => {
  const linux = planVersion(legacyVersion());
  const names = linux.libraries.map((library) => library.name);
  assert.equal(linux.os.name, 'linux');
  assert.ok(names.includes('org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209'));
  assert.ok(names.includes('com.example:legacy:1.0'));
  assert.ok(!names.some((name) => name.includes('windows-only')));
  assert.ok(!names.some((name) => name.includes('osx-only')));

  assert.throws(
    () => planVersion(legacyVersion(), { os: { name: 'windows', arch: 'x86_64', bits: 64 } }),
    (err) => err instanceof ValidationError && err.code === 'UNSUPPORTED_PLATFORM',
  );
  assert.throws(
    () => planVersion(legacyVersion(), { os: { name: 'osx', arch: 'x86_64', bits: 64 } }),
    (err) => err instanceof ValidationError && err.code === 'UNSUPPORTED_PLATFORM',
  );
});

test('planVersion falls back to maven paths for libraries without downloads', () => {
  const plan = planVersion(legacyVersion());
  const legacy = plan.libraries.find((library) => library.name === 'com.example:legacy:1.0');
  assert.equal(legacy.path, 'com/example/legacy/1.0/legacy-1.0.jar');
  assert.equal(legacy.url, `${LIBRARY_HOST}/com/example/legacy/1.0/legacy-1.0.jar`);
  assert.equal(legacy.sha1, null);
  assert.equal(legacy.size, null);
});

test('planVersion resolves native classifiers for linux only', () => {
  const linux = planVersion(legacyVersion());
  assert.equal(linux.natives.length, 2);
  assert.ok(linux.natives.every((native) => native.key.startsWith('natives-linux')));

  const lwjgl = linux.natives.find((native) => native.name === 'org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209');
  assert.equal(lwjgl.key, 'natives-linux');
  assert.equal(
    lwjgl.path,
    'org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209-natives-linux.jar',
  );
  assert.equal(lwjgl.sha1, 'd'.repeat(40));
  assert.deepEqual(lwjgl.exclude, ['META-INF/']);

  const archLib = linux.natives.find((native) => native.name === 'com.example:arch-lib:1.0');
  assert.equal(archLib.key, 'natives-linux-64');

  assert.throws(
    () => planVersion(legacyVersion(), { arch: 'ia32' }),
    (err) => err instanceof CorruptDataError && /natives-linux-32/.test(err.message),
  );
});

test('planVersion rejects corrupt native metadata', () => {
  const broken = legacyVersion();
  delete broken.libraries[0].downloads.classifiers['natives-linux'];
  assert.throws(
    () => planVersion(broken),
    (err) => err instanceof CorruptDataError && /native classifier/.test(err.message),
  );

  const noClient = legacyVersion();
  delete noClient.downloads;
  assert.throws(() => planVersion(noClient), CorruptDataError);

  assert.throws(() => planVersion({ id: '1.0' }, {}), CorruptDataError);
  assert.throws(() => planVersion(null, {}), ValidationError);
});

test('planVersion honors feature rules', () => {
  const version = {
    id: '1.0-feature',
    downloads: { client: { url: 'https://piston-data.mojang.com/v1/objects/x/client.jar', sha1: 'a'.repeat(40), size: 1 } },
    libraries: [
      {
        name: 'com.example:premium:1.0',
        rules: [{ action: 'allow', features: { is_demo_user: true } }],
        downloads: {
          artifact: {
            path: 'com/example/premium/1.0/premium-1.0.jar',
            size: 1,
            url: 'https://libraries.minecraft.net/com/example/premium/1.0/premium-1.0.jar',
          },
        },
      },
    ],
  };
  const os = detectPlatform('x64');
  assert.equal(planVersion(version, { os, features: {} }).libraries.length, 0);
  assert.equal(planVersion(version, { os, features: { is_demo_user: true } }).libraries.length, 1);
});

test('computeExpectedBytes sums every selected section', () => {
  const plan = planVersion(makeVersion());

  const all = computeExpectedBytes(plan, normalizeInclude());
  const classpathBytes = plan.libraries.reduce((sum, library) => sum + library.size, 0);
  const nativeBytes = plan.natives.reduce((sum, native) => sum + native.size, 0);
  const expected =
    plan.client.size + classpathBytes + nativeBytes + plan.logging.size + plan.assetIndex.size + plan.assetIndex.totalSize;
  assert.equal(all, expected);

  assert.equal(computeExpectedBytes(plan, normalizeInclude(['client'])), plan.client.size);
  assert.equal(computeExpectedBytes(plan, normalizeInclude(['libraries'])), classpathBytes);
  assert.equal(computeExpectedBytes(plan, normalizeInclude(['natives'])), nativeBytes);
  assert.equal(
    computeExpectedBytes(plan, normalizeInclude(['logging', 'assets'])),
    plan.logging.size + plan.assetIndex.size + plan.assetIndex.totalSize,
  );
});

test('createInstaller requires a cache directory', () => {
  assert.throws(() => createInstaller({}), (err) => err instanceof ValidationError && err.code === 'INVALID_CACHE_DIR');
  assert.throws(() => createInstaller({ config: {} }), (err) => err instanceof ValidationError && err.code === 'INVALID_CACHE_DIR');
});

test('install downloads every section and extracts natives', async () => {
  const { installer, layout } = makeInstaller();
  const events = [];

  const result = await installer.install(makeVersion(), {
    onProgress: (event) => events.push(event),
  });

  assert.equal(result.id, '1.99.9-tml');
  assert.equal(result.type, 'release');
  assert.deepEqual(result.javaVersion, { component: 'java-runtime-gamma', majorVersion: 17 });
  assert.equal(result.files.total, 8);
  assert.equal(result.files.downloaded, 8);
  assert.equal(result.files.cached, 0);
  assert.equal(result.files.failed, 0);
  assert.equal(result.bytes.network, result.bytes.present);
  assert.equal(result.durationMs >= 0, true);

  assert.equal(fs.readFileSync(result.path.client).length, clientBytes.length);
  assert.equal(fs.existsSync(path.join(layout.libraries, 'com/example/core/1.0.0/core-1.0.0.jar')), true);
  assert.equal(fs.existsSync(path.join(layout.libraries, 'org/lwjgl/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4.jar')), true);
  assert.equal(fs.existsSync(path.join(layout.libraries, 'org/lwjgl/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4-natives-linux.jar')), true);
  assert.equal(fs.existsSync(path.join(layout.libraries, 'com/example/win-only/1.0.0/win-only-1.0.0.jar')), false);
  assert.equal(fs.existsSync(result.path.logging), true);
  assert.equal(fs.existsSync(result.path.assetIndex), true);
  assert.equal(fs.existsSync(path.join(layout.objects, assetAHash.slice(0, 2), assetAHash)), true);
  assert.equal(fs.existsSync(path.join(layout.objects, assetBHash.slice(0, 2), assetBHash)), true);
  assert.equal(fs.existsSync(path.join(layout.objects, assetAHash.slice(0, 2), `${assetAHash}-copy`)), false);

  const nativesDir = layout.nativesDir(result.id);
  assert.equal(fs.readFileSync(path.join(nativesDir, 'license.txt'), 'utf8'), 'LWJGL license');
  assert.equal(fs.readFileSync(path.join(nativesDir, 'linux/x64/org/lwjgl/liblwjgl.so')).length, 7);
  assert.equal(fs.existsSync(path.join(nativesDir, 'META-INF')), false);
  assert.equal(result.natives.skipped, false);
  assert.equal(result.natives.files, 2);

  const manifest = JSON.parse(fs.readFileSync(path.join(nativesDir, '.tml-natives.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.versionId, '1.99.9-tml');
  assert.equal(manifest.sources.length, 1);

  const versionFile = fs.readFileSync(result.path.version, 'utf8');
  assert.equal(JSON.parse(versionFile).id, '1.99.9-tml');

  assert.ok(events.length > 1);
  assert.ok(events.every((event) => INSTALL_STAGES.includes(event.stage)));
  assert.ok(events.every((event) => event.percent === null || (event.percent >= 0 && event.percent <= 100)));
  assert.equal(events.at(-1).stage, 'done');
  assert.equal(events.at(-1).percent, 100);
  const percents = events.map((event) => event.percent).filter((value) => value !== null);
  for (let index = 1; index < percents.length; index += 1) {
    assert.ok(percents[index] >= percents[index - 1], `percent dropped from ${percents[index - 1]} to ${percents[index]}`);
  }
  assert.ok(new Set(events.map((event) => event.stage)).size >= 4);
});

test('a second install is served from cache and skips natives extraction', async () => {
  const { installer, layout } = makeInstaller();
  const version = makeVersion();

  const first = await installer.install(version);
  assert.equal(first.natives.skipped, false);
  const hitsAfterFirst = hitCount('/client.jar');

  const second = await installer.install(version);
  assert.equal(second.files.total, 8);
  assert.equal(second.files.downloaded, 0);
  assert.equal(second.files.cached, 8);
  assert.equal(second.natives.skipped, true);
  assert.equal(hitCount('/client.jar'), hitsAfterFirst);
  assert.equal(fs.existsSync(layout.nativesDir(version.id)), true);
});

test('force re-downloads files and re-extracts natives', async () => {
  const { installer } = makeInstaller();
  const version = makeVersion();
  await installer.install(version);

  const forced = await installer.install(version, { force: true });
  assert.equal(forced.files.downloaded, 8);
  assert.equal(forced.files.cached, 0);
  assert.equal(forced.natives.skipped, false);
});

test('status reports missing files before install and readiness after', async () => {
  const { installer } = makeInstaller();
  const version = makeVersion();

  const before = await installer.status(version);
  assert.equal(before.ready, false);
  assert.equal(before.sections.client.ready, false);
  assert.equal(before.sections.client.reason, 'missing');
  assert.equal(before.sections.libraries.planned, 2);
  assert.equal(before.sections.assets.ready, false);
  assert.equal(before.sections.natives.ready, false);

  await installer.install(version);

  const after = await installer.status(version, { deep: true });
  assert.equal(after.ready, true);
  assert.equal(after.sections.client.ready, true);
  assert.equal(after.sections.libraries.missingCount, 0);
  assert.equal(after.sections.logging.ready, true);
  assert.equal(after.sections.assets.index.installed, true);
  assert.equal(after.sections.assets.objects.planned, 2);
  assert.equal(after.sections.assets.objects.installed, 2);
  assert.equal(after.sections.natives.ready, true);
  assert.equal(after.javaVersion.majorVersion, 17);

  const scoped = await installer.status(version, { include: ['client'] });
  assert.equal(scoped.ready, true);
  assert.equal(scoped.sections.libraries.included, false);
  assert.equal(scoped.sections.libraries.ready, null);
});

test('status detects a corrupted client jar', async () => {
  const { installer, layout } = makeInstaller();
  const version = makeVersion();
  await installer.install(version);

  fs.writeFileSync(layout.clientJar(version.id), 'tampered');
  const status = await installer.status(version, { deep: true });
  assert.equal(status.ready, false);
  assert.equal(status.sections.client.ready, false);
  assert.ok(['size-mismatch', 'checksum-mismatch'].includes(status.sections.client.reason));

  const shallow = await installer.status(version);
  assert.equal(shallow.sections.client.ready, false);
});

test('install honors the include option', async () => {
  const { installer, layout } = makeInstaller();
  const version = makeVersion();

  const result = await installer.install(version, { include: ['client'] });
  assert.equal(result.files.total, 1);
  assert.equal(fs.existsSync(result.path.client), true);
  assert.equal(fs.existsSync(path.join(layout.libraries, 'com/example/core/1.0.0/core-1.0.0.jar')), false);
  assert.equal(fs.existsSync(result.path.assetIndex), false);
  assert.equal(fs.existsSync(layout.nativesDir(version.id)), false);

  const status = await installer.status(version, { include: ['client'] });
  assert.equal(status.ready, true);

  assert.throws(
    () => normalizeInclude(['bogus']),
    (err) => err instanceof ValidationError && err.code === 'INVALID_INCLUDE',
  );
});

test('natives extraction can be requested without the rest of the install', async () => {
  const { installer, layout } = makeInstaller();
  const version = makeVersion();

  const result = await installer.install(version, { include: ['natives'] });
  assert.equal(result.files.total, 1);
  assert.equal(result.natives.skipped, false);
  assert.equal(fs.existsSync(path.join(layout.nativesDir(version.id), 'license.txt')), true);
  assert.equal(fs.existsSync(result.path.client), false);
});

test('install fails with InstallError when a download fails', async () => {
  const { installer } = makeInstaller();
  const version = makeVersion({
    downloads: { client: { sha1: sha1(clientBytes), size: clientBytes.length, url: `${baseUrl}/missing/client.jar` } },
  });

  await assert.rejects(
    () => installer.install(version, { include: ['client'] }),
    (err) => {
      assert.ok(err instanceof InstallError);
      assert.equal(err.code, 'INSTALL_FAILED');
      assert.equal(err.status, 500);
      assert.equal(err.details.stage, 'client');
      assert.equal(err.failures.length, 1);
      assert.equal(err.failures[0].id.startsWith('client:'), true);
      assert.equal(err.failures[0].code, 'UPSTREAM_ERROR');
      return true;
    },
  );
});

test('install can be cancelled with an AbortSignal', async () => {
  const { installer, layout } = makeInstaller();
  const version = makeVersion({
    downloads: { client: { sha1: sha1(clientBytes), size: clientBytes.length, url: `${baseUrl}/slow/client.jar` } },
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);

  await assert.rejects(
    () => installer.install(version, { include: ['client'], signal: controller.signal }),
    (err) => err instanceof CancelledError && err.code === 'CANCELLED',
  );
  assert.equal(fs.existsSync(layout.clientJar(version.id)), false);
});

test('install by version id uses the Minecraft api and persists metadata', async () => {
  const version = makeVersion();
  const { installer, layout } = makeInstaller({
    minecraft: {
      getVersion: async (id) => {
        assert.equal(id, version.id);
        return { version, source: 'cache' };
      },
    },
  });

  const result = await installer.install(version.id);
  assert.equal(result.id, version.id);
  assert.equal(JSON.parse(fs.readFileSync(layout.versionFile(version.id), 'utf8')).id, version.id);
});

test('install by version id without an api client is rejected', async () => {
  const { installer } = makeInstaller();
  await assert.rejects(
    () => installer.install('1.20.1'),
    (err) => err instanceof ValidationError && err.code === 'NO_MINECRAFT_API',
  );
});

test('install rewrites a corrupt version metadata file', async () => {
  const { installer, layout } = makeInstaller();
  const version = makeVersion();
  fs.mkdirSync(path.dirname(layout.versionFile(version.id)), { recursive: true });
  fs.writeFileSync(layout.versionFile(version.id), '{ not json');

  const result = await installer.install(version, { include: ['client'] });
  assert.equal(JSON.parse(fs.readFileSync(result.path.version, 'utf8')).id, version.id);
});

test('install works without a logging block or asset index', async () => {
  const { installer } = makeInstaller({
    minecraft: { getVersion: async () => ({ version: makeVersion({ logging: undefined, assetIndex: undefined }) }) },
  });

  const result = await installer.install('1.99.9-tml');
  assert.equal(result.files.total, 4);
  assert.equal(result.path.logging, null);
  assert.equal(result.path.assetIndex, null);

  const status = await installer.status('1.99.9-tml');
  assert.equal(status.sections.logging.planned, 0);
  assert.equal(status.sections.logging.ready, true);
  assert.equal(status.sections.assets.included, false);
});

test('plan() returns the resolved install plan', async () => {
  const { installer, cacheDir } = makeInstaller();
  const plan = await installer.plan(makeVersion());
  assert.equal(plan.id, '1.99.9-tml');
  assert.equal(plan.client.dest, path.join(cacheDir, 'minecraft/client/1.99.9-tml/client.jar'));
  assert.equal(plan.libraries.length, 2);
  assert.equal(plan.natives.length, 1);
  assert.equal(plan.javaVersion.majorVersion, 17);
  assert.equal(plan.os.name, 'linux');
});

test('library download tasks inherit the source of their host', async () => {
  const downloads = [];
  const recordingDownloader = {
    progress: {
      remove() {},
      register() {},
      subscribe() {
        return () => {};
      },
      snapshot() {
        return { bytes: { total: 0, loaded: 0 }, tasks: [] };
      },
    },
    async run(list) {
      downloads.push(...list);
      return list.map((task) => ({ status: 'ok', id: task.id, result: { bytes: task.size ?? 0, from: 'cache' } }));
    },
    cancelAll() {},
  };

  const { installer } = makeInstaller({ downloader: recordingDownloader });
  const version = makeVersion({
    libraries: makeLibraries().concat([
      {
        name: 'net.fabricmc:fabric-loader:0.15.7',
        downloads: {
          artifact: {
            path: 'net/fabricmc/fabric-loader/0.15.7/fabric-loader-0.15.7.jar',
            sha1: 'a'.repeat(40),
            size: 12,
            url: 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.15.7/fabric-loader-0.15.7.jar',
          },
        },
      },
      {
        name: 'org.ow2.asm:asm:9.6',
        downloads: {
          artifact: {
            path: 'org/ow2/asm/asm/9.6/asm-9.6.jar',
            sha1: 'b'.repeat(40),
            size: 12,
            url: 'https://libraries.minecraft.net/org/ow2/asm/asm/9.6/asm-9.6.jar',
          },
        },
      },
      {
        name: 'com.example:mirror:1.0.0',
        downloads: {
          artifact: {
            path: 'com/example/mirror/1.0.0/mirror-1.0.0.jar',
            sha1: 'c'.repeat(40),
            size: 12,
            url: 'https://mirror.example.com/com/example/mirror/1.0.0/mirror-1.0.0.jar',
          },
        },
      },
    ]),
  });

  const result = await installer.install(version, { include: ['libraries'] });
  assert.ok(result.files.total >= 4);

  const byUrl = new Map(downloads.map((task) => [task.url, task]));
  assert.equal(
    byUrl.get('https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.15.7/fabric-loader-0.15.7.jar').source,
    'fabric',
    'fabric maven libraries must download with the fabric source',
  );
  assert.equal(
    byUrl.get('https://libraries.minecraft.net/org/ow2/asm/asm/9.6/asm-9.6.jar').source,
    'minecraft',
  );
  assert.equal(
    byUrl.get('https://mirror.example.com/com/example/mirror/1.0.0/mirror-1.0.0.jar').source,
    'minecraft',
    'unknown hosts keep the minecraft source so the allowlist rejects them',
  );
  const localTask = downloads.find((task) => task.url.startsWith(`${baseUrl}/libs/`));
  assert.ok(localTask);
  assert.equal(localTask.source, 'minecraft');
});
