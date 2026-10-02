// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { CorruptDataError, UpstreamError } from '../core/errors.js';
import { validateUrl } from '../security/urls.js';
import { VERSION } from '../core/config.js';

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotliDecompress = promisify(zlib.brotliDecompress);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const DEFAULT_USER_AGENT = `TML/${VERSION} (Time Mini Launcher)`;

function hostOf(url) {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  return parsed.hostname;
}

function isPlainBodyObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Buffer.isBuffer(value) &&
    !ArrayBuffer.isView(value)
  );
}

async function decodeBody(body, encoding) {
  if (!encoding) return body;

  const normalized = String(encoding).toLowerCase().trim();
  if (normalized === '' || normalized === 'identity') return body;

  try {
    if (normalized === 'gzip' || normalized === 'x-gzip') return await gunzip(body);
    if (normalized === 'br') return await brotliDecompress(body);
    if (normalized === 'deflate') {
      try {
        return await inflate(body);
      } catch {
        return await inflateRaw(body);
      }
    }
  } catch (err) {
    throw new UpstreamError('Failed to decompress upstream response', {
      cause: err,
      details: { encoding: normalized },
    });
  }

  throw new UpstreamError(`Unsupported content-encoding: ${normalized}`, {
    details: { encoding: normalized },
  });
}

function performRequest(url, { method, headers, body, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = transport.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;

      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          fail(new UpstreamError('Upstream response exceeds the size limit', {
            details: { maxBytes, host: hostOf(url) },
          }));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });

      res.on('error', fail);
      res.on('aborted', () => fail(new UpstreamError('Upstream response was aborted', {
        details: { host: hostOf(url) },
      })));
    });

    req.on('timeout', () => {
      req.destroy(new UpstreamError('Upstream request timed out', {
        details: { timeoutMs, host: hostOf(url) },
      }));
    });

    req.on('error', fail);

    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

export function assertOk(res, { allowStatus = [] } = {}) {
  if (res.status >= 200 && res.status < 300) return res;
  if (allowStatus.includes(res.status)) return res;

  const details = { status: res.status, host: hostOf(res.url) };
  const upstream = readUpstreamError(res.body);
  if (upstream) details.upstream = upstream;
  throw new UpstreamError(`Upstream responded with HTTP ${res.status}`, {
    upstreamStatus: res.status,
    details,
  });
}

function readUpstreamError(body) {
  if (!body || typeof body.toString !== 'function' || body.length === 0) return null;
  try {
    const data = JSON.parse(body.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    for (const key of ['error_description', 'error', 'message']) {
      const value = data[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 300);
    }
  } catch {
    /* body is not JSON — nothing to surface */
  }
  return null;
}

export function createHttpClient(options = {}) {
  const defaults = {
    validator: options.validator ?? validateUrl,
    timeoutMs: options.timeoutMs ?? 15000,
    maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
    maxRedirects: options.maxRedirects ?? 5,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    headers: options.headers ?? {},
  };

  async function request(input, opts = {}) {
    const validator = opts.validator ?? defaults.validator;
    const source = opts.source;
    const follow = opts.redirect ?? 'follow';
    const timeoutMs = opts.timeoutMs ?? defaults.timeoutMs;
    const maxBytes = opts.maxBytes ?? defaults.maxBytes;
    const maxRedirects = opts.maxRedirects ?? defaults.maxRedirects;

    let url = validator(input, { source });
    let method = (opts.method ?? 'GET').toUpperCase();
    let payload = opts.body ?? null;

    const headers = {
      'user-agent': defaults.userAgent,
      accept: '*/*',
      ...defaults.headers,
      ...opts.headers,
    };

    const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');

    if (payload !== null && payload !== undefined) {
      if (isPlainBodyObject(payload)) {
        payload = JSON.stringify(payload);
        if (!hasContentType) headers['content-type'] = 'application/json; charset=utf-8';
      }
      headers['content-length'] = String(Buffer.byteLength(payload));
    }

    for (let hop = 0; ; hop += 1) {
      const res = await performRequest(url, { method, headers, body: payload, timeoutMs, maxBytes });
      const location = res.headers.location;

      if (REDIRECT_STATUSES.has(res.status) && location) {
        if (follow === 'error') {
          throw new UpstreamError(`Upstream responded with a redirect (HTTP ${res.status})`, {
            upstreamStatus: res.status,
            details: { status: res.status, host: hostOf(url) },
          });
        }
        if (follow === 'manual') {
          const body = await decodeBody(res.body, res.headers['content-encoding']);
          return { status: res.status, headers: res.headers, url: url.href, body };
        }
        if (hop >= maxRedirects) {
          throw new UpstreamError('Too many upstream redirects', {
            details: { maxRedirects, host: hostOf(url) },
          });
        }

        url = validator(new URL(location, url), { source });

        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          payload = null;
          delete headers['content-length'];
          delete headers['content-type'];
        }
        continue;
      }

      const body = await decodeBody(res.body, res.headers['content-encoding']);
      return { status: res.status, headers: res.headers, url: url.href, body };
    }
  }

  async function getJson(input, opts = {}) {
    const res = await request(input, {
      ...opts,
      method: 'GET',
      headers: { accept: 'application/json', ...opts.headers },
    });
    assertOk(res, { allowStatus: opts.allowStatus ?? [] });

    const text = res.body.toString('utf8');
    if (text.trim() === '') return { ...res, data: null };

    try {
      return { ...res, data: JSON.parse(text) };
    } catch (err) {
      throw new CorruptDataError('Upstream returned a response that is not valid JSON', {
        cause: err,
        details: { status: res.status, host: hostOf(res.url) },
      });
    }
  }

  async function postJson(input, body, opts = {}) {
    const res = await request(input, {
      ...opts,
      method: 'POST',
      body: body ?? null,
      headers: { accept: 'application/json', ...opts.headers },
    });
    assertOk(res, { allowStatus: opts.allowStatus ?? [] });

    const text = res.body.toString('utf8');
    if (text.trim() === '') return { ...res, data: null };

    try {
      return { ...res, data: JSON.parse(text) };
    } catch (err) {
      throw new CorruptDataError('Upstream returned a response that is not valid JSON', {
        cause: err,
        details: { status: res.status, host: hostOf(res.url) },
      });
    }
  }

  async function getText(input, opts = {}) {
    const res = await request(input, { ...opts, method: 'GET' });
    assertOk(res, { allowStatus: opts.allowStatus ?? [] });
    return { ...res, text: res.body.toString('utf8') };
  }

  return { request, getJson, postJson, getText };
}

export const httpClient = createHttpClient();
