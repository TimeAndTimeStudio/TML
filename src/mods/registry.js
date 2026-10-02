// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import path from 'node:path';
import { CorruptDataError, ValidationError } from '../core/errors.js';
import { pathExists, readJson, writeJson } from '../core/filesystem.js';

export const MOD_REGISTRY_FILE = 'mod-registry.json';

export function modRegistryPath(instanceDir) {
  if (typeof instanceDir !== 'string' || instanceDir === '') {
    throw new ValidationError('instanceDir must be a non-empty path', {
      code: 'INVALID_INSTANCE_DIR',
      details: { instanceDir: typeof instanceDir },
    });
  }
  return path.join(instanceDir, MOD_REGISTRY_FILE);
}

export async function readModRegistry(instanceDir) {
  const file = modRegistryPath(instanceDir);
  if (!(await pathExists(file))) return Object.freeze({});
  const raw = await readJson(file);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CorruptDataError(`Mod registry is not an object: ${file}`, {
      details: { file },
    });
  }
  return raw;
}

export async function recordInstalledMods(instanceDir, version, files) {
  if (!version || typeof version !== 'object') {
    throw new ValidationError('version must be a Modrinth version object', {
      code: 'INVALID_MOD_VERSION',
      details: { version: version === undefined ? 'undefined' : typeof version },
    });
  }
  const file = modRegistryPath(instanceDir);
  const current = (await readModRegistry(instanceDir).catch(() => ({}))) ?? {};
  const next = { ...current };
  for (const result of files) {
    if (typeof result?.filename !== 'string' || result.filename === '') continue;
    next[result.filename] = Object.freeze({
      projectId: version.projectId ?? null,
      versionId: version.id ?? null,
      versionNumber: version.versionNumber ?? null,
      url: typeof result.url === 'string' ? result.url : null,
      sha1: result.sha1 ?? null,
      sha512: result.sha512 ?? null,
      size: typeof result.size === 'number' ? result.size : result.bytes ?? null,
    });
  }
  await writeJson(file, next);
  return next;
}

export async function forgetInstalledMod(instanceDir, filename) {
  const file = modRegistryPath(instanceDir);
  if (!(await pathExists(file))) return null;
  let current;
  try {
    current = await readJson(file);
  } catch {
    return null;
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
  if (!Object.hasOwn(current, filename)) return null;
  delete current[filename];
  await writeJson(file, current);
  return current;
}
