// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { CorruptDataError, NotFoundError, ValidationError } from '../core/errors.js';
import { httpClient } from '../net/http.js';
import { validateUrl } from '../security/urls.js';

export const MODRINTH_API_BASE_URL = 'https://api.modrinth.com/v2';
export const MODRINTH_SEARCH_URL = `${MODRINTH_API_BASE_URL}/search`;
export const MODRINTH_TAG_GAME_VERSIONS_URL = `${MODRINTH_API_BASE_URL}/tag/game_version`;
export const MODRINTH_TAG_LOADERS_URL = `${MODRINTH_API_BASE_URL}/tag/loader`;

export const MODRINTH_DEPENDENCY_TYPES = Object.freeze(['required', 'optional', 'incompatible', 'embedded']);
export const MODRINTH_VERSION_TYPES = Object.freeze(['release', 'beta', 'alpha']);
export const MODRINTH_SEARCH_INDEXES = Object.freeze(['relevance', 'downloads', 'follows', 'updated', 'newest']);
export const MODRINTH_SEARCH_LIMIT_MAX = 100;
export const MODRINTH_SEARCH_OFFSET_MAX = 10000;

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA1_RE = /^[0-9a-f]{40}$/i;
const SHA512_RE = /^[0-9a-f]{128}$/i;

function responseInvalid(where, message, details = {}) {
  return new CorruptDataError(message, {
    code: 'MODRINTH_RESPONSE_INVALID',
    details: { where, ...details },
  });
}

function requireString(value, field, where) {
  if (typeof value !== 'string' || value === '') {
    throw responseInvalid(where, `Modrinth ${where} is missing "${field}"`, { field });
  }
  return value;
}

function optionalString(value) {
  return typeof value === 'string' ? value : '';
}

function requireNumber(value, field, where) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw responseInvalid(where, `Modrinth ${where} has an invalid "${field}"`, { field });
  }
  return value;
}

function requireStringArray(value, field, where) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw responseInvalid(where, `Modrinth ${where} has an invalid "${field}"`, { field });
  }
  return [...value];
}

function optionalStringArray(value, field, where) {
  if (value === undefined || value === null) return [];
  return requireStringArray(value, field, where);
}

function optionalNullableString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function normalizeFile(entry, where) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw responseInvalid(where, `Modrinth ${where} contains an invalid file entry`);
  }
  const filename = requireString(entry.filename, 'files[].filename', where);
  const url = requireString(entry.url, 'files[].url', where);
  try {
    validateUrl(url, { source: 'modrinth' });
  } catch {
    throw responseInvalid(where, `Modrinth file url is not an official host: ${url}`, { filename });
  }
  const size = requireNumber(entry.size, 'files[].size', where);
  const primary = entry.primary === true;

  const hashes = entry.hashes && typeof entry.hashes === 'object' && !Array.isArray(entry.hashes)
    ? entry.hashes
    : null;
  if (!hashes) {
    throw responseInvalid(where, `Modrinth file "${filename}" is missing hashes`, { filename });
  }

  let sha1 = null;
  if (hashes.sha1 !== undefined && hashes.sha1 !== null) {
    if (typeof hashes.sha1 !== 'string' || !SHA1_RE.test(hashes.sha1)) {
      throw responseInvalid(where, `Modrinth file "${filename}" has an invalid sha1`, { filename });
    }
    sha1 = hashes.sha1.toLowerCase();
  }
  let sha512 = null;
  if (hashes.sha512 !== undefined && hashes.sha512 !== null) {
    if (typeof hashes.sha512 !== 'string' || !SHA512_RE.test(hashes.sha512)) {
      throw responseInvalid(where, `Modrinth file "${filename}" has an invalid sha512`, { filename });
    }
    sha512 = hashes.sha512.toLowerCase();
  }
  if (sha1 === null && sha512 === null) {
    throw responseInvalid(where, `Modrinth file "${filename}" has no usable hash`, { filename });
  }

  return Object.freeze({ filename, url, primary, size, sha1, sha512 });
}

function normalizeDependency(entry, where) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw responseInvalid(where, `Modrinth ${where} contains an invalid dependency entry`);
  }
  const dependencyType = requireString(entry.dependency_type, 'dependencies[].dependency_type', where);
  if (!MODRINTH_DEPENDENCY_TYPES.includes(dependencyType)) {
    throw responseInvalid(where, `Modrinth ${where} has an unknown dependency_type`, { dependencyType });
  }
  return Object.freeze({
    projectId: requireString(entry.project_id, 'dependencies[].project_id', where),
    versionId: optionalNullableString(entry.version_id),
    fileName: optionalNullableString(entry.file_name),
    dependencyType,
  });
}

export function normalizeVersion(entry, where = 'version') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw responseInvalid(where, 'Modrinth version is not a JSON object');
  }
  const versionType = requireString(entry.version_type, 'version_type', where);
  if (!MODRINTH_VERSION_TYPES.includes(versionType)) {
    throw responseInvalid(where, 'Modrinth version has an unknown version_type', { versionType });
  }
  if (!Array.isArray(entry.files)) {
    throw responseInvalid(where, 'Modrinth version is missing a "files" array');
  }
  if (!Array.isArray(entry.dependencies)) {
    throw responseInvalid(where, 'Modrinth version is missing a "dependencies" array');
  }

  return Object.freeze({
    id: requireString(entry.id, 'id', where),
    projectId: requireString(entry.project_id, 'project_id', where),
    versionNumber: requireString(entry.version_number, 'version_number', where),
    name: optionalString(entry.name),
    changelog: optionalString(entry.changelog),
    gameVersions: requireStringArray(entry.game_versions, 'game_versions', where),
    loaders: requireStringArray(entry.loaders, 'loaders', where),
    versionType,
    status: optionalString(entry.status),
    datePublished: requireString(entry.date_published, 'date_published', where),
    downloads: requireNumber(entry.downloads, 'downloads', where),
    featured: entry.featured === true,
    files: Object.freeze(entry.files.map((file) => normalizeFile(file, where))),
    dependencies: Object.freeze(entry.dependencies.map((dep) => normalizeDependency(dep, where))),
  });
}

function normalizeHit(entry) {
  const where = 'search';
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw responseInvalid(where, 'Modrinth search contains an invalid hit');
  }
  return Object.freeze({
    projectId: requireString(entry.project_id, 'project_id', where),
    slug: requireString(entry.slug, 'slug', where),
    title: requireString(entry.title, 'title', where),
    description: optionalString(entry.description),
    author: optionalString(entry.author),
    projectType: optionalString(entry.project_type),
    categories: requireStringArray(entry.categories, 'categories', where),
    displayCategories: optionalStringArray(entry.display_categories, 'display_categories', where),
    downloads: requireNumber(entry.downloads, 'downloads', where),
    follows: requireNumber(entry.follows, 'follows', where),
    clientSide: optionalString(entry.client_side),
    serverSide: optionalString(entry.server_side),
    iconUrl: optionalString(entry.icon_url),
    color: typeof entry.color === 'number' ? entry.color : null,
    license: optionalString(entry.license),
    latestVersionId: optionalNullableString(entry.latest_version),
    gameVersions: requireStringArray(entry.versions, 'versions', where),
    dateCreated: optionalString(entry.date_created),
    dateModified: optionalString(entry.date_modified),
  });
}

function normalizeLicense(value, where = 'project') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw responseInvalid(where, `Modrinth ${where} has an invalid "license"`, { field: 'license' });
  }
  return Object.freeze({
    id: requireString(value.id, 'license.id', where),
    name: requireString(value.name, 'license.name', where),
    url: optionalNullableString(value.url),
  });
}

function normalizeDonationUrls(value, where) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw responseInvalid(where, `Modrinth ${where} has an invalid "donation_urls"`, { field: 'donation_urls' });
  }
  return Object.freeze(
    value.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw responseInvalid(where, `Modrinth ${where} contains an invalid donation entry`);
      }
      return Object.freeze({
        id: requireString(entry.id, 'donation_urls[].id', where),
        platform: requireString(entry.platform, 'donation_urls[].platform', where),
        url: requireString(entry.url, 'donation_urls[].url', where),
      });
    }),
  );
}

export function normalizeProject(entry) {
  const where = 'project';
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw responseInvalid(where, 'Modrinth project is not a JSON object');
  }
  return Object.freeze({
    id: requireString(entry.id, 'id', where),
    slug: requireString(entry.slug, 'slug', where),
    title: requireString(entry.title, 'title', where),
    description: requireString(entry.description, 'description', where),
    projectType: requireString(entry.project_type, 'project_type', where),
    body: optionalString(entry.body),
    downloads: requireNumber(entry.downloads, 'downloads', where),
    followers: requireNumber(entry.followers, 'followers', where),
    categories: requireStringArray(entry.categories, 'categories', where),
    additionalCategories: optionalStringArray(entry.additional_categories, 'additional_categories', where),
    gameVersions: requireStringArray(entry.game_versions, 'game_versions', where),
    loaders: requireStringArray(entry.loaders, 'loaders', where),
    clientSide: optionalString(entry.client_side),
    serverSide: optionalString(entry.server_side),
    license: normalizeLicense(entry.license),
    versions: requireStringArray(entry.versions, 'versions', where),
    iconUrl: optionalString(entry.icon_url),
    color: typeof entry.color === 'number' ? entry.color : null,
    datePublished: requireString(entry.published, 'published', where),
    dateModified: requireString(entry.updated, 'updated', where),
    status: optionalString(entry.status),
    issuesUrl: optionalNullableString(entry.issues_url),
    wikiUrl: optionalNullableString(entry.wiki_url),
    sourceUrl: optionalNullableString(entry.source_url),
    discordUrl: optionalNullableString(entry.discord_url),
    donationUrls: normalizeDonationUrls(entry.donation_urls, where),
  });
}

function safeProjectRef(value) {
  if (typeof value !== 'string' || value === '' || !PROJECT_ID_RE.test(value)) {
    throw new ValidationError('Project id or slug must be a safe identifier', {
      code: 'INVALID_MODRINTH_ID',
      details: { id: typeof value === 'string' ? value : typeof value },
    });
  }
  return value;
}

function validateFilterList(value, field) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new ValidationError(`${field} must be a non-empty array of strings`, {
      code: 'INVALID_MODRINTH_FILTER',
      details: { field },
    });
  }
  return value;
}

function validateFacets(facets) {
  if (facets === undefined || facets === null) return null;
  const valid = Array.isArray(facets)
    && facets.every(
      (group) => Array.isArray(group)
        && group.length > 0
        && group.every((entry) => typeof entry === 'string' && entry !== ''),
    );
  if (!valid) {
    throw new ValidationError('facets must be an array of non-empty string groups', {
      code: 'INVALID_SEARCH_FACETS',
    });
  }
  return facets;
}

function requireInt(value, field, { min, max, code }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be an integer between ${min} and ${max}`, {
      code,
      details: { field, value: typeof value === 'number' ? value : typeof value },
    });
  }
  return value;
}

export function createModrinthApi(options = {}) {
  const client = options.client ?? httpClient;
  const validator = options.validator ?? validateUrl;

  if (!client || typeof client.getJson !== 'function') {
    throw new ValidationError('createModrinthApi requires an HTTP client with getJson()', {
      code: 'INVALID_HTTP_CLIENT',
    });
  }

  async function getJson(url, { allowStatus = [] } = {}) {
    return client.getJson(url, { source: 'modrinth', validator, allowStatus });
  }

  async function search(query, options = {}) {
    if (typeof query !== 'string') {
      throw new ValidationError('search query must be a string', {
        code: 'INVALID_SEARCH_QUERY',
        details: { query: typeof query },
      });
    }
    const limit = requireInt(options.limit ?? 20, 'limit', {
      min: 1,
      max: MODRINTH_SEARCH_LIMIT_MAX,
      code: 'INVALID_SEARCH_LIMIT',
    });
    const offset = requireInt(options.offset ?? 0, 'offset', {
      min: 0,
      max: MODRINTH_SEARCH_OFFSET_MAX,
      code: 'INVALID_SEARCH_OFFSET',
    });
    const index = options.index ?? 'relevance';
    if (!MODRINTH_SEARCH_INDEXES.includes(index)) {
      throw new ValidationError(`Unknown search index: ${index}`, {
        code: 'INVALID_SEARCH_INDEX',
        details: { index, known: [...MODRINTH_SEARCH_INDEXES] },
      });
    }
    const facets = validateFacets(options.facets);

    const params = new URLSearchParams();
    params.set('query', query);
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    params.set('index', index);
    if (facets) params.set('facets', JSON.stringify(facets));

    const { data } = await getJson(`${MODRINTH_SEARCH_URL}?${params.toString()}`);
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.hits)) {
      throw responseInvalid('search', 'Modrinth search response is missing "hits"');
    }
    const totalHits = requireNumber(data.total_hits, 'total_hits', 'search');
    const responseOffset = requireNumber(data.offset, 'offset', 'search');
    const responseLimit = requireNumber(data.limit, 'limit', 'search');

    return Object.freeze({
      hits: Object.freeze(data.hits.map((hit) => normalizeHit(hit))),
      totalHits,
      offset: responseOffset,
      limit: responseLimit,
    });
  }

  async function getProject(idOrSlug) {
    const id = safeProjectRef(idOrSlug);
    const res = await getJson(`${MODRINTH_API_BASE_URL}/project/${encodeURIComponent(id)}`, {
      allowStatus: [404],
    });
    if (res.status === 404) {
      throw new NotFoundError(`Modrinth project not found: ${id}`, {
        code: 'MODRINTH_PROJECT_NOT_FOUND',
        details: { id },
      });
    }
    return normalizeProject(res.data);
  }

  async function listVersions(idOrSlug, filters = {}) {
    const id = safeProjectRef(idOrSlug);
    const gameVersions = validateFilterList(filters.gameVersions, 'gameVersions');
    const loaders = validateFilterList(filters.loaders, 'loaders');
    const limit = filters.limit === undefined
      ? null
      : requireInt(filters.limit, 'limit', { min: 1, max: MODRINTH_SEARCH_LIMIT_MAX, code: 'INVALID_SEARCH_LIMIT' });

    const params = new URLSearchParams();
    if (gameVersions) params.set('game_versions', JSON.stringify(gameVersions));
    if (loaders) params.set('loaders', JSON.stringify(loaders));
    if (limit !== null) params.set('limit', String(limit));
    const query = params.toString();
    const url = `${MODRINTH_API_BASE_URL}/project/${encodeURIComponent(id)}/version${query ? `?${query}` : ''}`;

    const res = await getJson(url, { allowStatus: [404] });
    if (res.status === 404) {
      throw new NotFoundError(`Modrinth project not found: ${id}`, {
        code: 'MODRINTH_PROJECT_NOT_FOUND',
        details: { id },
      });
    }
    if (!Array.isArray(res.data)) {
      throw responseInvalid('versions', 'Modrinth version list is not an array');
    }
    return Object.freeze(res.data.map((entry) => normalizeVersion(entry, 'version')));
  }

  async function getVersion(versionId) {
    const id = safeProjectRef(versionId);
    const res = await getJson(`${MODRINTH_API_BASE_URL}/version/${encodeURIComponent(id)}`, {
      allowStatus: [404],
    });
    if (res.status === 404) {
      throw new NotFoundError(`Modrinth version not found: ${id}`, {
        code: 'MODRINTH_VERSION_NOT_FOUND',
        details: { id },
      });
    }
    return normalizeVersion(res.data);
  }

  async function listGameVersionTags() {
    const { data } = await getJson(MODRINTH_TAG_GAME_VERSIONS_URL);
    if (!Array.isArray(data)) {
      throw responseInvalid('tags', 'Modrinth game version tag list is not an array');
    }
    return Object.freeze(
      data.map((entry) => {
        if (!entry || typeof entry !== 'object') {
          throw responseInvalid('tags', 'Modrinth game version tag is not an object');
        }
        return Object.freeze({
          version: requireString(entry.version, 'version', 'tags'),
          versionType: requireString(entry.version_type, 'version_type', 'tags'),
          date: optionalString(entry.date),
          major: entry.major === true,
        });
      }),
    );
  }

  async function listLoaderTags() {
    const { data } = await getJson(MODRINTH_TAG_LOADERS_URL);
    if (!Array.isArray(data)) {
      throw responseInvalid('tags', 'Modrinth loader tag list is not an array');
    }
    return Object.freeze(
      data.map((entry) => {
        if (!entry || typeof entry !== 'object') {
          throw responseInvalid('tags', 'Modrinth loader tag is not an object');
        }
        return Object.freeze({
          name: requireString(entry.name, 'name', 'tags'),
          supportedProjectTypes: optionalStringArray(entry.supported_project_types, 'supported_project_types', 'tags'),
        });
      }),
    );
  }

  return {
    search,
    getProject,
    listVersions,
    getVersion,
    listGameVersionTags,
    listLoaderTags,
  };
}
