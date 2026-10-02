// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';

export const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
});

const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|cookie|credential|api[-_]?key)/i;
const MAX_DEPTH = 6;

export function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (value instanceof Error) return normalizeError(value, depth);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(entry, depth + 1);
  }
  return out;
}

function normalizeError(err, depth = 0) {
  const out = { name: err.name, message: err.message };
  if (err.code !== undefined) out.code = err.code;
  if (typeof err.stack === 'string' && depth === 0) out.stack = err.stack;
  if (err.cause !== undefined && depth < 2) out.cause = redact(err.cause, depth + 1);
  return out;
}

function safeStringify(meta) {
  try {
    const json = JSON.stringify(redact(meta));
    return json === undefined ? '' : ` ${json}`;
  } catch {
    return ' [unserializable-meta]';
  }
}

function normalizeLevel(level, fallback = 'info') {
  const next = typeof level === 'string' ? level.trim().toLowerCase() : level;
  return LEVELS[next] === undefined ? fallback : next;
}

export function createLogger(options = {}) {
  const {
    level = 'info',
    file = null,
    context = {},
    stdout = process.stdout,
    stderr = process.stderr,
  } = options;

  let currentLevel = normalizeLevel(level);

  function appendTo(line) {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      // Logging must never crash the launcher.
    }
  }

  function emit(lvl, message, meta) {
    if (LEVELS[lvl] < LEVELS[currentLevel]) return;

    const contextKeys = Object.keys(context);
    const contextText = contextKeys.length
      ? ` [${contextKeys.map((key) => `${key}=${context[key]}`).join(' ')}]`
      : '';
    const metaText = meta === undefined ? '' : safeStringify(meta);
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)}${contextText} ${message}${metaText}`;

    appendTo(line);
    (lvl === 'warn' || lvl === 'error' ? stderr : stdout).write(`${line}\n`);
  }

  return {
    get level() {
      return currentLevel;
    },
    setLevel(next) {
      currentLevel = normalizeLevel(next, currentLevel);
    },
    child(childContext) {
      return createLogger({
        level: currentLevel,
        file,
        context: { ...context, ...childContext },
        stdout,
        stderr,
      });
    },
    debug(message, meta) {
      emit('debug', message, meta);
    },
    info(message, meta) {
      emit('info', message, meta);
    },
    warn(message, meta) {
      emit('warn', message, meta);
    },
    error(message, meta) {
      emit('error', message, meta);
    },
  };
}
