// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { CorruptDataError } from '../core/errors.js';
import { readJson, writeJson } from '../core/filesystem.js';

const SHA1_RE = /^[0-9a-f]{40}$/i;

function corrupt(message, details) {
  throw new CorruptDataError(message, { details });
}

export function parseManifest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    corrupt('Version manifest must be a JSON object');
  }

  const latest = data.latest;
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)) {
    corrupt('Version manifest is missing "latest"');
  }
  if (typeof latest.release !== 'string' || latest.release === '') {
    corrupt('Version manifest "latest.release" must be a non-empty string');
  }
  if (typeof latest.snapshot !== 'string' || latest.snapshot === '') {
    corrupt('Version manifest "latest.snapshot" must be a non-empty string');
  }

  if (!Array.isArray(data.versions) || data.versions.length === 0) {
    corrupt('Version manifest must contain a non-empty "versions" array');
  }

  const seen = new Set();
  const versions = data.versions.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      corrupt('Every manifest version entry must be an object');
    }

    const { id, type, url, sha1, time, releaseTime, complianceLevel } = entry;

    if (typeof id !== 'string' || id === '') {
      corrupt('Manifest version entry is missing an "id"');
    }
    if (seen.has(id)) {
      corrupt(`Duplicate version id in manifest: ${id}`);
    }
    seen.add(id);

    if (typeof type !== 'string' || type === '') {
      corrupt(`Manifest version entry "${id}" is missing a "type"`);
    }
    if (typeof url !== 'string' || url === '') {
      corrupt(`Manifest version entry "${id}" is missing a metadata "url"`);
    }
    if (typeof sha1 !== 'string' || !SHA1_RE.test(sha1)) {
      corrupt(`Manifest version entry "${id}" has an invalid sha1`);
    }
    if (typeof releaseTime !== 'string' || Number.isNaN(Date.parse(releaseTime))) {
      corrupt(`Manifest version entry "${id}" has an invalid releaseTime`);
    }

    return {
      id,
      type,
      url,
      sha1: sha1.toLowerCase(),
      time: typeof time === 'string' ? time : releaseTime,
      releaseTime,
      complianceLevel: typeof complianceLevel === 'number' ? complianceLevel : null,
    };
  });

  return {
    latest: { release: latest.release, snapshot: latest.snapshot },
    versions,
  };
}

async function readManifestCache(cacheFile) {
  const cached = await readJson(cacheFile, { optional: true });
  if (!cached || typeof cached !== 'object') return null;
  if (typeof cached.cachedAt !== 'number') return null;

  try {
    return { cachedAt: cached.cachedAt, manifest: parseManifest(cached.manifest) };
  } catch {
    return null;
  }
}

export async function loadManifest({ client, validator, url, cacheFile, ttlMs, refresh, now, logger }) {
  const cached = await readManifestCache(cacheFile);

  if (!refresh && cached && now() - cached.cachedAt < ttlMs) {
    return { manifest: cached.manifest, source: 'cache', cachedAt: cached.cachedAt };
  }

  validator(url, { source: 'minecraft' });

  try {
    const res = await client.getJson(url, { source: 'minecraft' });
    const manifest = parseManifest(res.data);
    const cachedAt = now();
    await writeJson(cacheFile, { cachedAt, manifest });
    return { manifest, source: 'network', cachedAt };
  } catch (err) {
    if (cached) {
      logger?.warn('version manifest refresh failed, using cached copy', {
        err,
        url: new URL(url).hostname,
      });
      return { manifest: cached.manifest, source: 'stale-cache', cachedAt: cached.cachedAt };
    }
    throw err;
  }
}
