// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './errors.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(MODULE_DIR, '..', '..');

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8620,
  logLevel: 'warn',
};

let cachedVersion = null;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

export const VERSION = readVersion();

function readConfigFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new ConfigError(`Cannot read config file: ${file}`, { cause: err });
  }

  if (raw.trim() === '') return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in config file: ${file}`, { cause: err });
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError(`Config file must contain a JSON object: ${file}`);
  }
  return parsed;
}

function normalizeHost(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError('server.host must be a non-empty string');
  }
  return value.trim();
}

function normalizePort(value) {
  const port = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`server.port must be an integer between 0 and 65535 (got ${JSON.stringify(value)})`);
  }
  return port;
}

function normalizeLevel(value) {
  const level = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (!LOG_LEVELS.has(level)) {
    throw new ConfigError(`log.level must be one of: ${[...LOG_LEVELS].join(', ')} (got ${JSON.stringify(value)})`);
  }
  return level;
}

const CLIENT_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// ค่าเริ่มต้น = Azure app registration ของ launcher เอง — ไม่มี client ID ของบุคคลที่สามฝังอยู่
export const DEFAULT_MSA_CLIENT_ID = 'ea2a1c7b-7e70-4b72-a1a6-beb8488e12a8';
const JAVA_RUNTIME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function normalizeJavaRuntime(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !JAVA_RUNTIME_PATTERN.test(value)) {
    throw new ConfigError('java.runtime must be a runtime name like "java-runtime-gamma"');
  }
  return value;
}

// ตัวเลือก platform ของหน้าต่างเกม: 'auto' = ตาม session (Wayland native บน GNOME Wayland),
// 'x11' = บังคับผ่าน XWayland — แล้ว GNOME/mutter จะวาด title bar + ปุ่มตามธีมระบบให้เอง
export const WINDOW_PLATFORM_VALUES = Object.freeze(['auto', 'x11']);
export const DEFAULT_WINDOW_PLATFORM = 'auto';

function normalizeWindowPlatform(value) {
  const platform = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (platform === undefined || platform === null || platform === '') return DEFAULT_WINDOW_PLATFORM;
  if (!WINDOW_PLATFORM_VALUES.includes(platform)) {
    throw new ConfigError(
      `window.platform must be one of: ${WINDOW_PLATFORM_VALUES.join(', ')} (got ${JSON.stringify(value)})`,
    );
  }
  return platform;
}

export const OFFLINE_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

// LIVE FLOW — ตัวเลือกวิธี sign in: 'aad' (แอปของตัวเอง) หรือ 'live' (login.live.com + title ID)
// ลบพร้อม src/auth/live.js เมื่อแอปผ่าน review (default เป็น 'aad')
export const AUTH_FLOW_VALUES = Object.freeze(['aad', 'live']);
export const DEFAULT_AUTH_FLOW = 'aad';

function normalizeAuthFlow(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_AUTH_FLOW;
  if (typeof value !== 'string' || !AUTH_FLOW_VALUES.includes(value)) {
    throw new ConfigError(
      `auth.flow must be one of: ${AUTH_FLOW_VALUES.join(', ')} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function normalizeOfflineName(value) {
  if (value === undefined || value === null || value === '') return null;
  const trimmed = typeof value === 'string' ? value.trim() : value;
  if (typeof trimmed !== 'string' || !OFFLINE_NAME_PATTERN.test(trimmed)) {
    throw new ConfigError('auth.offlineName must be 3–16 characters of a–z, A–Z, 0–9 or "_"');
  }
  return trimmed;
}

function normalizeClientId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError('auth.clientId must be a non-empty Application (client) ID string');
  }
  const trimmed = value.trim();
  if (!CLIENT_ID_PATTERN.test(trimmed)) {
    throw new ConfigError(
      'auth.clientId must be an Application (client) ID GUID like 00000000-0000-0000-0000-000000000000',
    );
  }
  return trimmed;
}

export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const dataDir = path.resolve(env.TML_DATA_DIR || path.join(cwd, 'tml-data'));
  const configFile = path.join(dataDir, 'config.json');
  const file = readConfigFile(configFile);

  const fileServer = isPlainObject(file.server) ? file.server : {};
  const fileLog = isPlainObject(file.log) ? file.log : {};
  const fileAuth = isPlainObject(file.auth) ? file.auth : {};
  const fileJava = isPlainObject(file.java) ? file.java : {};
  const fileWindow = isPlainObject(file.window) ? file.window : {};

  const host = normalizeHost(env.TML_HOST ?? fileServer.host ?? DEFAULTS.host);
  const port = normalizePort(env.TML_PORT ?? fileServer.port ?? DEFAULTS.port);
  const level = normalizeLevel(env.TML_LOG_LEVEL ?? fileLog.level ?? DEFAULTS.logLevel);
  const javaRuntime = normalizeJavaRuntime(fileJava.runtime);
  const offlineName = normalizeOfflineName(fileAuth.offlineName);
  const authFlow = normalizeAuthFlow(fileAuth.flow);
  const windowPlatform = normalizeWindowPlatform(fileWindow.platform);

  let authClientId = DEFAULT_MSA_CLIENT_ID;
  let authSource = 'default';
  if (typeof env.TML_MSA_CLIENT_ID === 'string' && env.TML_MSA_CLIENT_ID.trim() !== '') {
    authClientId = normalizeClientId(env.TML_MSA_CLIENT_ID);
    authSource = 'env';
  } else if (typeof fileAuth.clientId === 'string' && fileAuth.clientId.trim() !== '') {
    authClientId = normalizeClientId(fileAuth.clientId);
    authSource = 'file';
  }

  const config = {
    name: 'TML',
    version: readVersion(),
    projectRoot: PROJECT_ROOT,
    dataDir,
    paths: {
      dataDir,
      configFile,
      logsDir: path.join(dataDir, 'logs'),
      instancesDir: path.join(dataDir, 'instances'),
      cacheDir: path.join(dataDir, 'cache'),
      exportsDir: path.join(dataDir, 'exports'),
      tmpDir: path.join(dataDir, 'tmp'),
      javaDir: path.join(dataDir, 'java'),
      webDir: path.join(PROJECT_ROOT, 'web'),
    },
    server: {
      host,
      port,
      hostFromEnv: env.TML_HOST !== undefined && env.TML_HOST !== null,
      portFromEnv: env.TML_PORT !== undefined && env.TML_PORT !== null,
    },
    log: {
      level,
      file: path.join(dataDir, 'logs', 'tml.log'),
      fromEnv: env.TML_LOG_LEVEL !== undefined && env.TML_LOG_LEVEL !== null,
    },
    auth: { clientId: authClientId, source: authSource, offlineName, flow: authFlow },
    java: { runtime: javaRuntime },
    window: { platform: windowPlatform },
  };

  return Object.freeze(config);
}

export function publicConfig(config) {
  return {
    name: config.name,
    version: config.version,
    server: { host: config.server.host, port: config.server.port },
    paths: {
      dataDir: config.paths.dataDir,
      instancesDir: config.paths.instancesDir,
      cacheDir: config.paths.cacheDir,
      logsDir: config.paths.logsDir,
      exportsDir: config.paths.exportsDir,
      webDir: config.paths.webDir,
    },
    log: { level: config.log.level },
    auth: {
      configured: Boolean(config.auth?.clientId),
      source: config.auth?.source ?? null,
      offlineName: config.auth?.offlineName ?? null,
      flow: config.auth?.flow ?? DEFAULT_AUTH_FLOW, // LIVE FLOW — ลบ key นี้พร้อม src/auth/live.js
    },
    java: { runtime: config.java?.runtime ?? null },
    window: { platform: config.window?.platform ?? DEFAULT_WINDOW_PLATFORM },
  };
}
