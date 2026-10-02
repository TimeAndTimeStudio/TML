// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import crypto from 'node:crypto';
import { InstanceError, ValidationError } from '../core/errors.js';
import { ensureDir, pathExists, removePath, writeFileAtomic, writeJson } from '../core/filesystem.js';
import { resolveInstancePaths } from './isolation.js';
import { validateInstanceMeta, validateInstanceId } from './validate.js';

export function generateInstanceId() {
  return crypto.randomBytes(4).toString('hex');
}

export async function createInstance(options = {}) {
  const instancesDir = options.instancesDir;
  if (typeof instancesDir !== 'string' || instancesDir === '') {
    throw new ValidationError('"instancesDir" must be a non-empty path', {
      code: 'INVALID_INSTANCES_DIR',
    });
  }

  const id = options.id ?? generateInstanceId();
  const meta = validateInstanceMeta({
    id,
    name: options.name,
    minecraftVersion: options.minecraftVersion,
    loader: options.loader === undefined ? 'fabric' : options.loader,
    fabricLoaderVersion: options.fabricLoaderVersion,
    java: options.java,
    memory: options.memory,
    extraJvmArgs: options.extraJvmArgs,
    extraGameArgs: options.extraGameArgs,
  });
  validateInstanceId(meta.id);

  const paths = resolveInstancePaths(instancesDir, meta.id);
  if (await pathExists(paths.dir)) {
    throw new InstanceError(`Instance already exists: ${meta.id}`, {
      code: 'INSTANCE_EXISTS',
      status: 409,
      details: { stage: 'create', id: meta.id },
    });
  }

  try {
    await ensureDir(paths.gameDir);
    for (const dir of paths.subdirs) await ensureDir(dir);
    await writeFileAtomic(paths.optionsFile, '');
    await writeJson(paths.metaFile, meta);
  } catch (err) {
    await removePath(paths.dir).catch(() => {});
    throw err;
  }

  return meta;
}
