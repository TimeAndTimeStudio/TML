// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createDownloader, downloadToFile, isRetryable } from '../../src/download/downloader.js';
import { hashBuffer } from '../../src/download/hash.js';
import {
  CancelledError,
  ChecksumMismatchError,
  DownloadError,
  SourceNotAllowedError,
  UpstreamError,
  ValidationError,
} from '../../src/core/errors.js';
import { validateUrl } from '../../src/security/urls.js';

const noopSleep = async () => {};

let upstream;
let baseUrl;
let tmpRoot;

const state = {
  hits: new Map(),
  files: new Map(),
  inFlight: 0,
  maxInFlight: 0,
  delayMs: 0,
};

const localOnly = (input) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new SourceNotAllowedError(`Host not allowed: ${url.hostname}`, {
      details: { host: url.hostname },
    });
  }
  return url;
};

function countHit(key) {
  state.hits.set(key, (state.hits.get(key) ?? 0) + 1);
}

function hits(key) {
  return state.hits.get(key) ?? 0;
}

function track(res, fn) {
  state.inFlight += 1;
  state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    state.inFlight -= 1;
    fn?.();
  };
  res.on('finish', done);
  res.on('close', done);
}

function serveFile(res, body, headers = {}) {
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(body.length),
    ...headers,
  });
  res.end(body);
}

before(async () => {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname.startsWith('/file/')) {
      countHit(pathname);
      track(res);
      const body = state.files.get(pathname.slice('/file/'.length));
      if (!body) {
        res.writeHead(404).end('missing');
        return;
      }
      setTimeout(() => serveFile(res, body), state.delayMs);
      return;
    }

    if (pathname.startsWith('/gzip/')) {
      countHit(pathname);
      track(res);
      const body = state.files.get(pathname.slice('/gzip/'.length));
      if (!body) {
        res.writeHead(404).end('missing');
        return;
      }
      const compressed = zlib.gzipSync(body);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-encoding': 'gzip',
        'content-length': String(compressed.length),
      });
      res.end(compressed);
      return;
    }

    if (pathname === '/flaky') {
      countHit('flaky');
      track(res);
      const failures = Number(url.searchParams.get('fail') ?? '0');
      const body = Buffer.from(url.searchParams.get('body') ?? 'flaky-ok');
      if (hits('flaky') <= failures) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('upstream exploded');
        return;
      }
      serveFile(res, body);
      return;
    }

    if (pathname.startsWith('/redirect-to/')) {
      countHit(pathname);
      track(res);
      res.writeHead(302, { location: `/file/${pathname.slice('/redirect-to/'.length)}` });
      res.end();
      return;
    }

    if (pathname === '/to-evil') {
      countHit('to-evil');
      track(res);
      res.writeHead(302, { location: 'http://evil.example.com/payload.jar' });
      res.end();
      return;
    }

    if (pathname === '/loop') {
      countHit('loop');
      track(res);
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }

    if (pathname === '/missing') {
      countHit('missing');
      track(res);
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    if (pathname === '/slow') {
      countHit('slow');
      track(res);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(32 * 1024 * 1024),
      });
      const interval = setInterval(() => {
        if (res.destroyed || res.writableEnded) {
          clearInterval(interval);
          return;
        }
        res.write(Buffer.alloc(16 * 1024, 0x42));
      }, 20);
      res.on('close', () => clearInterval(interval));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-dl-'));
});

after(async () => {
  if (typeof upstream.closeAllConnections === 'function') upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function tmpPath(name) {
  const target = path.join(tmpRoot, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

function partFiles(dir = tmpRoot) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.part')) found.push(full);
    }
  };
  walk(dir);
  return found;
}

function downloader(options = {}) {
  return createDownloader({ validator: localOnly, sleep: noopSleep, ...options });
}

test('downloads a file, verifies hashes and reports progress', async () => {
  const body = Buffer.alloc(220 * 1024, 0x41);
  state.files.set('a.jar', body);

  const dest = tmpPath('basic/a.jar');
  const events = [];
  const dl = downloader();

  const result = await dl.download({
    url: `${baseUrl}/file/a.jar`,
    dest,
    sha1: hashBuffer(body).sha1,
    size: body.length,
    source: 'minecraft',
    onProgress: (event) => events.push(event),
  });

  assert.equal(result.from, 'network');
  assert.equal(result.cached, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.bytes, body.length);
  assert.equal(result.hashes.sha1, hashBuffer(body).sha1);
  assert.equal(result.dest, path.resolve(dest));
  assert.deepEqual(fs.readFileSync(dest), body);

  assert.ok(events.length >= 3, 'progress is reported while streaming');
  assert.equal(events[0].loaded, 0);
  assert.equal(events.at(-1).loaded, body.length);
  assert.equal(events.at(-1).percent, 100);
  assert.equal(events.at(-1).total, body.length);

  const snapshot = dl.progress.snapshot();
  assert.equal(snapshot.tasks.done, 1);
  assert.equal(snapshot.bytes.loaded, body.length);
});

test('a verified file is served from cache without touching the network', async () => {
  const body = Buffer.from('cache-me');
  state.files.set('cache.jar', body);

  const dest = tmpPath('cache/cache.jar');
  const before = hits('/file/cache.jar');
  const dl = downloader();

  const first = await dl.download({
    url: `${baseUrl}/file/cache.jar`,
    dest,
    sha1: hashBuffer(body).sha1,
    size: body.length,
  });
  const second = await dl.download({
    url: `${baseUrl}/file/cache.jar`,
    dest,
    sha1: hashBuffer(body).sha1,
    size: body.length,
  });

  assert.equal(first.from, 'network');
  assert.equal(second.from, 'cache');
  assert.equal(second.cached, true);
  assert.equal(second.attempts, 0);
  assert.equal(second.hashes.sha1, hashBuffer(body).sha1);
  assert.equal(hits('/file/cache.jar'), before + 1, 'the second call is served from disk');

  fs.writeFileSync(dest, Buffer.from('tampered on disk'));

  const third = await dl.download({
    url: `${baseUrl}/file/cache.jar`,
    dest,
    sha1: hashBuffer(body).sha1,
    size: body.length,
  });
  assert.equal(third.from, 'network', 'a corrupt cached file is downloaded again');
  assert.equal(hits('/file/cache.jar'), before + 2);
  assert.deepEqual(fs.readFileSync(dest), body, 'the cached copy is repaired');
});

test('gzip responses are decoded before hashing', async () => {
  const body = Buffer.from('compressed payload for hashing');
  state.files.set('gzip.jar', body);

  const dest = tmpPath('gzip/gzip.jar');
  const result = await downloader().download({
    url: `${baseUrl}/gzip/gzip.jar`,
    dest,
    sha1: hashBuffer(body).sha1,
    sha512: hashBuffer(body, ['sha512']).sha512,
    size: body.length,
  });

  assert.equal(result.bytes, body.length);
  assert.deepEqual(fs.readFileSync(dest), body);
});

test('checksum mismatches are retried and never stored', async () => {
  state.files.set('tampered.jar', Buffer.from('tampered content'));
  const dest = tmpPath('tampered/tampered.jar');
  const before = hits('/file/tampered.jar');

  const dl = downloader({ retries: 1 });
  await assert.rejects(
    () =>
      dl.download({
        url: `${baseUrl}/file/tampered.jar`,
        dest,
        sha1: hashBuffer(Buffer.from('original content')).sha1,
      }),
    (err) => err instanceof ChecksumMismatchError && err.code === 'CHECKSUM_MISMATCH' && err.mismatches.length === 1
  );

  assert.equal(hits('/file/tampered.jar'), before + 2, 'one attempt plus one retry');
  assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(partFiles(), []);
});

test('upstream 5xx responses are retried with backoff', async () => {
  const dest = tmpPath('flaky/flaky.txt');
  const before = hits('flaky');

  const result = await downloader({ retries: 3 }).download({
    url: `${baseUrl}/flaky?fail=2&body=finally`,
    dest,
  });

  assert.equal(result.attempts, 3);
  assert.equal(result.bytes, 7);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'finally');
  assert.equal(hits('flaky'), before + 3);
});

test('4xx responses fail immediately without retries', async () => {
  const dest = tmpPath('missing/missing.txt');
  const before = hits('missing');

  await assert.rejects(
    () => downloader({ retries: 3 }).download({ url: `${baseUrl}/missing`, dest }),
    (err) => err instanceof UpstreamError && err.upstreamStatus === 404
  );

  assert.equal(hits('missing'), before + 1);
  assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(partFiles(), []);
});

test('redirects are followed and re-validated on every hop', async () => {
  const body = Buffer.from('redirected payload');
  state.files.set('redir.jar', body);

  const dest = tmpPath('redirect/redir.jar');
  const result = await downloader().download({
    url: `${baseUrl}/redirect-to/redir.jar`,
    dest,
    sha1: hashBuffer(body).sha1,
  });

  assert.equal(result.bytes, body.length);
  assert.match(result.url, /\/file\/redir\.jar$/);

  const evilDest = tmpPath('redirect/evil.jar');
  await assert.rejects(
    () => downloader().download({ url: `${baseUrl}/to-evil`, dest: evilDest }),
    (err) => err instanceof SourceNotAllowedError && err.details.host === 'evil.example.com'
  );
  assert.equal(fs.existsSync(evilDest), false);
  assert.deepEqual(partFiles(), []);

  await assert.rejects(
    () => downloader({ retries: 0 }).download({ url: `${baseUrl}/loop`, dest: tmpPath('redirect/loop.jar') }),
    (err) => err instanceof UpstreamError && /redirects/.test(err.message)
  );
});

test('downloads to hosts outside the official allowlist are rejected before any request', async () => {
  const before = hits('/file/a.jar');

  await assert.rejects(
    () =>
      downloadToFile({
        url: 'https://mirror.example.com/client.jar',
        dest: tmpPath('allowlist/client.jar'),
        validator: validateUrl,
      }),
    (err) => err instanceof SourceNotAllowedError && err.code === 'URL_NOT_ALLOWED'
  );

  await assert.rejects(
    () => downloadToFile({ url: `${baseUrl}/file/a.jar`, dest: tmpPath('allowlist/local.jar') }),
    (err) => err instanceof SourceNotAllowedError
  );

  assert.equal(hits('/file/a.jar'), before);
  assert.equal(fs.existsSync(tmpPath('allowlist/client.jar')), false);
});

test('a download can be cancelled and leaves no partial file behind', async () => {
  const dest = tmpPath('cancel/slow.bin');
  const controller = new AbortController();
  const dl = downloader({ retries: 3 });
  let sawData = false;

  const promise = dl.download({
    url: `${baseUrl}/slow`,
    dest,
    signal: controller.signal,
    onProgress: (event) => {
      if (event.loaded > 0 && !sawData) {
        sawData = true;
        controller.abort();
      }
    },
  });

  await assert.rejects(promise, (err) => err instanceof CancelledError && err.code === 'CANCELLED');
  assert.equal(sawData, true, 'the download started before it was cancelled');
  assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(partFiles(), []);
  assert.equal(dl.progress.snapshot().tasks.cancelled, 1);
  assert.equal(dl.progress.snapshot().tasks.done, 0);
});

test('the queue never runs more downloads than its concurrency allows', async () => {
  state.delayMs = 30;
  const bodies = new Map();
  const tasks = [];

  for (let index = 0; index < 5; index += 1) {
    const name = `concurrent-${index}.jar`;
    const body = Buffer.from(`concurrent payload ${index}`);
    state.files.set(name, body);
    bodies.set(name, body);
    tasks.push({
      id: name,
      url: `${baseUrl}/file/${name}`,
      dest: tmpPath(`concurrent/${name}`),
      sha1: hashBuffer(body).sha1,
    });
  }

  state.maxInFlight = 0;
  const dl = downloader({ concurrency: 2 });
  const outcomes = await dl.run(tasks);
  state.delayMs = 0;

  assert.equal(outcomes.length, 5);
  assert.ok(outcomes.every((outcome) => outcome.status === 'ok'));
  assert.ok(state.maxInFlight <= 2, `expected at most 2 concurrent requests, saw ${state.maxInFlight}`);

  for (const task of tasks) {
    assert.deepEqual(fs.readFileSync(task.dest), bodies.get(path.basename(task.dest)));
  }

  const snapshot = dl.progress.snapshot();
  assert.equal(snapshot.tasks.done, 5);
  assert.equal(dl.stats().completed, 5);
});

test('run() reports successes and failures without stopping the batch', async () => {
  const body = Buffer.from('batch payload');
  state.files.set('batch.jar', body);

  const dl = downloader({ retries: 0 });
  const outcomes = await dl.run([
    { id: 'ok', url: `${baseUrl}/file/batch.jar`, dest: tmpPath('batch/ok.jar'), sha1: hashBuffer(body).sha1 },
    { id: 'bad', url: `${baseUrl}/missing`, dest: tmpPath('batch/bad.jar') },
    { id: 'invalid', url: '', dest: tmpPath('batch/invalid.jar') },
  ]);

  assert.deepEqual(outcomes.map((entry) => entry.status), ['ok', 'error', 'error']);
  assert.ok(outcomes[1].error instanceof UpstreamError);
  assert.ok(outcomes[2].error instanceof ValidationError);
  assert.equal(outcomes[0].result.bytes, body.length);
  assert.equal(dl.stats().completed, 1);
  assert.equal(dl.stats().failed, 1, 'the invalid task never enters the queue');
});

test('queued downloads can be cancelled through the queue', async () => {
  const body = Buffer.alloc(1024, 0x43);
  state.files.set('queue-cancel.jar', body);

  const dl = downloader({ concurrency: 1 });
  const handle = dl.add({
    id: 'first',
    url: `${baseUrl}/slow`,
    dest: tmpPath('queue/first.bin'),
    retries: 0,
  });
  const pendingHandle = dl.add({
    id: 'second',
    url: `${baseUrl}/file/queue-cancel.jar`,
    dest: tmpPath('queue/second.jar'),
    retries: 0,
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(dl.cancel('second'), true);
  await assert.rejects(() => pendingHandle.promise, (err) => err instanceof CancelledError);
  assert.equal(fs.existsSync(tmpPath('queue/second.jar')), false);

  dl.cancel('first');
  await assert.rejects(() => handle.promise, (err) => err instanceof CancelledError);
  await dl.onIdle();

  assert.equal(dl.stats().cancelled, 2);
  assert.equal(dl.stats().running, 0);
});

test('cachePath keeps downloads inside the cache directory', () => {
  const cacheDir = tmpPath('cache-root');
  const dl = downloader({ cacheDir });

  assert.equal(dl.cachePath('libraries/com/mojang/authlib.jar'), path.join(cacheDir, 'libraries/com/mojang/authlib.jar'));
  assert.throws(() => dl.cachePath('../../escape.jar'), (err) => err.code === 'PATH_ESCAPE');
  assert.throws(() => downloader().cachePath('x'), (err) => err.code === 'NO_CACHE_DIR');
});

test('task validation fails fast with typed errors', async () => {
  const dl = downloader();
  assert.throws(() => dl.download({ dest: tmpPath('x/y.jar') }), (err) => err.code === 'INVALID_URL');
  assert.throws(() => dl.download({ url: `${baseUrl}/file/a.jar` }), (err) => err.code === 'INVALID_DEST');
  assert.throws(() => dl.download({ url: 'x', dest: 'y', retries: -1 }), (err) => err.code === 'INVALID_RETRY_POLICY');
});

test('isRetryable classifies download errors', () => {
  assert.equal(isRetryable(new CancelledError('nope')), false);
  assert.equal(isRetryable(new SourceNotAllowedError('nope')), false);
  assert.equal(isRetryable(new ChecksumMismatchError('nope')), true);
  assert.equal(isRetryable(new DownloadError('network', { code: 'DOWNLOAD_NETWORK_ERROR' })), true);
  assert.equal(isRetryable(new DownloadError('limit', { code: 'DOWNLOAD_SIZE_LIMIT' })), false);
  assert.equal(isRetryable(new UpstreamError('server', { upstreamStatus: 503 })), true);
  assert.equal(isRetryable(new UpstreamError('gone', { upstreamStatus: 404 })), false);
  assert.equal(isRetryable(new Error('unknown')), false);
});

test('the downloader exposes its queue, progress tracker and defaults', () => {
  const dl = downloader({ concurrency: 3, retries: 1 });

  assert.equal(dl.queue.concurrency, 3);
  assert.equal(dl.defaults.retries, 1);
  assert.equal(typeof dl.onIdle, 'function');
  assert.equal(typeof dl.cancelAll, 'function');
  assert.equal(dl.progress.size, 0);
  assert.deepEqual(dl.stats().bytes, { loaded: 0, total: 0, percent: null });
});
