// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JavaRuntimeError, ValidationError } from '../core/errors.js';
import { assertLinuxPlatform } from '../core/platform.js';

export const JAVA_PROBE_TIMEOUT_MS = 5000;
export const MAX_SCAN_DEPTH = 5;
export const MAX_SCAN_NODES = 500;

const JAVA_RELATIVE = path.join('bin', 'java');
const COMPONENT_RE = /(jre-legacy|java-runtime-[a-z-]+|jre-x\d+|minecraft-java-exe)/;

const SCAN_SKIP_DIRS = new Set([
  'bin',
  'lib',
  'lib64',
  'legal',
  'license',
  'licenses',
  'man',
  'include',
  'conf',
  'demo',
  'sample',
  'src',
  'assets',
  'objects',
  'indexes',
  'libraries',
  'versions',
  'instances',
  'saves',
  'mods',
  'resourcepacks',
  'shaderpacks',
  'screenshots',
  'logs',
  'crash-reports',
  'natives',
  'node_modules',
  '.git',
]);

export function parseJavaVersion(output) {
  if (typeof output !== 'string' || output === '') return null;
  const text = output.replace(/\r/g, '');

  let raw = null;
  const quoted = text.match(/version\s+"([^"]+)"/i);
  if (quoted) raw = quoted[1];
  if (raw === null) {
    const bare =
      text.match(/\bopenjdk\s+([0-9][0-9._]*)/i) ?? text.match(/\bjava\s+version\s+([0-9][0-9._]*)/i);
    if (bare) raw = bare[1];
  }
  if (raw === null) return null;

  const parts = raw.split(/[._]/).map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || Number.isNaN(parts[0])) return null;

  const major = parts[0] === 1 ? (Number.isNaN(parts[1]) ? null : parts[1]) : parts[0];
  if (major === null || !Number.isInteger(major) || major < 1) return null;

  return { major, raw };
}

function homeDir(env) {
  return env.HOME ?? os.homedir();
}

export function defaultJavaRoots({ env = process.env, minecraftDir } = {}) {
  const official = [
    '/usr/share/minecraft-launcher/runtime',
    '/opt/minecraft-launcher/runtime',
    '/usr/lib/minecraft-launcher/runtime',
  ].map((root) => ({ path: root, source: 'official-launcher' }));

  const managedDirs = minecraftDir
    ? [minecraftDir]
    : [path.join(homeDir(env), '.minecraft'), path.join(homeDir(env), 'snap', 'minecraft', 'common', '.minecraft')];

  return [...official, ...managedDirs.map((dir) => ({ path: path.join(dir, 'runtime'), source: 'minecraft-managed' }))];
}

async function statOrNull(target) {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

async function collectCandidates(rootDir, { maxDepth = MAX_SCAN_DEPTH, maxNodes = MAX_SCAN_NODES } = {}) {
  const candidates = [];
  const visited = new Set();
  const queue = [{ dir: rootDir, depth: 0 }];
  let nodes = 0;

  while (queue.length > 0 && nodes < maxNodes) {
    const { dir, depth } = queue.shift();
    nodes += 1;

    let real;
    try {
      real = await fsp.realpath(dir);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);

    const candidate = path.join(dir, JAVA_RELATIVE);
    const stat = await statOrNull(candidate);
    if (stat?.isFile()) candidates.push(candidate);

    if (depth >= maxDepth) continue;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }

  return candidates;
}

function normalizeRoots(options, env) {
  if (options.roots !== undefined) {
    if (!Array.isArray(options.roots)) {
      throw new ValidationError('"roots" must be an array of paths', { code: 'INVALID_JAVA_ROOTS' });
    }
    return options.roots.map((entry) => {
      if (typeof entry === 'string') return { path: path.resolve(entry), source: 'custom' };
      if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
        return { path: path.resolve(entry.path), source: entry.source ?? 'custom' };
      }
      throw new ValidationError('"roots" entries must be paths or { path, source }', {
        code: 'INVALID_JAVA_ROOTS',
      });
    });
  }

  return defaultJavaRoots({ env, minecraftDir: options.minecraftDir });
}

function runVersionProbe(binary, execFileImpl, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      binary,
      ['-version'],
      { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        if (
          err &&
          (err.killed === true ||
            ['ENOENT', 'EACCES', 'ENOEXEC', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(err.code))
        ) {
          reject(err);
          return;
        }
        resolve(`${stdout ?? ''}${stderr ?? ''}`);
      },
    );
  });
}

async function probeCandidate(binary, { probe, execFileImpl, timeoutMs }) {
  try {
    let output;
    if (probe) {
      const value = await probe(binary);
      output = typeof value === 'string' ? value : (value?.output ?? '');
    } else {
      output = await runVersionProbe(binary, execFileImpl, timeoutMs);
    }
    const info = parseJavaVersion(output);
    return info ? { ok: true, info } : { ok: false, reason: 'invalid-version' };
  } catch (err) {
    return { ok: false, reason: 'probe-failed', message: err?.message ?? String(err) };
  }
}

async function validateExecutable(binary) {
  const stat = await statOrNull(binary);
  if (!stat || !stat.isFile()) return { ok: false, reason: 'not-a-file' };
  try {
    await fsp.access(binary, fsp.constants.X_OK);
  } catch {
    return { ok: false, reason: 'not-executable' };
  }
  return { ok: true };
}

function inferComponent(binary) {
  const match = binary.split(path.sep).join('/').match(COMPONENT_RE);
  return match ? match[1] : null;
}

function byComponentPreference(requiredComponent) {
  return (a, b) => {
    const aMatch = a.includes(requiredComponent) ? 0 : 1;
    const bMatch = b.includes(requiredComponent) ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    return a.length - b.length;
  };
}

export async function findMinecraftJava(options = {}) {
  assertLinuxPlatform(options.platform ?? process.platform);

  const env = options.env ?? process.env;
  const logger = options.logger ?? null;
  const probe = typeof options.probe === 'function' ? options.probe : null;
  const execFileImpl = options.execFile ?? execFile;
  const timeoutMs = options.timeoutMs ?? JAVA_PROBE_TIMEOUT_MS;
  const requiredMajor = options.requiredMajor ?? null;
  const requiredComponent = options.requiredComponent ?? null;

  if (requiredMajor !== null && (!Number.isInteger(requiredMajor) || requiredMajor < 1)) {
    throw new ValidationError('"requiredMajor" must be a positive integer', {
      code: 'INVALID_JAVA_MAJOR',
      details: { requiredMajor: String(requiredMajor) },
    });
  }

  const roots = normalizeRoots(options, env);
  const attempts = [];
  const seen = new Set();
  let versionMismatch = false;

  for (const root of roots) {
    const rootStat = await statOrNull(root.path);
    if (!rootStat?.isDirectory()) continue;

    const candidates = await collectCandidates(root.path);
    if (requiredComponent) candidates.sort(byComponentPreference(requiredComponent));

    for (const binary of candidates) {
      if (seen.has(binary)) continue;
      seen.add(binary);

      const executable = await validateExecutable(binary);
      if (!executable.ok) {
        attempts.push({ path: binary, reason: executable.reason });
        continue;
      }

      const probeResult = await probeCandidate(binary, { probe, execFileImpl, timeoutMs });
      if (!probeResult.ok) {
        attempts.push({
          path: binary,
          reason: probeResult.reason,
          ...(probeResult.message ? { message: probeResult.message } : {}),
        });
        continue;
      }

      const { info } = probeResult;
      if (requiredMajor !== null && info.major !== requiredMajor) {
        versionMismatch = true;
        attempts.push({ path: binary, reason: 'major-mismatch', major: info.major, root: root.path });
        continue;
      }

      const result = {
        path: binary,
        major: info.major,
        version: { major: info.major, raw: info.raw },
        source: root.source,
        root: root.path,
        component: inferComponent(binary),
      };
      logger?.info('minecraft java runtime found', {
        path: result.path,
        major: result.major,
        source: result.source,
        component: result.component,
      });
      return result;
    }
  }

  if (versionMismatch) {
    throw new JavaRuntimeError(`No Minecraft Java runtime matches major version ${requiredMajor}`, {
      code: 'JAVA_VERSION_MISMATCH',
      status: 409,
      details: { requiredMajor, roots: roots.map((root) => root.path), attempts },
    });
  }

  throw new JavaRuntimeError('Official Minecraft Java runtime not found', {
    details: { roots: roots.map((root) => root.path), attempts },
  });
}

export function createJavaDetector(options = {}) {
  const defaults = { ...options };
  return {
    options: defaults,
    findMinecraftJava: (overrides = {}) => findMinecraftJava({ ...defaults, ...overrides }),
  };
}
