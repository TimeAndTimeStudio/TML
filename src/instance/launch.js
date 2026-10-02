// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { InstanceError, ValidationError } from '../core/errors.js';

export async function resolveLaunchVersion(meta, options = {}) {
  if (!meta || typeof meta !== 'object' || typeof meta.minecraftVersion !== 'string' || meta.minecraftVersion === '') {
    throw new ValidationError('resolveLaunchVersion requires instance metadata', {
      code: 'INVALID_INSTANCE_META',
    });
  }

  const id = typeof meta.id === 'string' ? meta.id : '';
  const loaderVersion = typeof meta.fabricLoaderVersion === 'string' ? meta.fabricLoaderVersion : '';

  if (loaderVersion === '') {
    return Object.freeze({
      id: meta.minecraftVersion,
      version: meta.minecraftVersion,
      source: 'vanilla',
      cached: true,
    });
  }

  const fabric = options.fabric ?? null;
  if (!fabric || typeof fabric.versionFor !== 'function' || typeof fabric.install !== 'function') {
    throw new ValidationError('Launching a Fabric instance requires a Fabric installer', {
      code: 'NO_FABRIC',
      details: { id, fabricLoaderVersion: loaderVersion },
    });
  }

  const logger = options.logger ?? null;

  let version = await fabric.versionFor(id);
  if (version) {
    return Object.freeze({ id: version.id, version, source: 'fabric', cached: true });
  }

  logger?.info('installing fabric version for instance', { id, fabricLoaderVersion: loaderVersion });
  await fabric.install(id);
  version = await fabric.versionFor(id);
  if (!version) {
    throw new InstanceError(`Fabric version is unavailable for instance: ${id}`, {
      code: 'FABRIC_NOT_INSTALLED',
      details: { id, fabricLoaderVersion: loaderVersion },
    });
  }

  return Object.freeze({ id: version.id, version, source: 'fabric', cached: false });
}
