// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { CorruptDataError, NotFoundError, ValidationError } from '../core/errors.js';
import { httpClient } from '../net/http.js';
import { validateUrl } from '../security/urls.js';
import { safeVersionId } from '../minecraft/versions.js';

export const FABRIC_META_BASE_URL = 'https://meta.fabricmc.net/v2';
export const FABRIC_GAME_VERSIONS_URL = `${FABRIC_META_BASE_URL}/versions/game`;
export const FABRIC_LOADER_VERSIONS_URL = `${FABRIC_META_BASE_URL}/versions/loader`;

function invalidMeta(list, message) {
  return new CorruptDataError(message, {
    code: 'FABRIC_META_INVALID',
    details: { list },
  });
}

function invalidProfile(gameVersion, loaderVersion, message) {
  return new CorruptDataError(message, {
    code: 'FABRIC_PROFILE_INVALID',
    details: { gameVersion, loaderVersion },
  });
}

export function createFabricApi(options = {}) {
  const client = options.client ?? httpClient;
  const validator = options.validator ?? validateUrl;

  if (!client || typeof client.getJson !== 'function') {
    throw new ValidationError('createFabricApi requires an HTTP client with getJson()', {
      code: 'INVALID_HTTP_CLIENT',
    });
  }

  async function getJson(url, { allowStatus = [] } = {}) {
    return client.getJson(url, { source: 'fabric', validator, allowStatus });
  }

  async function listGameVersions() {
    const { data } = await getJson(FABRIC_GAME_VERSIONS_URL);
    if (!Array.isArray(data)) {
      throw invalidMeta('game', 'Fabric game version list is not an array');
    }
    return data.map((entry) => {
      if (!entry || typeof entry.version !== 'string' || entry.version === '') {
        throw invalidMeta('game', 'Fabric game version list contains an invalid entry');
      }
      return { version: entry.version, stable: entry.stable === true };
    });
  }

  async function listLoaderVersions() {
    const { data } = await getJson(FABRIC_LOADER_VERSIONS_URL);
    if (!Array.isArray(data)) {
      throw invalidMeta('loader', 'Fabric loader version list is not an array');
    }
    return data.map((entry) => {
      if (!entry || typeof entry.version !== 'string' || entry.version === '') {
        throw invalidMeta('loader', 'Fabric loader version list contains an invalid entry');
      }
      return {
        version: entry.version,
        stable: entry.stable === true,
        maven: typeof entry.maven === 'string' && entry.maven !== '' ? entry.maven : null,
        build: typeof entry.build === 'number' ? entry.build : null,
      };
    });
  }

  async function getProfile(gameVersion, loaderVersion) {
    const game = safeVersionId(gameVersion);
    const loader = safeVersionId(loaderVersion);
    const url = `${FABRIC_LOADER_VERSIONS_URL}/${encodeURIComponent(game)}/${encodeURIComponent(loader)}`;
    const res = await getJson(url, { allowStatus: [404] });

    if (res.status === 404) {
      throw new NotFoundError(`Fabric profile not found: ${game} + ${loader}`, {
        code: 'FABRIC_PROFILE_NOT_FOUND',
        details: { gameVersion: game, loaderVersion: loader },
      });
    }

    const data = res.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw invalidProfile(game, loader, `Fabric profile for "${game}" is not a JSON object`);
    }

    const loaderMeta = data.loader;
    const intermediary = data.intermediary;
    const launcherMeta = data.launcherMeta && typeof data.launcherMeta === 'object' ? data.launcherMeta : null;
    const mainClass = launcherMeta?.mainClass ?? null;
    const libraries = launcherMeta?.libraries ?? null;

    const valid = Boolean(
      loaderMeta
      && typeof loaderMeta.maven === 'string'
      && loaderMeta.maven !== ''
      && typeof loaderMeta.version === 'string'
      && loaderMeta.version === loader
      && intermediary
      && typeof intermediary.maven === 'string'
      && intermediary.maven !== ''
      && launcherMeta
      && mainClass
      && typeof mainClass.client === 'string'
      && mainClass.client !== ''
      && libraries
      && Array.isArray(libraries.common)
      && Array.isArray(libraries.client),
    );
    if (!valid) {
      throw invalidProfile(game, loader, `Fabric profile for "${game}" has an unexpected shape`);
    }

    return Object.freeze({
      gameVersion: game,
      loaderVersion: loader,
      loader: Object.freeze({ ...loaderMeta }),
      intermediary: Object.freeze({ ...intermediary }),
      launcherMeta,
    });
  }

  return { listGameVersions, listLoaderVersions, getProfile };
}
