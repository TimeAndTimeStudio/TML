// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { SourceNotAllowedError, ValidationError } from '../core/errors.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export const OFFICIAL_SOURCES = Object.freeze({
  minecraft: Object.freeze({
    id: 'minecraft',
    label: 'Official Minecraft / Mojang',
    hosts: Object.freeze([
      // ใช้จริง: manifest/objects ของเกม + logging config (URL ได้จาก manifest 本身)
      'launchermeta.mojang.com',
      'piston-meta.mojang.com',
      'piston-data.mojang.com',
      'resources.download.minecraft.net',
      'libraries.minecraft.net',
      'launcher.mojang.com',
    ]),
  }),
  fabric: Object.freeze({
    id: 'fabric',
    label: 'Official Fabric',
    hosts: Object.freeze([
      'meta.fabricmc.net',
      'maven.fabricmc.net',
    ]),
  }),
  modrinth: Object.freeze({
    id: 'modrinth',
    label: 'Official Modrinth',
    hosts: Object.freeze(['api.modrinth.com', 'cdn.modrinth.com']),
  }),
  microsoft: Object.freeze({
    id: 'microsoft',
    label: 'Microsoft / Xbox (Official Authentication)',
    hosts: Object.freeze([
      'login.microsoftonline.com',
      'user.auth.xboxlive.com',
      'xsts.auth.xboxlive.com',
      'api.minecraftservices.com',
    ]),
  }),
});

export const ALL_OFFICIAL_HOSTS = Object.freeze([
  ...new Set(Object.values(OFFICIAL_SOURCES).flatMap((entry) => entry.hosts)),
]);

export function isKnownSource(source) {
  return typeof source === 'string' && Object.hasOwn(OFFICIAL_SOURCES, source);
}

export function listSources() {
  return Object.values(OFFICIAL_SOURCES).map((entry) => ({
    id: entry.id,
    label: entry.label,
    hosts: [...entry.hosts],
  }));
}

export function normalizeHost(host) {
  return String(host).toLowerCase().replace(/\.$/, '');
}

function hostsFor(source) {
  if (source === undefined || source === null) return null;
  if (!isKnownSource(source)) {
    throw new ValidationError(`Unknown official source: ${source}`, {
      code: 'UNKNOWN_SOURCE',
      details: { source: String(source), known: Object.keys(OFFICIAL_SOURCES) },
    });
  }
  return OFFICIAL_SOURCES[source].hosts;
}

export function isAllowedHost(host, source) {
  const normalized = normalizeHost(host);
  const hosts = hostsFor(source);
  if (hosts === null) return ALL_OFFICIAL_HOSTS.includes(normalized);
  return hosts.includes(normalized);
}

export function tryParseUrl(input) {
  if (input instanceof URL) return input;
  try {
    return new URL(String(input));
  } catch {
    return null;
  }
}

export function inferSource(input) {
  const url = tryParseUrl(input);
  if (!url) return null;
  const host = normalizeHost(url.hostname);
  for (const source of Object.values(OFFICIAL_SOURCES)) {
    if (source.hosts.includes(host)) return source.id;
  }
  return null;
}

export function validateUrl(input, { source } = {}) {
  if (typeof input !== 'string' && !(input instanceof URL)) {
    throw new ValidationError('URL must be a string or URL instance', { code: 'INVALID_URL' });
  }

  let url;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch (err) {
    throw new ValidationError('Invalid URL', { code: 'INVALID_URL', cause: err });
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SourceNotAllowedError(`Protocol not allowed: ${url.protocol}`, {
      details: { protocol: url.protocol, source: source ?? null },
    });
  }

  if (url.username !== '' || url.password !== '') {
    throw new SourceNotAllowedError('Credentials embedded in URL are not allowed', {
      details: { host: normalizeHost(url.hostname), source: source ?? null },
    });
  }

  if (url.port !== '') {
    throw new SourceNotAllowedError(`Port ${url.port} is not allowed, use the default port`, {
      details: { host: normalizeHost(url.hostname), port: url.port, source: source ?? null },
    });
  }

  const host = normalizeHost(url.hostname);
  if (!isAllowedHost(host, source)) {
    throw new SourceNotAllowedError(
      `Host not allowed${source ? ` for source "${source}"` : ''}: ${host}`,
      { details: { host, source: source ?? null } }
    );
  }

  return url;
}

export function isAllowedUrl(input, options = {}) {
  try {
    validateUrl(input, options);
    return true;
  } catch {
    return false;
  }
}
