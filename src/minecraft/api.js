// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import path from 'node:path';
import { NotFoundError, ValidationError } from '../core/errors.js';
import { removePath } from '../core/filesystem.js';
import { httpClient } from '../net/http.js';
import { validateUrl } from '../security/urls.js';
import { loadManifest } from './manifest.js';
import { VERSION_TYPES, loadVersion, safeVersionId, versionCacheFile } from './versions.js';

export const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export const DEFAULT_MANIFEST_TTL_MS = 10 * 60 * 1000;

export function createMinecraftApi(options = {}) {
  const {
    config,
    logger = null,
    client = httpClient,
    validator = validateUrl,
    manifestUrl = VERSION_MANIFEST_URL,
    ttlMs = DEFAULT_MANIFEST_TTL_MS,
    now = () => Date.now(),
  } = options;

  if (!config || !config.paths || !config.paths.cacheDir) {
    throw new ValidationError('createMinecraftApi requires a config with paths.cacheDir');
  }

  const cacheDir = options.cacheDir ?? path.join(config.paths.cacheDir, 'minecraft');
  const manifestFile = path.join(cacheDir, 'version_manifest.json');
  let memory = null;

  async function getManifest({ refresh = false } = {}) {
    if (!refresh && memory && now() - memory.cachedAt < ttlMs) return memory;

    memory = await loadManifest({
      client,
      validator,
      url: manifestUrl,
      cacheFile: manifestFile,
      ttlMs,
      refresh,
      now,
      logger,
    });
    return memory;
  }

  async function listVersions({ type = 'all', limit = 0, refresh = false } = {}) {
    const normalizedType = String(type);
    if (normalizedType !== 'all' && !VERSION_TYPES.includes(normalizedType)) {
      throw new ValidationError(`Unknown version type: ${normalizedType}`, {
        code: 'UNKNOWN_VERSION_TYPE',
        details: { type: normalizedType, known: [...VERSION_TYPES] },
      });
    }

    const normalizedLimit = Number(limit);
    if (!Number.isInteger(normalizedLimit) || normalizedLimit < 0 || normalizedLimit > 5000) {
      throw new ValidationError('limit must be an integer between 0 and 5000', {
        details: { limit: String(limit) },
      });
    }

    const { manifest } = await getManifest({ refresh });
    let versions = manifest.versions;
    if (normalizedType !== 'all') {
      versions = versions.filter((entry) => entry.type === normalizedType);
    }
    if (normalizedLimit > 0) {
      versions = versions.slice(0, normalizedLimit);
    }
    return versions;
  }

  async function getVersion(id, { refresh = false } = {}) {
    const safeId = safeVersionId(id);
    const { manifest } = await getManifest();
    const entry = manifest.versions.find((candidate) => candidate.id === safeId);

    if (!entry) {
      throw new NotFoundError(`Minecraft version not found: ${safeId}`, {
        code: 'VERSION_NOT_FOUND',
        details: { id: safeId },
      });
    }

    return loadVersion(entry, {
      client,
      validator,
      cacheFile: versionCacheFile(cacheDir, safeId),
      refresh,
      logger,
    });
  }

  async function getLatest({ refresh = false } = {}) {
    const { manifest, source, cachedAt } = await getManifest({ refresh });
    return { latest: manifest.latest, source, cachedAt };
  }

  async function clearCache() {
    memory = null;
    await removePath(cacheDir);
  }

  return {
    getManifest,
    listVersions,
    getVersion,
    getLatest,
    clearCache,
    cacheDir,
    manifestUrl,
  };
}
