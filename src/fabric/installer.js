// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { CorruptDataError, ValidationError } from '../core/errors.js';
import { pathExists, readJson, writeJson } from '../core/filesystem.js';
import { mavenPath } from '../minecraft/install.js';
import { parseVersionJson } from '../minecraft/versions.js';
import { createFabricApi } from './api.js';

export const FABRIC_VERSION_ID_PREFIX = 'fabric-loader-';
export const FABRIC_MAVEN_BASE_URL = 'https://maven.fabricmc.net/';
export const TML_FABRIC_MARKER = 'tmlFabric';

export function fabricVersionId(meta) {
  const minecraftVersion = typeof meta?.minecraftVersion === 'string' ? meta.minecraftVersion : '';
  const fabricLoaderVersion = typeof meta?.fabricLoaderVersion === 'string' ? meta.fabricLoaderVersion : '';
  if (minecraftVersion === '' || fabricLoaderVersion === '') {
    throw new ValidationError('fabricVersionId requires minecraftVersion and fabricLoaderVersion', {
      code: 'INVALID_FABRIC_META',
      details: { minecraftVersion, fabricLoaderVersion },
    });
  }
  return `${FABRIC_VERSION_ID_PREFIX}${fabricLoaderVersion}-${minecraftVersion}`;
}

export function toMojangLibrary(entry) {
  const source = typeof entry === 'string' ? { name: entry } : entry;
  const name = source && typeof source === 'object' && typeof source.name === 'string' ? source.name.trim() : '';
  if (name === '') {
    throw new CorruptDataError('Fabric library entry is missing a maven coordinate', {
      code: 'FABRIC_LIBRARY_INVALID',
      details: { type: typeof entry },
    });
  }

  const libPath = mavenPath(name);
  const base = source && typeof source.url === 'string' && source.url !== '' ? source.url : FABRIC_MAVEN_BASE_URL;
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const artifact = { path: libPath, url: `${normalizedBase}${libPath}` };

  if (source && typeof source.sha1 === 'string' && source.sha1 !== '') {
    artifact.sha1 = source.sha1.toLowerCase();
  }
  if (source && typeof source.size === 'number' && source.size >= 0) {
    artifact.size = source.size;
  }

  return { name, downloads: { artifact } };
}

export function buildFabricVersion({ parent, profile }) {
  const parentRaw = parent && typeof parent === 'object' && parent.raw && typeof parent.raw === 'object'
    ? parent.raw
    : parent;
  if (!parentRaw || typeof parentRaw !== 'object' || typeof parentRaw.id !== 'string') {
    throw new ValidationError('buildFabricVersion requires parent version metadata', {
      code: 'INVALID_PARENT_VERSION',
    });
  }
  if (!profile || typeof profile !== 'object') {
    throw new ValidationError('buildFabricVersion requires a Fabric profile', {
      code: 'INVALID_FABRIC_PROFILE',
    });
  }

  const { gameVersion, loaderVersion, loader, intermediary, launcherMeta } = profile;
  const mainClass = launcherMeta?.mainClass?.client;
  const libraries = launcherMeta?.libraries;
  const valid = Boolean(
    typeof gameVersion === 'string'
    && gameVersion !== ''
    && typeof loaderVersion === 'string'
    && loaderVersion !== ''
    && loader
    && typeof loader.maven === 'string'
    && loader.maven !== ''
    && intermediary
    && typeof intermediary.maven === 'string'
    && intermediary.maven !== ''
    && typeof mainClass === 'string'
    && mainClass !== ''
    && Array.isArray(libraries?.common)
    && Array.isArray(libraries?.client),
  );
  if (!valid) {
    throw new CorruptDataError('Fabric profile has an unexpected shape', {
      code: 'FABRIC_PROFILE_INVALID',
      details: { gameVersion: typeof gameVersion === 'string' ? gameVersion : typeof gameVersion, loaderVersion: typeof loaderVersion === 'string' ? loaderVersion : typeof loaderVersion },
    });
  }

  const coordinateEntries = [
    { name: loader.maven, url: FABRIC_MAVEN_BASE_URL },
    { name: intermediary.maven, url: FABRIC_MAVEN_BASE_URL },
    ...libraries.common,
    ...libraries.client,
  ];
  const seen = new Set();
  const fabricLibraries = [];
  for (const entry of coordinateEntries) {
    const library = toMojangLibrary(entry);
    const libPath = library.downloads.artifact.path;
    if (seen.has(libPath)) continue;
    seen.add(libPath);
    fabricLibraries.push(library);
  }

  const parentLibraries = Array.isArray(parentRaw.libraries) ? parentRaw.libraries : [];
  const merged = {
    ...parentRaw,
    id: fabricVersionId({ minecraftVersion: gameVersion, fabricLoaderVersion: loaderVersion }),
    mainClass,
    libraries: [...parentLibraries, ...fabricLibraries],
    [TML_FABRIC_MARKER]: {
      minecraftVersion: gameVersion,
      fabricLoaderVersion: loaderVersion,
    },
  };

  parseVersionJson(merged);
  return merged;
}

function isFresh(parsed, meta) {
  const marker = parsed.raw?.[TML_FABRIC_MARKER];
  return Boolean(marker)
    && marker.minecraftVersion === meta.minecraftVersion
    && marker.fabricLoaderVersion === meta.fabricLoaderVersion
    && parsed.id === fabricVersionId(meta);
}

export function createFabricInstaller(options = {}) {
  const fabric = options.fabric ?? null;
  const minecraft = options.minecraft ?? null;
  const manager = options.manager ?? null;
  const logger = options.logger ?? null;
  const http = options.http ?? null;

  if (!minecraft || typeof minecraft.getVersion !== 'function') {
    throw new ValidationError('createFabricInstaller requires a Minecraft API', {
      code: 'INVALID_MINECRAFT_API',
    });
  }
  if (!manager || typeof manager.get !== 'function' || typeof manager.paths !== 'function') {
    throw new ValidationError('createFabricInstaller requires an instance manager', {
      code: 'INVALID_INSTANCE_MANAGER',
    });
  }
  if (fabric !== null && typeof fabric.getProfile !== 'function') {
    throw new ValidationError('createFabricInstaller requires a Fabric API with getProfile()', {
      code: 'INVALID_FABRIC_API',
    });
  }

  const fabricApi = fabric ?? createFabricApi(http ? { client: http } : {});

  function fileOf(instanceId) {
    return manager.paths(instanceId).fabricVersionFile;
  }

  async function readInstalled(instanceId) {
    const file = fileOf(instanceId);
    try {
      if (!(await pathExists(file))) return null;
      const data = await readJson(file);
      return parseVersionJson(data);
    } catch (err) {
      logger?.warn('fabric version file unreadable, reinstall required', {
        instanceId,
        file,
        code: err?.code ?? null,
        message: err?.message ?? String(err),
      });
      return null;
    }
  }

  async function install(instanceId, { force = false } = {}) {
    const meta = await manager.get(instanceId);

    if (!force) {
      const current = await readInstalled(instanceId);
      if (current && isFresh(current, meta)) {
        return {
          instanceId,
          file: fileOf(instanceId),
          id: current.id,
          mainClass: current.mainClass,
          installed: true,
          skipped: true,
        };
      }
    }

    const parentResult = await minecraft.getVersion(meta.minecraftVersion);
    const parent = parentResult && parentResult.version ? parentResult.version : parentResult;
    const profile = await fabricApi.getProfile(meta.minecraftVersion, meta.fabricLoaderVersion);
    const merged = buildFabricVersion({ parent, profile });
    const file = fileOf(instanceId);
    await writeJson(file, merged);

    logger?.info('fabric version installed', {
      instanceId,
      id: merged.id,
      minecraftVersion: meta.minecraftVersion,
      fabricLoaderVersion: meta.fabricLoaderVersion,
    });

    return {
      instanceId,
      file,
      id: merged.id,
      mainClass: merged.mainClass,
      installed: true,
      skipped: false,
    };
  }

  async function status(instanceId) {
    const meta = await manager.get(instanceId);
    const current = await readInstalled(instanceId);
    if (!current) {
      return { instanceId, id: null, installed: false, stale: false };
    }
    return { instanceId, id: current.id, installed: true, stale: !isFresh(current, meta) };
  }

  async function versionFor(instanceId) {
    const meta = await manager.get(instanceId);
    const current = await readInstalled(instanceId);
    return current && isFresh(current, meta) ? current : null;
  }

  return { install, status, versionFor };
}
