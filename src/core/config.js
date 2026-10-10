// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fs from 'node:fs';
import os from 'node:os';
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

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.tml-launcher');
// pointer อยู่นอก data dir เอง — ย้าย data dir แล้วไฟล์นี้ยังชี้ตามไปด้วย (อ่านตอน start รอบถัดไป)
export const DATA_DIR_POINTER_FILE = path.join(os.homedir(), '.tml-launcher.json');

// อ่าน data dir ที่ตั้งไว้จาก UI — { dataDir, from } หรือ null
// from = กด MOVE แล้วยังไม่ restart → ย้ายข้อมูลจริงตอน start รอบถัดไป
export function readDataDirPointerEntry(pointerFile = DATA_DIR_POINTER_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
    if (!isPlainObject(raw)) return null;
    if (typeof raw.dataDir !== 'string' || raw.dataDir.trim() === '') return null;
    const dataDir = path.resolve(raw.dataDir.trim());
    const from =
      typeof raw.from === 'string' && raw.from.trim() !== '' ? path.resolve(raw.from.trim()) : null;
    return { dataDir, from };
  } catch {
    return null;
  }
}

// อ่าน data dir จาก pointer — คืน null เมื่อไม่มี/ไฟล์เสีย (อ่านแบบ fail-safe เสมอ)
export function readDataDirPointer(pointerFile = DATA_DIR_POINTER_FILE) {
  return readDataDirPointerEntry(pointerFile)?.dataDir ?? null;
}

export function writeDataDirPointer(toDir, { from = null, pointerFile = DATA_DIR_POINTER_FILE } = {}) {
  const payload = { dataDir: toDir };
  if (from !== null && from !== toDir) payload.from = from;
  fs.writeFileSync(pointerFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function copyOrMoveSync(src, dst) {
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// ย้ายทุกอย่างใน data dir เดิมไปที่ใหม่ (rename เดียวกับไดรฟ์ / copy+ลบ ข้ามไดรฟ์)
// แล้วเขียน pointer ให้เหลือแค่ dataDir — เขียน pointer ไม่ได้ต้องย้อนรอยย้ายกลับ กันข้อมูลอยู่สองที่
export function applyDataDirMoveSync(fromDir, toDir, { pointerFile = DATA_DIR_POINTER_FILE } = {}) {
  if (fs.existsSync(toDir) && fs.readdirSync(toDir).length > 0) {
    throw new Error(`target folder is not empty: ${toDir}`);
  }
  fs.mkdirSync(toDir, { recursive: true });
  const entries = fs.readdirSync(fromDir, { withFileTypes: true });
  const moved = [];
  try {
    for (const entry of entries) {
      const src = path.join(fromDir, entry.name);
      const dst = path.join(toDir, entry.name);
      copyOrMoveSync(src, dst);
      moved.push({ src, dst });
    }
    writeDataDirPointer(toDir, { pointerFile });
  } catch (err) {
    for (const entry of moved.reverse()) {
      try {
        copyOrMoveSync(entry.dst, entry.src);
      } catch {
        /* rollback ล้มเหลว — ข้อมูลยังอยู่ครบฝั่ง destination ไม่หาย */
      }
    }
    throw err;
  }
}

function hasDataDirEnv(env) {
  return typeof env.TML_DATA_DIR === 'string' && env.TML_DATA_DIR.trim() !== '';
}

// precedence: TML_DATA_DIR (env) > pointer (มี from = ย้ายข้อมูลตอน start นี้) > default ~/.tml-launcher
function resolveDataDir(env) {
  if (hasDataDirEnv(env)) return path.resolve(env.TML_DATA_DIR.trim());
  const entry = readDataDirPointerEntry();
  if (entry === null) return DEFAULT_DATA_DIR;
  if (entry.from !== null && entry.from !== entry.dataDir) {
    try {
      applyDataDirMoveSync(entry.from, entry.dataDir);
      return entry.dataDir;
    } catch {
      // ย้ายไม่ได้ตอน start → เขียน pointer กลับที่เดิม (best-effort) แล้วใช้ข้อมูลชุดเดิม
      try {
        writeDataDirPointer(entry.from);
      } catch {
        /* pointer เขียนไม่ได้ → start รอบถัดไปลองย้ายใหม่ */
      }
      return entry.from;
    }
  }
  return entry.dataDir;
}

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

export const OFFLINE_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

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

export function loadConfig({ env = process.env } = {}) {
  const dataDir = resolveDataDir(env);
  const configFile = path.join(dataDir, 'config.json');
  const file = readConfigFile(configFile);

  const fileServer = isPlainObject(file.server) ? file.server : {};
  const fileLog = isPlainObject(file.log) ? file.log : {};
  const fileAuth = isPlainObject(file.auth) ? file.auth : {};
  const fileJava = isPlainObject(file.java) ? file.java : {};

  const host = normalizeHost(env.TML_HOST ?? fileServer.host ?? DEFAULTS.host);
  const port = normalizePort(env.TML_PORT ?? fileServer.port ?? DEFAULTS.port);
  const level = normalizeLevel(env.TML_LOG_LEVEL ?? fileLog.level ?? DEFAULTS.logLevel);
  const javaRuntime = normalizeJavaRuntime(fileJava.runtime);
  const offlineName = normalizeOfflineName(fileAuth.offlineName);

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
    dataDirFromEnv: hasDataDirEnv(env),
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
    auth: { clientId: authClientId, source: authSource, offlineName },
    java: { runtime: javaRuntime },
  };

  return Object.freeze(config);
}

export function publicConfig(config) {
  // pointer ชี้ที่อื่นอยู่ = เปลี่ยน data dir แล้วยังไม่ได้ restart → โชว์ banner จนกว่าจะ restart
  // แต่ TML_DATA_DIR env เหนือกว่า pointer เสมอ → env คุมอยู่ก็ไม่มีอะไรต้องรอ
  const pendingDataDir =
    config.dataDirFromEnv === true ? null : readDataDirPointerEntry()?.dataDir ?? null;
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
    pendingDataDir: pendingDataDir !== null && pendingDataDir !== config.paths.dataDir ? pendingDataDir : null,
    log: { level: config.log.level },
    auth: {
      configured: Boolean(config.auth?.clientId),
      source: config.auth?.source ?? null,
      offlineName: config.auth?.offlineName ?? null,
    },
    java: { runtime: config.java?.runtime ?? null },
  };
}
