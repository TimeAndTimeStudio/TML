// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { createMinecraftApi } from '../../src/minecraft/api.js';
import { createHttpClient } from '../../src/net/http.js';
import { parseManifest } from '../../src/minecraft/manifest.js';
import { parseVersionJson, safeVersionId, versionCacheFile } from '../../src/minecraft/versions.js';
import {
  CorruptDataError,
  NotFoundError,
  SourceNotAllowedError,
  ValidationError,
} from '../../src/core/errors.js';

let upstream;
let dataDir;
let config;
let base;
let manifest;
let versionFiles;
let hits;

const logger = createLogger({ level: 'silent' });

const localOnly = (input) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new SourceNotAllowedError(`Host not allowed: ${url.hostname}`, {
      details: { host: url.hostname },
    });
  }
  return url;
};

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function writeJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

function makeVersionJson(id, { type = 'release', legacy = false } = {}) {
  const payload = {
    id,
    type,
    mainClass: 'net.minecraft.client.main.Main',
    assets: legacy ? 'legacy' : '1.20',
    assetIndex: {
      id: legacy ? 'pre-1.6' : '5',
      sha1: sha1(`asset-index-${id}`),
      size: 1024,
      totalSize: 2048,
      url: `${base}/assetindex.json`,
    },
    downloads: {
      client: { sha1: sha1(`client-${id}`), size: 4096, url: `${base}/client.jar` },
    },
    libraries: [
      { name: 'com.mojang:brigadier:1.0.18' },
      { name: 'net.minecraft:client-loom-mapped' },
    ],
    javaVersion: { component: legacy ? 'jre-legacy' : 'java-runtime-gamma', majorVersion: legacy ? 8 : 17 },
    releaseTime: '2023-06-12T13:25:50+00:00',
    time: '2023-06-12T13:25:50+00:00',
    complianceLevel: 1,
    minimumLauncherVersion: 21,
  };

  if (legacy) {
    payload.minecraftArguments = '--username ${auth_player_name} --version ${version_name}';
  } else {
    payload.arguments = { game: ['--username', '${auth_player_name}'], jvm: ['-Xss1M'] };
  }

  return payload;
}

function buildFixtures() {
  const definitions = [
    { id: '23w13a', type: 'snapshot', legacy: false },
    { id: '1.20.1', type: 'release', legacy: false },
    { id: '1.14.2 Pre-Release 4', type: 'snapshot', legacy: false },
    { id: 'b1.7.3', type: 'old_beta', legacy: true },
    { id: 'c0.0.11a', type: 'old_alpha', legacy: true },
  ];

  versionFiles = new Map();
  const entries = definitions.map((definition) => {
    const text = JSON.stringify(makeVersionJson(definition.id, definition));
    versionFiles.set(definition.id, text);
    return {
      id: definition.id,
      type: definition.type,
      url: `${base}/v/${encodeURIComponent(definition.id)}.json`,
      time: '2023-06-12T13:25:50+00:00',
      releaseTime: '2023-06-12T13:25:50+00:00',
      sha1: sha1(text),
      complianceLevel: 1,
    };
  });

  const tamperedText = JSON.stringify(makeVersionJson('tampered'));
  versionFiles.set('tampered', tamperedText);

  entries.push({
    id: 'tampered',
    type: 'release',
    url: `${base}/v/tampered.json`,
    time: '2023-06-12T13:25:50+00:00',
    releaseTime: '2023-06-12T13:25:50+00:00',
    sha1: sha1('the bytes the manifest claims'),
    complianceLevel: 1,
  });

  entries.push({
    id: 'evil-version',
    type: 'release',
    url: 'http://evil.example.com/version.json',
    time: '2023-06-12T13:25:50+00:00',
    releaseTime: '2023-06-12T13:25:50+00:00',
    sha1: sha1('evil'),
    complianceLevel: 1,
  });

  manifest = {
    latest: { release: '1.20.1', snapshot: '23w13a' },
    versions: entries,
  };
}

function makeApi(cacheName, manifestPath = '/mc/game/version_manifest_v2.json') {
  return createMinecraftApi({
    config,
    logger,
    client: localClient,
    validator: localOnly,
    manifestUrl: `${base}${manifestPath}`,
    cacheDir: path.join(dataDir, cacheName, 'minecraft'),
  });
}

let localClient;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-minecraft-'));
  config = loadConfig({ env: { TML_DATA_DIR: dataDir, TML_LOG_LEVEL: 'silent' } });

  upstream = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);

    if (pathname === '/mc/game/version_manifest_v2.json') {
      hits.manifest += 1;
      writeJson(res, 200, manifest);
      return;
    }

    if (pathname === '/broken-manifest') {
      writeJson(res, 200, { latest: { release: '1.0', snapshot: '1.0' }, versions: [] });
      return;
    }

    if (pathname === '/down') {
      hits.down += 1;
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('upstream exploded');
      return;
    }

    const versionMatch = pathname.match(/^\/v\/(.+)\.json$/);
    if (versionMatch) {
      const id = versionMatch[1];
      hits.versions.set(id, (hits.versions.get(id) ?? 0) + 1);
      const text = versionFiles.get(id);
      if (!text) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('missing');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(text);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  base = `http://127.0.0.1:${port}`;

  hits = { manifest: 0, down: 0, versions: new Map() };
  buildFixtures();
  localClient = createHttpClient({ validator: localOnly });
});

after(async () => {
  if (typeof upstream.closeAllConnections === 'function') upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('listVersions reads the manifest instead of hard-coding versions', async () => {
  const api = makeApi('a');
  const versions = await api.listVersions();
  const ids = versions.map((entry) => entry.id);

  assert.ok(ids.includes('1.20.1'));
  assert.ok(ids.includes('23w13a'));
  assert.ok(ids.includes('1.14.2 Pre-Release 4'));
  assert.equal(versions.length, manifest.versions.length);
  assert.equal(versions[0].type, 'snapshot');
  assert.equal(hits.manifest, 1);
});

test('listVersions filters by type and limit', async () => {
  const api = makeApi('a');

  const releases = await api.listVersions({ type: 'release' });
  assert.deepEqual(releases.map((entry) => entry.id), ['1.20.1', 'tampered', 'evil-version']);

  const snapshots = await api.listVersions({ type: 'snapshot', limit: 1 });
  assert.deepEqual(snapshots.map((entry) => entry.id), ['23w13a']);

  await assert.rejects(
    () => api.listVersions({ type: 'mod' }),
    (err) => err instanceof ValidationError && err.code === 'UNKNOWN_VERSION_TYPE'
  );

  await assert.rejects(
    () => api.listVersions({ limit: -1 }),
    (err) => err instanceof ValidationError
  );
});

test('getLatest comes from the manifest', async () => {
  const api = makeApi('a');
  const { latest } = await api.getLatest();
  assert.deepEqual(latest, { release: '1.20.1', snapshot: '23w13a' });
});

test('getVersion returns normalized modern metadata', async () => {
  const api = makeApi('a');
  const { version, source } = await api.getVersion('1.20.1');

  assert.equal(source, 'network');
  assert.equal(version.id, '1.20.1');
  assert.equal(version.type, 'release');
  assert.equal(version.mainClass, 'net.minecraft.client.main.Main');
  assert.equal(version.javaVersion.majorVersion, 17);
  assert.equal(version.downloads.client.sha1, sha1('client-1.20.1'));
  assert.equal(version.assetIndex.id, '5');
  assert.equal(version.libraries.length, 2);
  assert.ok(version.arguments);
  assert.equal(version.minecraftArguments, null);
  assert.equal(version.raw.id, '1.20.1');
});

test('legacy versions keep minecraftArguments', async () => {
  const api = makeApi('a');
  const { version } = await api.getVersion('b1.7.3');

  assert.equal(version.type, 'old_beta');
  assert.equal(version.javaVersion.majorVersion, 8);
  assert.match(version.minecraftArguments, /^--username/);
  assert.equal(version.arguments, null);
  assert.equal(version.assetIndex.id, 'pre-1.6');
});

test('version ids containing spaces are supported', async () => {
  const api = makeApi('a');
  const { version } = await api.getVersion('1.14.2 Pre-Release 4');
  assert.equal(version.id, '1.14.2 Pre-Release 4');
});

test('version metadata is cached on disk and in memory', async () => {
  const api = makeApi('d');
  const before = hits.versions.get('1.20.1') ?? 0;

  await api.getVersion('1.20.1');
  const afterNetwork = hits.versions.get('1.20.1');
  assert.equal(afterNetwork, before + 1);

  const cached = await api.getVersion('1.20.1');
  assert.equal(cached.source, 'cache');
  assert.equal(hits.versions.get('1.20.1'), before + 1);

  const file = versionCacheFile(path.join(dataDir, 'd', 'minecraft'), '1.20.1');
  assert.equal(fs.existsSync(file), true);
});

test('manifest is fetched once and reused until refresh', async () => {
  const api = makeApi('e');
  const start = hits.manifest;

  await api.listVersions();
  await api.listVersions();
  assert.equal(hits.manifest, start + 1);

  await api.listVersions({ refresh: true });
  assert.equal(hits.manifest, start + 2);
});

test('unknown and unsafe version ids are rejected', async () => {
  const api = makeApi('a');

  await assert.rejects(
    () => api.getVersion('1.99.99'),
    (err) => err instanceof NotFoundError && err.code === 'VERSION_NOT_FOUND'
  );

  for (const badId of ['../../etc/passwd', '..\\secret', '', 'a/b', 'x'.repeat(200)]) {
    await assert.rejects(
      () => api.getVersion(badId),
      (err) => err.code === 'INVALID_VERSION_ID',
      `expected rejection for ${JSON.stringify(badId)}`
    );
  }

  assert.throws(() => safeVersionId('../oops'), (err) => err.code === 'INVALID_VERSION_ID');
  assert.equal(safeVersionId('1.20.1'), '1.20.1');
});

test('metadata URLs pointing outside the allowlist are never fetched', async () => {
  const api = makeApi('a');

  await assert.rejects(
    () => api.getVersion('evil-version'),
    (err) => err instanceof SourceNotAllowedError && err.details.host === 'evil.example.com'
  );
  assert.equal(hits.versions.has('evil-version'), false);
});

test('sha1 mismatch is detected before the metadata is trusted', async () => {
  const api = makeApi('f');

  await assert.rejects(
    () => api.getVersion('tampered'),
    (err) => err instanceof CorruptDataError && err.code === 'HASH_MISMATCH'
  );
  assert.equal(fs.existsSync(versionCacheFile(path.join(dataDir, 'f', 'minecraft'), 'tampered')), false);
});

test('a malformed manifest raises CorruptDataError', async () => {
  const api = makeApi('g', '/broken-manifest');
  await assert.rejects(() => api.listVersions(), CorruptDataError);
});

test('a failing upstream falls back to the cached manifest', async () => {
  const api = makeApi('h');
  const before = hits.manifest;
  await api.listVersions();
  assert.equal(hits.manifest, before + 1);

  const offline = makeApi('h', '/down');
  const { source, manifest: fallback } = await offline.getManifest({ refresh: true });

  assert.equal(hits.down, 1);
  assert.equal(source, 'stale-cache');
  assert.equal(fallback.versions.length, manifest.versions.length);
});

test('parse helpers validate their input', () => {
  assert.throws(() => parseManifest(null), CorruptDataError);
  assert.throws(() => parseManifest({ latest: {}, versions: [] }), CorruptDataError);
  assert.throws(() => parseVersionJson({ id: '1.0' }), CorruptDataError);
  assert.throws(
    () => parseVersionJson({ ...makeVersionJson('1.0'), downloads: {} }),
    CorruptDataError
  );

  const parsed = parseVersionJson(makeVersionJson('1.0'));
  assert.equal(parsed.id, '1.0');
  assert.equal(versionCacheFile(path.join(dataDir, 'x'), '1.0'), path.join(dataDir, 'x', 'versions', '1.0.json'));
});

test('live official manifest', { skip: !process.env.TML_LIVE }, async () => {
  const api = createMinecraftApi({ config, logger });
  const releases = await api.listVersions({ type: 'release', limit: 5 });

  assert.ok(releases.length > 0);
  const { version } = await api.getVersion(releases[0].id);
  assert.equal(version.id, releases[0].id);
  assert.ok(version.downloads.client.url.startsWith('https://'));
});
