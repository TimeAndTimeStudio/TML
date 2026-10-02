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

import { loadConfig } from '../../src/core/config.js';
import { SourceNotAllowedError, ValidationError } from '../../src/core/errors.js';
import { hashBuffer } from '../../src/download/hash.js';
import {
  createJavaRuntimes,
  majorFromJavaVersion,
  parseJavaRuntimeList,
  parseRuntimeManifest,
  validateRuntimeName,
} from '../../src/java/runtimes.js';

const localOnly = (input) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new SourceNotAllowedError(`Host not allowed: ${url.hostname}`, {
      details: { host: url.hostname },
    });
  }
  return url;
};

const BIN_JAVA = Buffer.from('#!/bin/sh\necho "java 17"\n');
const APP_JAR = Buffer.from('jar-bytes-not-really-a-jar');
const NOTICE = Buffer.from('legal notice text\n');
const BIN_HASHES = hashBuffer(BIN_JAVA, ['sha1']);
const JAR_HASHES = hashBuffer(APP_JAR, ['sha1']);
const NOTICE_HASHES = hashBuffer(NOTICE, ['sha1']);

let upstream;
let base;
let manifest;
let manifestSha1;
let allJson;
let dataDir;
let config;
let logger;
let javaDir;
const upstreamHits = new Map();

function buildAllJson() {
  const entry = (name, released, { progress = 100, url = `${base}/manifest.json`, sha1 = manifestSha1 } = {}) => ({
    availability: { group: 'minecraft-java', progress },
    manifest: { sha1, size: manifest.length, url },
    version: { name, released },
  });
  return {
    gamecore: [],
    linux: {
      'java-runtime-delta': [entry('21.0.7', '2025-05-19')],
      'java-runtime-gamma': [entry('17.0.15', '2025-05-19')],
      'jre-legacy': [entry('8u202', '2020-11-17')],
      'java-runtime-nope': [entry('4.0.0', '2020-01-01', { progress: 0 })],
      'minecraft-java-exe': [entry('1.0.0', '2020-01-01')],
      'broken-entry': [{ availability: { group: 'x', progress: 100 } }],
    },
    'mac-os': {},
  };
}

function buildManifest() {
  const files = {
    bin: { type: 'directory' },
    'bin/java': {
      type: 'file',
      executable: true,
      downloads: { raw: { sha1: BIN_HASHES.sha1, size: BIN_JAVA.length, url: `${base}/files/bin-java` } },
    },
    lib: { type: 'directory' },
    'lib/app.jar': {
      type: 'file',
      downloads: { raw: { sha1: JAR_HASHES.sha1, size: APP_JAR.length, url: `${base}/files/app-jar` } },
    },
    legal: { type: 'directory' },
    'legal/notice.txt': {
      type: 'file',
      downloads: { raw: { sha1: NOTICE_HASHES.sha1, size: NOTICE.length, url: `${base}/files/notice` } },
    },
    'legal/notice-copy.txt': { type: 'link', target: 'notice.txt' },
    'escape.txt': { type: 'link', target: '../escape.txt' },
    'absolute.txt': { type: 'link', target: '/etc/passwd' },
    'bare.txt': { type: 'link' },
    'no-raw.jar': { type: 'file', downloads: {} },
    'unknown.kind': { type: 'wat', downloads: {} },
  };
  return Buffer.from(JSON.stringify({ files }, null, 2));
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-java-'));
  config = loadConfig({ env: { TML_DATA_DIR: dataDir, TML_LOG_LEVEL: 'silent' } });
  logger = { info() {}, warn() {}, error() {}, debug() {} };
  javaDir = config.paths.javaDir;

  upstream = http.createServer();
  upstream.on('request', (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const hit = (key) => upstreamHits.set(key, (upstreamHits.get(key) ?? 0) + 1);
    if (url.pathname === '/manifest.json') {
      hit('manifest');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifest);
      return;
    }
    if (url.pathname === '/files/bin-java') {
      hit('bin-java');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(BIN_JAVA);
      return;
    }
    if (url.pathname === '/files/app-jar') {
      hit('app-jar');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(APP_JAR);
      return;
    }
    if (url.pathname === '/files/notice') {
      hit('notice');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(NOTICE);
      return;
    }
    res.writeHead(404).end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  base = `http://127.0.0.1:${upstream.address().port}`;
  manifest = buildManifest();
  manifestSha1 = hashBuffer(manifest, ['sha1']).sha1;
  allJson = buildAllJson();
});

after(async () => {
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function createClient() {
  const calls = [];
  return {
    calls,
    async getJson(url) {
      calls.push(String(url));
      if (String(url).endsWith('all.json')) return { data: allJson };
      throw new Error(`unexpected getJson: ${url}`);
    },
  };
}

function makeJava(overrides = {}) {
  return createJavaRuntimes({ config, logger, client: createClient(), validator: localOnly, ...overrides });
}

test('parseJavaRuntimeList keeps available linux runtimes and sorts newest major first', () => {
  const runtimes = parseJavaRuntimeList(allJson);
  assert.deepEqual(
    runtimes.map((runtime) => runtime.name),
    ['java-runtime-delta', 'java-runtime-gamma', 'jre-legacy'],
  );
  assert.equal(runtimes[0].javaVersion, '21.0.7');
  assert.equal(runtimes[0].major, 21);
  assert.equal(runtimes[1].javaVersion, '17.0.15');
  assert.equal(runtimes[1].released, '2025-05-19');
  assert.equal(runtimes[2].major, 8);
  assert.ok(runtimes.every((runtime) => typeof runtime.manifestUrl === 'string' && runtime.manifestSha1.length === 40));
});

test('parseJavaRuntimeList rejects unusable payloads', () => {
  assert.throws(() => parseJavaRuntimeList(null), { code: 'JAVA_RUNTIME_LIST_INVALID' });
  assert.throws(() => parseJavaRuntimeList([]), { code: 'JAVA_RUNTIME_LIST_INVALID' });
  assert.throws(() => parseJavaRuntimeList({ linux: {} }), { code: 'JAVA_RUNTIME_LIST_INVALID' });
  assert.throws(() => parseJavaRuntimeList({ 'win-64': { 'java-runtime-gamma': [] } }), {
    code: 'JAVA_RUNTIME_LIST_INVALID',
  });
});

test('majorFromJavaVersion parses launcher-style version names', () => {
  assert.equal(majorFromJavaVersion('17.0.15'), 17);
  assert.equal(majorFromJavaVersion('8u202'), 8);
  assert.equal(majorFromJavaVersion('16.0.1.9.1'), 16);
  assert.equal(majorFromJavaVersion('21.0.7'), 21);
  assert.equal(majorFromJavaVersion('junk'), null);
  assert.equal(majorFromJavaVersion(''), null);
});

test('validateRuntimeName accepts runtime ids and rejects anything else', () => {
  assert.equal(validateRuntimeName('java-runtime-gamma'), 'java-runtime-gamma');
  assert.equal(validateRuntimeName('jre-legacy'), 'jre-legacy');
  for (const bad of ['', '  ', '../evil', 'Gamma', 'has space', 'a'.repeat(65), 42, null, undefined]) {
    assert.throws(
      () => validateRuntimeName(bad),
      (err) => err instanceof ValidationError && err.code === 'INVALID_JAVA_RUNTIME' && err.status === 400,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test('parseRuntimeManifest separates directories, downloadable files and links', () => {
  const { directories, downloads, links } = parseRuntimeManifest(JSON.parse(manifest.toString('utf8')));
  assert.deepEqual(directories, ['bin', 'legal', 'lib']);
  assert.deepEqual(
    downloads.map((file) => file.rel),
    ['bin/java', 'legal/notice.txt', 'lib/app.jar'],
  );
  assert.equal(downloads[0].executable, true);
  assert.equal(downloads[1].executable, false);
  assert.equal(downloads[0].sha1, BIN_HASHES.sha1);
  assert.deepEqual(
    links.map((link) => link.rel),
    ['absolute.txt', 'bare.txt', 'escape.txt', 'legal/notice-copy.txt'],
  );
  assert.equal(links.at(-1).target, 'notice.txt');
  assert.throws(() => parseRuntimeManifest({}), { code: 'JAVA_RUNTIME_MANIFEST_INVALID' });
  assert.throws(() => parseRuntimeManifest({ files: [] }), { code: 'JAVA_RUNTIME_MANIFEST_INVALID' });
});

test('list() fetches the runtime list once and reports downloaded state', async () => {
  const client = createClient();
  const java = makeJava({ client });

  const first = await java.list();
  assert.equal(first.length, 3);
  assert.equal(first[0].name, 'java-runtime-delta');
  assert.equal(first[0].downloaded, false);
  assert.equal(first[1].downloaded, false);
  assert.equal(client.calls.length, 1);

  const second = await java.list();
  assert.equal(second.length, 3);
  assert.equal(client.calls.length, 1, 'the in-memory list is cached within its TTL');

  await java.list({ refresh: true });
  assert.equal(client.calls.length, 2, 'refresh bypasses the cache');
});

test('download() installs every file, chmods executables and materialises legal links', async () => {
  const java = makeJava();
  const progress = [];

  const result = await java.download('java-runtime-gamma', { onProgress: (info) => progress.push(info) });

  assert.equal(result.cached, false);
  assert.equal(result.name, 'java-runtime-gamma');
  assert.equal(result.files, 3);
  assert.ok(result.bytes > 0);

  const root = path.join(javaDir, 'java-runtime-gamma');
  assert.equal(result.path, root);
  assert.equal(fs.readFileSync(path.join(root, 'bin', 'java'), 'utf8'), BIN_JAVA.toString());
  assert.ok(fs.statSync(path.join(root, 'bin', 'java')).mode & 0o111, 'bin/java must be executable');
  assert.equal(fs.readFileSync(path.join(root, 'lib', 'app.jar'), 'utf8'), APP_JAR.toString());
  assert.equal(fs.readFileSync(path.join(root, 'legal', 'notice.txt'), 'utf8'), NOTICE.toString());
  assert.equal(
    fs.readFileSync(path.join(root, 'legal', 'notice-copy.txt'), 'utf8'),
    NOTICE.toString(),
    'legal links are materialised as copies',
  );
  assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false, 'escaping links must be skipped');
  assert.equal(fs.existsSync(path.join(root, 'absolute.txt')), false, 'absolute links must be skipped');

  const marker = JSON.parse(fs.readFileSync(path.join(root, '.tml-runtime.json'), 'utf8'));
  assert.equal(marker.name, 'java-runtime-gamma');
  assert.equal(marker.javaVersion, '17.0.15');
  assert.equal(marker.files, 3);

  assert.ok(progress.length >= 3, 'progress fires per downloaded file');
  assert.ok(progress.every((info) => info.stage === 'java'));
  const last = progress.at(-1);
  assert.equal(last.percent, 100);
  assert.equal(last.loaded, last.total);
  assert.deepEqual(last.files, { done: 3, count: 3 });
  assert.equal(upstreamHits.get('manifest'), 1, 'the manifest is fetched once');
});

test('download() is idempotent, validates names and 404s unknown runtimes', async () => {
  const java = makeJava();
  const again = await java.download('java-runtime-gamma');
  assert.equal(again.cached, true);
  assert.equal(again.files, 0);

  await assert.rejects(java.download('java-runtime-nope'), { code: 'JAVA_RUNTIME_NOT_FOUND', status: 404 });
  await assert.rejects(java.download('../evil'), { code: 'INVALID_JAVA_RUNTIME', status: 400 });

  const forced = await java.download('java-runtime-gamma', { force: true });
  assert.equal(forced.cached, false, 'force re-downloads even when the marker exists');
  assert.equal(forced.files, 3);
});

test('ensure() picks a runtime by major or component and reports unavailable majors', async () => {
  const java = makeJava();

  const legacy = await java.ensure({ requiredMajor: 8 });
  assert.equal(legacy.name, 'jre-legacy');
  assert.equal(fs.existsSync(path.join(javaDir, 'jre-legacy', 'bin', 'java')), true);

  const mismatched = await java.ensure({ requiredMajor: 17, requiredComponent: 'jre-legacy' });
  assert.equal(mismatched.name, 'java-runtime-gamma', 'the major wins over a mismatched component name');

  const byName = await java.ensure({ requiredComponent: 'java-runtime-delta' });
  assert.equal(byName.name, 'java-runtime-delta');

  await assert.rejects(java.ensure({ requiredMajor: 99 }), { code: 'JAVA_RUNTIME_UNAVAILABLE', status: 409 });

  const chosen = java.getChosen();
  assert.equal(chosen, null, 'ensure() never changes the chosen runtime by itself');
  java.setChosen('java-runtime-delta');
  assert.equal(java.getChosen(), 'java-runtime-delta');
  assert.throws(() => java.setChosen('NOPE'), { code: 'INVALID_JAVA_RUNTIME' });
});

test('remove() deletes an installed runtime, clears the selection and rejects bad names', async () => {
  const java = makeJava();
  const installed = await java.download('java-runtime-gamma');
  assert.equal(installed.cached, true, 'gamma was installed by an earlier test');
  const root = path.join(javaDir, 'java-runtime-gamma');
  assert.equal(fs.existsSync(root), true);
  java.setChosen('java-runtime-gamma');

  const result = await java.remove('java-runtime-gamma');
  assert.equal(result.deleted, true);
  assert.equal(result.clearedChosen, true);
  assert.equal(fs.existsSync(root), false, 'the install directory is gone');
  assert.equal(java.getChosen(), null, 'deleting the chosen runtime clears the selection');

  await assert.rejects(java.remove('java-runtime-gamma'), { code: 'JAVA_RUNTIME_NOT_DOWNLOADED', status: 404 });
  await assert.rejects(java.remove('java-runtime-alpha'), { code: 'JAVA_RUNTIME_NOT_DOWNLOADED', status: 404 });
  await assert.rejects(java.remove('../evil'), { code: 'INVALID_JAVA_RUNTIME', status: 400 });
});
