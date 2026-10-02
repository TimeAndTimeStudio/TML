// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AppError,
  CancelledError,
  ChecksumMismatchError,
  DownloadError,
  UpstreamError,
  ValidationError,
} from '../core/errors.js';
import { ensureDirForFile, resolveWithin } from '../core/filesystem.js';
import { DEFAULT_USER_AGENT } from '../net/http.js';
import { validateUrl } from '../security/urls.js';
import { createHasher, hashFile, verifyHashes } from './hash.js';
import { createProgress, percentOf } from './progress.js';
import { createQueue } from './queue.js';

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_RETRIES = 3;
export const DEFAULT_RETRY_DELAY_MS = 250;
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
export const PROGRESS_INTERVAL_BYTES = 64 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NON_RETRYABLE_CODES = new Set(['DOWNLOAD_SIZE_LIMIT', 'UNSUPPORTED_CONTENT_ENCODING']);

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireNonEmptyString(value, field, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`Field "${field}" must be a non-empty string`, {
      code,
      details: { field },
    });
  }
  return value.trim();
}

function requireCount(value, field) {
  const count = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(count) || count < 0) {
    throw new ValidationError(`Field "${field}" must be a non-negative integer`, {
      code: 'INVALID_RETRY_POLICY',
      details: { field, value: String(value) },
    });
  }
  return count;
}

export function isRetryable(err) {
  if (err instanceof CancelledError) return false;
  if (err instanceof ValidationError) return false;
  if (err instanceof ChecksumMismatchError) return true;
  if (err instanceof UpstreamError) {
    const status = err.upstreamStatus;
    if (typeof status !== 'number') return true;
    return status >= 500 || status === 408 || status === 425 || status === 429;
  }
  if (err instanceof DownloadError) return !NON_RETRYABLE_CODES.has(err.code);
  return false;
}

export function normalizeError(err, signal = null, details = undefined) {
  if (signal?.aborted) {
    return err instanceof CancelledError
      ? err
      : new CancelledError('Download cancelled', { cause: err, details });
  }
  if (err instanceof AppError) return err;
  if (err instanceof Error && err.name === 'AbortError') {
    return new CancelledError('Download cancelled', { cause: err, details });
  }

  const code = err && typeof err === 'object' ? err.code : undefined;
  const message = err instanceof Error ? err.message : String(err);

  if (code === 'ERR_STREAM_PREMATURE_CLOSE') {
    return new DownloadError('Upstream closed the connection before the download completed', {
      code: 'DOWNLOAD_INCOMPLETE',
      cause: err,
      details,
    });
  }
  if (typeof code === 'string' && /^E[A-Z]/.test(code)) {
    return new DownloadError(message, {
      code: 'DOWNLOAD_NETWORK_ERROR',
      cause: err,
      details: { ...details, syscall: code },
    });
  }
  return new DownloadError(message || 'Download failed', { cause: err, details });
}

function normalizeEncoding(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const normalized = raw.toLowerCase().trim();
  return normalized === 'identity' ? null : normalized;
}

function createDecoder(encoding) {
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.createGunzip();
  if (encoding === 'deflate') return zlib.createInflate();
  if (encoding === 'br') return zlib.createBrotliDecompress();
  throw new DownloadError(`Unsupported content-encoding: ${encoding}`, {
    code: 'UNSUPPORTED_CONTENT_ENCODING',
    details: { encoding },
  });
}

function parseContentLength(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function openRequest(url, { timeoutMs, signal, headers }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError('Download cancelled', { details: { host: url.hostname } }));
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(normalizeError(err, signal, { host: url.hostname }));
    };

    const req = transport.request(
      url,
      {
        method: 'GET',
        headers: { 'user-agent': DEFAULT_USER_AGENT, accept: '*/*', ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        resolve({ req, res });
      }
    );

    const onAbort = () => {
      req.destroy(new CancelledError('Download cancelled', { details: { host: url.hostname } }));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));

    req.on('timeout', () => {
      req.destroy(
        new DownloadError(`Download timed out after ${timeoutMs}ms`, {
          code: 'DOWNLOAD_TIMEOUT',
          details: { timeoutMs, host: url.hostname },
        })
      );
    });
    req.on('error', fail);
    req.end();
  });
}

async function writeResponse({ res, req, tmpFile, hasher, expectedSize, maxBytes, onProgress, signal }) {
  const encoding = normalizeEncoding(res.headers['content-encoding']);
  const declared = parseContentLength(res.headers['content-length']);
  const total = expectedSize ?? (encoding === null ? declared : null);

  let loaded = 0;
  let lastEmitted = -1;

  const emitProgress = () => {
    if (!onProgress) return;
    try {
      onProgress({ loaded, total, percent: percentOf(loaded, total) });
    } catch {
      // Progress reporting must never break a download.
    }
  };

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      loaded += chunk.length;
      hasher.update(chunk);

      if (maxBytes !== null && loaded > maxBytes) {
        callback(
          new DownloadError('Download exceeds the configured size limit', {
            code: 'DOWNLOAD_SIZE_LIMIT',
            details: { maxBytes },
          })
        );
        return;
      }

      if (expectedSize !== null && loaded > expectedSize) {
        callback(
          new DownloadError('Downloaded size does not match the expected size', {
            code: 'DOWNLOAD_SIZE_MISMATCH',
            details: { expected: expectedSize, actual: loaded },
          })
        );
        return;
      }

      if (loaded - lastEmitted >= PROGRESS_INTERVAL_BYTES) {
        lastEmitted = loaded;
        emitProgress();
      }
      callback(null, chunk);
    },
  });

  const onAbort = () => res.destroy(new CancelledError('Download cancelled'));

  let rejectFailure;
  const failure = new Promise((_resolve, reject) => {
    rejectFailure = reject;
  });
  const onReqError = (err) => rejectFailure(err);
  const onAborted = () =>
    rejectFailure(
      new DownloadError('Upstream closed the connection before the download completed', {
        code: 'DOWNLOAD_INCOMPLETE',
      })
    );

  const stages = [res];
  let succeeded = false;
  try {
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', onReqError);
    res.on('aborted', onAborted);

    if (encoding !== null) stages.push(createDecoder(encoding));
    stages.push(meter, fs.createWriteStream(tmpFile));

    lastEmitted = 0;
    emitProgress();
    await Promise.race([pipeline(...stages), failure]);
    succeeded = true;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    req.off('error', onReqError);
    res.off('aborted', onAborted);
    if (!succeeded) {
      for (const stage of stages) {
        try {
          stage.destroy?.();
        } catch {
          // Ignore teardown failures.
        }
      }
    }
  }

  if (loaded !== lastEmitted) {
    lastEmitted = loaded;
    emitProgress();
  }

  return loaded;
}

async function statOrNull(target) {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

async function readCached(target, expected, algorithms, expectedSize) {
  const stat = await statOrNull(target);
  if (!stat || !stat.isFile()) return null;
  if (expectedSize !== null && stat.size !== expectedSize) return null;

  const hashes = await hashFile(target, algorithms);
  try {
    verifyHashes(hashes, expected, { file: target });
  } catch (err) {
    if (err instanceof ChecksumMismatchError) return null;
    throw err;
  }

  return { bytes: stat.size, hashes };
}

async function fetchToFile(options) {
  const {
    startUrl,
    target,
    source,
    validator,
    expected,
    expectedSize,
    algorithms,
    timeoutMs,
    maxRedirects,
    maxBytes,
    onProgress,
    signal,
    id,
  } = options;

  const tmpFile = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
  await ensureDirForFile(target);
  const hasher = createHasher(algorithms);

  try {
    let current = startUrl;
    let redirects = 0;

    for (;;) {
      if (signal?.aborted) {
        throw new CancelledError('Download cancelled', { details: { id, url: startUrl.href } });
      }

      const { req, res } = await openRequest(current, { timeoutMs, signal });
      const status = res.statusCode ?? 0;
      const location = res.headers.location;

      if (REDIRECT_STATUSES.has(status) && location) {
        res.resume();
        redirects += 1;
        if (redirects > maxRedirects) {
          throw new UpstreamError('Too many upstream redirects', {
            details: { maxRedirects, host: current.hostname },
          });
        }
        current = validator(new URL(location, current), { source });
        continue;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        throw new UpstreamError(`Download failed with HTTP ${status}`, {
          upstreamStatus: status,
          details: { status, host: current.hostname },
        });
      }

      const bytes = await writeResponse({
        res,
        req,
        tmpFile,
        hasher,
        expectedSize,
        maxBytes,
        onProgress,
        signal,
      });

      const hashes = hasher.digest();
      verifyHashes(hashes, expected, { file: target });

      if (expectedSize !== null && bytes !== expectedSize) {
        throw new DownloadError('Downloaded size does not match the expected size', {
          code: 'DOWNLOAD_SIZE_MISMATCH',
          details: { expected: expectedSize, actual: bytes },
        });
      }

      await fsp.rename(tmpFile, target);
      return { bytes, hashes, url: current.href, status };
    }
  } catch (err) {
    await fsp.rm(tmpFile, { force: true }).catch(() => {});
    throw normalizeError(err, signal, { id, url: startUrl.href });
  }
}

export async function downloadToFile(task) {
  if (!task || typeof task !== 'object') {
    throw new ValidationError('Download task must be an object', { code: 'INVALID_TASK' });
  }

  const {
    url,
    dest,
    source = undefined,
    sha1 = null,
    sha512 = null,
    size = null,
    validator = validateUrl,
    signal = null,
    onProgress = null,
    logger = null,
    force = false,
    id = null,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxBytes = DEFAULT_MAX_BYTES,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = task;

  const rawUrl = requireNonEmptyString(url, 'url', 'INVALID_URL');
  const rawDest = requireNonEmptyString(dest, 'dest', 'INVALID_DEST');
  const retryCount = requireCount(retries, 'retries');
  const target = path.resolve(rawDest);
  const startUrl = validator(rawUrl, { source });

  const algorithms = sha1 || sha512 ? (sha512 ? ['sha1', 'sha512'] : ['sha1']) : ['sha1'];
  const expected = {};
  if (sha1) expected.sha1 = sha1;
  if (sha512) expected.sha512 = sha512;
  const expectedSize = size === null || size === undefined ? null : requireCount(size, 'size');

  const taskId = id === null || id === undefined ? null : String(id);
  const startedAt = now();

  if (!force) {
    const cached = await readCached(target, expected, algorithms, expectedSize);
    if (cached) {
      logger?.debug('download served from cache', { id: taskId, dest: target, bytes: cached.bytes });
      return {
        id: taskId,
        url: rawUrl,
        dest: target,
        bytes: cached.bytes,
        hashes: cached.hashes,
        from: 'cache',
        cached: true,
        attempts: 0,
        durationMs: now() - startedAt,
      };
    }
  }

  const maxAttempts = retryCount + 1;
  let attempt = 0;

  while (attempt < maxAttempts) {
    if (signal?.aborted) {
      throw new CancelledError('Download cancelled', { details: { id: taskId, url: rawUrl } });
    }

    attempt += 1;
    try {
      const result = await fetchToFile({
        startUrl,
        target,
        source,
        validator,
        expected,
        expectedSize,
        algorithms,
        timeoutMs,
        maxRedirects,
        maxBytes,
        onProgress,
        signal,
        id: taskId,
      });

      logger?.debug('download stored', {
        id: taskId,
        dest: target,
        bytes: result.bytes,
        attempts: attempt,
      });

      return {
        id: taskId,
        url: result.url,
        dest: target,
        bytes: result.bytes,
        hashes: result.hashes,
        from: 'network',
        cached: false,
        attempts: attempt,
        durationMs: now() - startedAt,
      };
    } catch (err) {
      const normalized = normalizeError(err, signal, { id: taskId, url: rawUrl });
      if (!isRetryable(normalized) || attempt >= maxAttempts) throw normalized;

      const delay = retryDelayMs * 2 ** (attempt - 1);
      logger?.warn('download failed, retrying', {
        id: taskId,
        attempt,
        maxAttempts,
        delayMs: delay,
        code: normalized.code,
        message: normalized.message,
      });

      if (delay > 0) await sleep(delay);
    }
  }

  throw new DownloadError('Download failed', { details: { id: taskId, url: rawUrl } });
}

function validateTask(task) {
  if (!task || typeof task !== 'object') {
    throw new ValidationError('Download task must be an object', { code: 'INVALID_TASK' });
  }
  requireNonEmptyString(task.url, 'url', 'INVALID_URL');
  requireNonEmptyString(task.dest, 'dest', 'INVALID_DEST');
  if (task.retries !== undefined) requireCount(task.retries, 'retries');
  if (task.size !== undefined && task.size !== null) requireCount(task.size, 'size');
  return task;
}

export function createDownloader(options = {}) {
  const config = options.config ?? null;
  const cacheDir = options.cacheDir ?? config?.paths?.cacheDir ?? null;
  const validator = options.validator ?? validateUrl;
  const logger = options.logger ?? null;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const progress = options.progress ?? createProgress({ now });

  const defaults = {
    retries: options.retries ?? DEFAULT_RETRIES,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  };

  const queue = createQueue({ concurrency, idPrefix: 'dl' });
  let sequence = 0;

  function cachePath(key) {
    if (!cacheDir) {
      throw new ValidationError('cachePath() requires a cache directory', { code: 'NO_CACHE_DIR' });
    }
    return resolveWithin(cacheDir, key);
  }

  function nextId(task) {
    return String(task.id ?? `dl-${++sequence}`);
  }

  function wireProgress(id, task) {
    progress.register(id, { total: task.size ?? null, url: task.url });
    const listener = typeof task.onProgress === 'function' ? task.onProgress : null;
    if (!listener) return (info) => progress.update(id, { loaded: info.loaded, total: info.total });

    return (info) => {
      progress.update(id, { loaded: info.loaded, total: info.total });
      try {
        listener({ ...info, id, dest: task.dest });
      } catch {
        // User progress callbacks must never break a download.
      }
    };
  }

  async function runTask(id, task, { signal = null, onProgress } = {}) {
    const activeSignal = signal ?? task.signal ?? null;
    try {
      const result = await downloadToFile({
        ...defaults,
        ...task,
        id,
        signal: activeSignal,
        onProgress,
        validator,
        logger,
        now,
        sleep,
      });
      progress.finish(id, { bytes: result.bytes });
      logger?.info('download complete', {
        id,
        dest: result.dest,
        bytes: result.bytes,
        attempts: result.attempts,
        from: result.from,
      });
      return result;
    } catch (err) {
      progress.fail(id, err);
      logger?.warn('download failed', { id, dest: task.dest, code: err?.code, message: err?.message });
      throw err;
    }
  }

  function download(task) {
    validateTask(task);
    const id = nextId(task);
    const onProgress = wireProgress(id, task);
    return runTask(id, task, { onProgress });
  }

  function add(task) {
    validateTask(task);
    const id = nextId(task);
    const onProgress = wireProgress(id, task);
    return queue.add({
      id,
      run: ({ signal }) => runTask(id, task, { signal, onProgress }),
    });
  }

  async function run(tasks) {
    const list = Array.isArray(tasks) ? tasks : [tasks];
    const outcomes = new Array(list.length);
    const pending = [];

    list.forEach((task, index) => {
      try {
        const handle = add(task);
        pending.push({ index, id: handle.id, promise: handle.promise });
      } catch (err) {
        outcomes[index] = { id: null, status: 'error', error: err };
      }
    });

    const settled = await Promise.allSettled(pending.map((entry) => entry.promise));
    settled.forEach((entry, position) => {
      const { index, id } = pending[position];
      outcomes[index] =
        entry.status === 'fulfilled'
          ? { id, status: 'ok', result: entry.value }
          : { id, status: 'error', error: entry.reason };
    });

    return outcomes;
  }

  function stats() {
    return { ...queue.stats(), bytes: progress.snapshot().bytes };
  }

  return {
    download,
    add,
    run,
    cancel: queue.cancel,
    cancelAll: queue.cancelAll,
    onIdle: queue.onIdle,
    stats,
    cachePath,
    cacheDir,
    defaults,
    progress,
    queue,
  };
}
