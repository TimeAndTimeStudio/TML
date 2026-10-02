// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import http from 'node:http';
import {
  MethodNotAllowedError,
  NotFoundError,
  ValidationError,
  toAppError,
} from '../core/errors.js';
import { serveStatic } from './static.js';

const MAX_BODY_BYTES = 1024 * 1024;
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);
const UPLOAD_CONTENT_TYPES = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);

function isUploadRequest(req) {
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return UPLOAD_CONTENT_TYPES.has(contentType);
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.modrinth.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
  );
}

function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded) return;

  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);

  if (payload === null || payload === undefined || status === 204) {
    res.statusCode = status === 204 ? 204 : status;
    res.end();
    return;
  }

  const data = `${JSON.stringify(payload, null, 2)}\n`;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(data));
  res.end(data);
}

async function sendError(res, err, logger) {
  const error = toAppError(err);

  if (error.status >= 500) {
    logger.error('request failed', { err: error.cause ?? error, code: error.code, message: error.message });
  } else {
    logger.debug('request rejected', { code: error.code, status: error.status, message: error.message });
  }

  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }

  const headers = {};
  if (error instanceof MethodNotAllowedError && error.allow.length > 0) {
    headers.Allow = error.allow.join(', ');
  }

  const body = { error: error.expose ? error.toJSON() : { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
  sendJson(res, error.status, body, headers);
}

async function readBody(req) {
  if (BODYLESS_METHODS.has(String(req.method).toUpperCase())) return {};

  const contentType = String(req.headers['content-type'] ?? '');
  const isJson = contentType.toLowerCase().includes('json');
  if (!isJson) {
    req.resume();
    return {};
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new ValidationError('Request body too large', { details: { limitBytes: MAX_BODY_BYTES } });
    }
    chunks.push(chunk);
  }

  if (size === 0) return {};

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') {
      throw new ValidationError('Request body must be a JSON object');
    }
    return parsed;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('Request body is not valid JSON', { cause: err });
  }
}

// Route handlers return an envelope: { status?, headers?, body } — or a plain payload.
function normalizeResult(result) {
  if (result === undefined || result === null) return { status: 204, body: null, headers: {} };

  if (typeof result === 'object' && !Array.isArray(result)) {
    const isEnvelope =
      typeof result.status === 'number' || 'body' in result || 'headers' in result;
    if (isEnvelope) {
      return {
        status: typeof result.status === 'number' ? result.status : 200,
        body: result.body ?? null,
        headers: result.headers ?? {},
      };
    }
  }

  return { status: 200, body: result, headers: {} };
}

async function handleApi(req, res, url, { config, logger, router }) {
  const matched = router.match(req.method, url.pathname);

  if (matched && matched.allowed) {
    throw new MethodNotAllowedError(`${req.method} is not allowed for ${url.pathname}`, {
      allow: matched.allowed,
    });
  }
  if (!matched) throw new NotFoundError(`No API route for ${req.method} ${url.pathname}`);

  const upload = isUploadRequest(req);
  const body = upload ? {} : await readBody(req);
  const result = await matched.handler({
    method: req.method,
    params: matched.params,
    query: url.searchParams,
    body,
    headers: req.headers,
    url,
    config,
    logger,
    req,
    res,
    upload,
  });

  if (upload && !req.readableEnded) req.resume();

  if (res.writableEnded) return;

  const { status, body: payload, headers } = normalizeResult(result);
  sendJson(res, status, payload, headers);
}

export function createTmlServer({ config, logger, router }) {
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    setSecurityHeaders(res);

    let url;
    try {
      const host = req.headers.host || `${config.server.host}:${config.server.port}`;
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch (err) {
      await sendError(res, new ValidationError('Malformed request URL', { cause: err }), logger);
      return;
    }

    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, { config, logger, router });
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic({ req, res, pathname: url.pathname, webDir: config.paths.webDir });
      } else {
        throw new MethodNotAllowedError(`${req.method} is not allowed for ${url.pathname}`, {
          allow: ['GET', 'HEAD'],
        });
      }
    } catch (err) {
      await sendError(res, err, logger);
    } finally {
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level]('http', {
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - startedAt,
      });
    }
  });

  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  return server;
}
