// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createHttpClient, httpClient } from '../../src/net/http.js';
import { SourceNotAllowedError, UpstreamError, CorruptDataError } from '../../src/core/errors.js';

let upstream;
let port;

const localOnly = (input) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new SourceNotAllowedError(`Host not allowed: ${url.hostname}`, {
      details: { host: url.hostname },
    });
  }
  return url;
};

function writeJson(res, status, payload, headers = {}) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/json') {
      writeJson(res, 200, { ok: true, route: 'json' });
      return;
    }

    if (req.url === '/echo') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let received = null;
        try {
          received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          received = null;
        }
        writeJson(res, 200, {
          method: req.method,
          contentType: req.headers['content-type'] ?? null,
          received,
        });
      });
      return;
    }

    if (req.url === '/gzip') {
      const data = zlib.gzipSync(JSON.stringify({ compressed: true }));
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': data.length,
      });
      res.end(data);
      return;
    }

    if (req.url === '/bad-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{ this is not json');
      return;
    }

    if (req.url === '/missing') {
      writeJson(res, 404, { error: 'missing' });
      return;
    }

    if (req.url === '/denied') {
      writeJson(res, 400, {
        error: 'invalid_client',
        error_description: 'AADSTS7000218: Enable "Allow public client flows" in the app registration.',
      });
      return;
    }

    if (req.url === '/to-self') {
      res.writeHead(302, { location: '/json' });
      res.end();
      return;
    }

    if (req.url === '/to-evil') {
      res.writeHead(302, { location: 'http://evil.example.com/payload.jar' });
      res.end();
      return;
    }

    if (req.url === '/slow') {
      setTimeout(() => {
        if (res.destroyed) return;
        writeJson(res, 200, { ok: true, route: 'slow' });
      }, 400);
      return;
    }

    if (req.url === '/huge') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      for (let i = 0; i < 64; i += 1) res.write(chunk);
      res.end();
      return;
    }

    writeJson(res, 404, { error: 'not found' });
  });

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  port = upstream.address().port;
});

after(async () => {
  if (typeof upstream.closeAllConnections === 'function') upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});

test('default client refuses hosts outside the official allowlist', async () => {
  await assert.rejects(
    () => httpClient.request(`http://127.0.0.1:${port}/json`),
    (err) => err instanceof SourceNotAllowedError && err.code === 'URL_NOT_ALLOWED' && err.status === 403
  );

  await assert.rejects(
    () => httpClient.getJson('https://mirror.example.com/version_manifest.json'),
    SourceNotAllowedError
  );
});

test('client performs requests only when the validator allows the host', async () => {
  const client = createHttpClient({ validator: localOnly });
  const res = await client.getJson(`http://127.0.0.1:${port}/json`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: true, route: 'json' });
  assert.match(res.headers['content-type'], /application\/json/);
});

test('postJson sends a JSON body with the right content type', async () => {
  const client = createHttpClient({ validator: localOnly });
  const res = await client.postJson(`http://127.0.0.1:${port}/echo`, { hello: 'world' });

  assert.equal(res.status, 200);
  assert.equal(res.data.method, 'POST');
  assert.match(res.data.contentType, /application\/json/);
  assert.deepEqual(res.data.received, { hello: 'world' });
});

test('gzip responses are decoded', async () => {
  const client = createHttpClient({ validator: localOnly });
  const res = await client.getJson(`http://127.0.0.1:${port}/gzip`);
  assert.deepEqual(res.data, { compressed: true });
});

test('non-2xx upstream responses raise UpstreamError unless allowlisted', async () => {
  const client = createHttpClient({ validator: localOnly });

  await assert.rejects(
    () => client.getJson(`http://127.0.0.1:${port}/missing`),
    (err) =>
      err instanceof UpstreamError &&
      err.upstreamStatus === 404 &&
      err.status === 502 &&
      err.details.upstream === 'missing'
  );

  await assert.rejects(
    () => client.getJson(`http://127.0.0.1:${port}/denied`),
    (err) =>
      err instanceof UpstreamError &&
      err.upstreamStatus === 400 &&
      err.details.upstream.startsWith('AADSTS7000218') &&
      err.details.upstream.includes('Allow public client flows')
  );

  const res = await client.getJson(`http://127.0.0.1:${port}/missing`, { allowStatus: [404] });
  assert.equal(res.status, 404);
  assert.deepEqual(res.data, { error: 'missing' });
});

test('invalid JSON from upstream raises CorruptDataError', async () => {
  const client = createHttpClient({ validator: localOnly });
  await assert.rejects(() => client.getJson(`http://127.0.0.1:${port}/bad-json`), CorruptDataError);
});

test('redirects are followed but re-validated at every hop', async () => {
  const client = createHttpClient({ validator: localOnly });

  const allowed = await client.getJson(`http://127.0.0.1:${port}/to-self`);
  assert.deepEqual(allowed.data, { ok: true, route: 'json' });

  await assert.rejects(
    () => client.getJson(`http://127.0.0.1:${port}/to-evil`),
    (err) => err instanceof SourceNotAllowedError && err.details.host === 'evil.example.com'
  );
});

test('redirect policy can be set to error', async () => {
  const client = createHttpClient({ validator: localOnly });
  await assert.rejects(
    () => client.getJson(`http://127.0.0.1:${port}/to-self`, { redirect: 'error' }),
    (err) => err instanceof UpstreamError && err.upstreamStatus === 302
  );
});

test('timeouts raise UpstreamError', async () => {
  const client = createHttpClient({ validator: localOnly, timeoutMs: 80 });
  await assert.rejects(
    () => client.getJson(`http://127.0.0.1:${port}/slow`),
    (err) => err instanceof UpstreamError && /timed out/.test(err.message)
  );
});

test('oversized responses raise UpstreamError', async () => {
  const client = createHttpClient({ validator: localOnly, maxBytes: 64 * 1024 });
  await assert.rejects(
    () => client.request(`http://127.0.0.1:${port}/huge`),
    (err) => err instanceof UpstreamError && /size limit/.test(err.message)
  );
});
