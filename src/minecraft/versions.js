// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import crypto from 'node:crypto';
import path from 'node:path';
import { CorruptDataError, NotFoundError, ValidationError } from '../core/errors.js';
import { readJson, resolveWithin, writeJson } from '../core/filesystem.js';
import { assertOk } from '../net/http.js';

export const VERSION_TYPES = Object.freeze(['release', 'snapshot', 'old_beta', 'old_alpha']);

const VERSION_ID_RE = /^[A-Za-z0-9 ._=-]+$/;
const SHA1_RE = /^[0-9a-f]{40}$/i;

function corrupt(message, details) {
  throw new CorruptDataError(message, { details });
}

export function safeVersionId(id) {
  if (typeof id !== 'string' || id === '') {
    throw new ValidationError('Version id must be a non-empty string', {
      code: 'INVALID_VERSION_ID',
      details: { id: typeof id === 'string' ? id : typeof id },
    });
  }
  if (id.length > 100 || !VERSION_ID_RE.test(id) || !/[A-Za-z0-9]/.test(id)) {
    throw new ValidationError(`Invalid version id: ${id}`, {
      code: 'INVALID_VERSION_ID',
      details: { id },
    });
  }
  return id;
}

export function versionCacheFile(cacheDir, id) {
  const safeId = safeVersionId(id);
  return resolveWithin(path.join(cacheDir, 'versions'), `${safeId}.json`);
}

function requireString(value, field, id) {
  if (typeof value !== 'string' || value === '') {
    corrupt(`Version "${id}" is missing "${field}"`, { field, id });
  }
  return value;
}

function requireSha1(value, field, id) {
  if (typeof value !== 'string' || !SHA1_RE.test(value)) {
    corrupt(`Version "${id}" has an invalid "${field}"`, { field, id });
  }
  return value.toLowerCase();
}

function requireDownload(value, field, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    corrupt(`Version "${id}" is missing "${field}"`, { field, id });
  }
  return {
    url: requireString(value.url, `${field}.url`, id),
    sha1: requireSha1(value.sha1, `${field}.sha1`, id),
    size: typeof value.size === 'number' && value.size >= 0
      ? value.size
      : (corrupt(`Version "${id}" has an invalid "${field}.size"`, { field, id })),
  };
}

export function parseVersionJson(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    corrupt('Version metadata must be a JSON object');
  }

  const id = requireString(data.id, 'id');
  const type = requireString(data.type, 'type', id);
  const mainClass = requireString(data.mainClass, 'mainClass', id);
  const assets = requireString(data.assets, 'assets', id);

  if (!data.assetIndex || typeof data.assetIndex !== 'object') {
    corrupt(`Version "${id}" is missing "assetIndex"`, { id });
  }
  const assetIndex = {
    id: requireString(data.assetIndex.id, 'assetIndex.id', id),
    sha1: requireSha1(data.assetIndex.sha1, 'assetIndex.sha1', id),
    size: typeof data.assetIndex.size === 'number' ? data.assetIndex.size : (corrupt(`Version "${id}" has an invalid "assetIndex.size"`, { id })),
    totalSize: typeof data.assetIndex.totalSize === 'number' ? data.assetIndex.totalSize : null,
    url: requireString(data.assetIndex.url, 'assetIndex.url', id),
  };

  if (!data.downloads || typeof data.downloads !== 'object') {
    corrupt(`Version "${id}" is missing "downloads"`, { id });
  }
  const downloads = {
    client: requireDownload(data.downloads.client, 'downloads.client', id),
    server: data.downloads.server
      ? requireDownload(data.downloads.server, 'downloads.server', id)
      : null,
  };

  if (!Array.isArray(data.libraries)) {
    corrupt(`Version "${id}" is missing a "libraries" array`, { id });
  }

  const hasGameArguments = data.arguments !== null && typeof data.arguments === 'object' && !Array.isArray(data.arguments);
  const hasLegacyArguments = typeof data.minecraftArguments === 'string';
  if (!hasGameArguments && !hasLegacyArguments) {
    corrupt(`Version "${id}" must define "arguments" or "minecraftArguments"`, { id });
  }

  let javaVersion = null;
  if (data.javaVersion !== undefined && data.javaVersion !== null) {
    if (typeof data.javaVersion !== 'object' || typeof data.javaVersion.majorVersion !== 'number') {
      corrupt(`Version "${id}" has an invalid "javaVersion"`, { id });
    }
    javaVersion = {
      component: typeof data.javaVersion.component === 'string' ? data.javaVersion.component : null,
      majorVersion: data.javaVersion.majorVersion,
    };
  }

  return {
    id,
    type,
    mainClass,
    assets,
    assetIndex,
    downloads,
    libraries: data.libraries,
    arguments: hasGameArguments ? data.arguments : null,
    minecraftArguments: hasLegacyArguments ? data.minecraftArguments : null,
    javaVersion,
    logging: data.logging && typeof data.logging === 'object' ? data.logging : null,
    releaseTime: typeof data.releaseTime === 'string' ? data.releaseTime : null,
    time: typeof data.time === 'string' ? data.time : null,
    complianceLevel: typeof data.complianceLevel === 'number' ? data.complianceLevel : null,
    minimumLauncherVersion: typeof data.minimumLauncherVersion === 'number' ? data.minimumLauncherVersion : null,
    raw: data,
  };
}

async function readCachedVersion(cacheFile) {
  const cached = await readJson(cacheFile, { optional: true });
  if (!cached) return null;
  try {
    return parseVersionJson(cached);
  } catch {
    return null;
  }
}

export async function loadVersion(entry, { client, validator, cacheFile, refresh, logger }) {
  validator(entry.url, { source: 'minecraft' });

  if (!refresh) {
    const cached = await readCachedVersion(cacheFile);
    if (cached && cached.id === entry.id) {
      return { version: cached, source: 'cache' };
    }
  }

  const res = await client.request(entry.url, { source: 'minecraft' });
  assertOk(res);

  const actualSha1 = crypto.createHash('sha1').update(res.body).digest('hex');
  if (actualSha1 !== entry.sha1) {
    throw new CorruptDataError(`Version metadata sha1 mismatch for "${entry.id}"`, {
      code: 'HASH_MISMATCH',
      details: { id: entry.id, expected: entry.sha1, actual: actualSha1 },
    });
  }

  let data;
  try {
    data = JSON.parse(res.body.toString('utf8'));
  } catch (err) {
    throw new CorruptDataError(`Version metadata for "${entry.id}" is not valid JSON`, {
      code: 'INVALID_JSON',
      cause: err,
      details: { id: entry.id },
    });
  }

  const version = parseVersionJson(data);
  if (version.id !== entry.id) {
    throw new CorruptDataError(`Version metadata id mismatch: manifest says "${entry.id}", file says "${version.id}"`, {
      code: 'ID_MISMATCH',
      details: { expected: entry.id, actual: version.id },
    });
  }

  await writeJson(cacheFile, data);
  logger?.debug('version metadata stored', { id: version.id, bytes: res.body.length });

  return { version, source: 'network' };
}
