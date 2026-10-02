// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';

import { CorruptDataError, NotFoundError, ValidationError } from '../../src/core/errors.js';
import {
  MODRINTH_DEPENDENCY_TYPES,
  MODRINTH_SEARCH_INDEXES,
  createModrinthApi,
} from '../../src/modrinth/api.js';

const PROJECT_ID = 'PRJ12345';
const VERSION_ID = 'VER12345';
const FILE_URL = `https://cdn.modrinth.com/data/${PROJECT_ID}/versions/${VERSION_ID}/fabric-api.jar`;
const SHA1 = 'a'.repeat(40);
const SHA512 = 'b'.repeat(128);

function makeFile(overrides = {}) {
  return {
    id: 'file0001',
    hashes: { sha1: SHA1, sha512: SHA512 },
    url: FILE_URL,
    filename: 'fabric-api.jar',
    primary: true,
    size: 1024,
    file_type: null,
    ...overrides,
  };
}

function makeVersion(overrides = {}) {
  return {
    id: VERSION_ID,
    project_id: PROJECT_ID,
    version_number: '1.0.0',
    name: 'Fabric API 1.0.0',
    changelog: 'notes',
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
    version_type: 'release',
    status: 'listed',
    date_published: '2026-01-01T00:00:00Z',
    downloads: 10,
    featured: false,
    files: [makeFile()],
    dependencies: [],
    ...overrides,
  };
}

function makeHit(overrides = {}) {
  return {
    project_id: PROJECT_ID,
    project_type: 'mod',
    slug: 'fabric-api',
    author: 'modmuss50',
    title: 'Fabric API',
    description: 'desc',
    categories: ['fabric', 'library'],
    display_categories: ['fabric'],
    downloads: 100,
    follows: 5,
    client_side: 'optional',
    server_side: 'optional',
    icon_url: `https://cdn.modrinth.com/data/${PROJECT_ID}/icon.png`,
    color: 123,
    license: 'Apache-2.0',
    latest_version: VERSION_ID,
    versions: ['1.20.1', '1.20.2'],
    date_created: '2024-01-01T00:00:00Z',
    date_modified: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeProject(overrides = {}) {
  return {
    id: PROJECT_ID,
    slug: 'fabric-api',
    title: 'Fabric API',
    description: 'desc',
    project_type: 'mod',
    body: '# readme',
    downloads: 100,
    followers: 5,
    categories: ['fabric'],
    additional_categories: ['library'],
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
    client_side: 'optional',
    server_side: 'optional',
    license: { id: 'Apache-2.0', name: 'Apache License 2.0', url: null },
    versions: [VERSION_ID],
    icon_url: `https://cdn.modrinth.com/data/${PROJECT_ID}/icon.png`,
    color: 123,
    published: '2024-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    status: 'approved',
    issues_url: 'https://github.com/FabricMC/fabric/issues',
    wiki_url: null,
    source_url: 'https://github.com/FabricMC/fabric',
    discord_url: null,
    donation_urls: [{ id: 'ko-fi', platform: 'Ko-fi', url: 'https://ko-fi.com/x' }],
    ...overrides,
  };
}

function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    async getJson(url, opts) {
      calls.push({ url, opts });
      return handler(url, opts);
    },
  };
}

function apiReturning(payload, status = 200) {
  const client = fakeClient(async () => ({ status, data: payload }));
  return { client, api: createModrinthApi({ client }) };
}

test('search builds query params, enforces options and normalizes hits', async () => {
  const client = fakeClient(async () => ({
    status: 200,
    data: {
      hits: [makeHit(), makeHit({ slug: 'second', latest_version: null, color: null, license: null })],
      total_hits: 42,
      offset: 10,
      limit: 5,
    },
  }));
  const api = createModrinthApi({ client });

  const result = await api.search('fabric api', {
    limit: 5,
    offset: 10,
    index: 'downloads',
    facets: [['versions:1.20.1'], ['categories:fabric']],
  });

  const request = new URL(client.calls[0].url);
  assert.equal(request.origin + request.pathname, 'https://api.modrinth.com/v2/search');
  assert.equal(request.searchParams.get('query'), 'fabric api');
  assert.equal(request.searchParams.get('limit'), '5');
  assert.equal(request.searchParams.get('offset'), '10');
  assert.equal(request.searchParams.get('index'), 'downloads');
  assert.deepEqual(JSON.parse(request.searchParams.get('facets')), [['versions:1.20.1'], ['categories:fabric']]);
  assert.equal(client.calls[0].opts.source, 'modrinth');

  assert.equal(result.totalHits, 42);
  assert.equal(result.offset, 10);
  assert.equal(result.limit, 5);
  assert.equal(result.hits.length, 2);
  const hit = result.hits[0];
  assert.equal(hit.projectId, PROJECT_ID);
  assert.equal(hit.slug, 'fabric-api');
  assert.equal(hit.title, 'Fabric API');
  assert.equal(hit.author, 'modmuss50');
  assert.equal(hit.projectType, 'mod');
  assert.equal(hit.downloads, 100);
  assert.equal(hit.follows, 5);
  assert.deepEqual(hit.categories, ['fabric', 'library']);
  assert.deepEqual(hit.gameVersions, ['1.20.1', '1.20.2']);
  assert.equal(hit.latestVersionId, VERSION_ID);
  assert.equal(result.hits[1].latestVersionId, null);
  assert.equal(result.hits[1].color, null);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.hits));
  assert.ok(Object.isFrozen(hit));

  await assert.rejects(api.search(123), { code: 'INVALID_SEARCH_QUERY' });
  await assert.rejects(api.search('x', { limit: 0 }), { code: 'INVALID_SEARCH_LIMIT' });
  await assert.rejects(api.search('x', { limit: 101 }), { code: 'INVALID_SEARCH_LIMIT' });
  await assert.rejects(api.search('x', { limit: 2.5 }), { code: 'INVALID_SEARCH_LIMIT' });
  await assert.rejects(api.search('x', { offset: -1 }), { code: 'INVALID_SEARCH_OFFSET' });
  await assert.rejects(api.search('x', { offset: 10001 }), { code: 'INVALID_SEARCH_OFFSET' });
  await assert.rejects(api.search('x', { index: 'nope' }), { code: 'INVALID_SEARCH_INDEX' });
  await assert.rejects(api.search('x', { facets: 'versions:1.20.1' }), { code: 'INVALID_SEARCH_FACETS' });
  await assert.rejects(api.search('x', { facets: [[]] }), { code: 'INVALID_SEARCH_FACETS' });
  await assert.rejects(api.search('x', { facets: [[1]] }), { code: 'INVALID_SEARCH_FACETS' });
  assert.equal(client.calls.length, 1, 'invalid options must not reach the network');
  assert.deepEqual(MODRINTH_SEARCH_INDEXES, ['relevance', 'downloads', 'follows', 'updated', 'newest']);
});

test('getProject normalizes project fields, license and donations', async () => {
  const client = fakeClient(async (url) => {
    assert.equal(url, `https://api.modrinth.com/v2/project/fabric-api`);
    return { status: 200, data: makeProject() };
  });
  const api = createModrinthApi({ client });

  const project = await api.getProject('fabric-api');

  assert.equal(client.calls[0].opts.source, 'modrinth');
  assert.ok(Object.isFrozen(project));
  assert.equal(project.id, PROJECT_ID);
  assert.equal(project.slug, 'fabric-api');
  assert.equal(project.title, 'Fabric API');
  assert.equal(project.projectType, 'mod');
  assert.equal(project.body, '# readme');
  assert.equal(project.downloads, 100);
  assert.deepEqual(project.loaders, ['fabric']);
  assert.deepEqual(project.gameVersions, ['1.20.1']);
  assert.deepEqual(project.versions, [VERSION_ID]);
  assert.deepEqual(project.license, { id: 'Apache-2.0', name: 'Apache License 2.0', url: null });
  assert.ok(Object.isFrozen(project.license));
  assert.equal(project.status, 'approved');
  assert.equal(project.issuesUrl, 'https://github.com/FabricMC/fabric/issues');
  assert.equal(project.wikiUrl, null);
  assert.equal(project.sourceUrl, 'https://github.com/FabricMC/fabric');
  assert.equal(project.discordUrl, null);
  assert.deepEqual(project.donationUrls, [{ id: 'ko-fi', platform: 'Ko-fi', url: 'https://ko-fi.com/x' }]);
  assert.ok(Object.isFrozen(project.donationUrls[0]));

  await assert.rejects(api.getProject('../evil'), { code: 'INVALID_MODRINTH_ID' });
  await assert.rejects(api.getProject(''), { code: 'INVALID_MODRINTH_ID' });
  assert.equal(client.calls.length, 1);
});

test('missing projects and versions map to 404 errors', async () => {
  const { api, client } = apiReturning(null, 404);

  await assert.rejects(api.getProject('does-not-exist'), {
    code: 'MODRINTH_PROJECT_NOT_FOUND',
    status: 404,
    details: { id: 'does-not-exist' },
  });
  await assert.rejects(api.listVersions('does-not-exist'), (err) => err instanceof NotFoundError && err.code === 'MODRINTH_PROJECT_NOT_FOUND');
  await assert.rejects(api.getVersion('NOPE1234'), { code: 'MODRINTH_VERSION_NOT_FOUND', status: 404 });
  assert.equal(client.calls.length, 3);
  for (const call of client.calls) assert.equal(call.opts.source, 'modrinth');
});

test('listVersions filters by game version and loader, normalizing files and dependencies', async () => {
  const client = fakeClient(async (url) => {
    const request = new URL(url);
    assert.equal(request.pathname, '/v2/project/fabric-api/version');
    return {
      status: 200,
      data: [
        makeVersion({
          dependencies: [
            { version_id: 'VER99999', project_id: 'PRJ99999', file_name: null, dependency_type: 'required' },
            { version_id: null, project_id: 'PRJ88888', file_name: 'dep.jar', dependency_type: 'optional' },
            { version_id: null, project_id: 'PRJ77777', file_name: null, dependency_type: 'incompatible' },
          ],
        }),
      ],
    };
  });
  const api = createModrinthApi({ client });

  const versions = await api.listVersions('fabric-api', {
    gameVersions: ['1.20.1'],
    loaders: ['fabric'],
    limit: 3,
  });

  const request = new URL(client.calls[0].url);
  assert.deepEqual(JSON.parse(request.searchParams.get('game_versions')), ['1.20.1']);
  assert.deepEqual(JSON.parse(request.searchParams.get('loaders')), ['fabric']);
  assert.equal(request.searchParams.get('limit'), '3');
  assert.equal(client.calls[0].opts.source, 'modrinth');

  assert.equal(versions.length, 1);
  assert.ok(Object.isFrozen(versions));
  const version = versions[0];
  assert.equal(version.id, VERSION_ID);
  assert.equal(version.projectId, PROJECT_ID);
  assert.equal(version.versionNumber, '1.0.0');
  assert.equal(version.name, 'Fabric API 1.0.0');
  assert.equal(version.changelog, 'notes');
  assert.equal(version.versionType, 'release');
  assert.equal(version.status, 'listed');
  assert.equal(version.datePublished, '2026-01-01T00:00:00Z');
  assert.equal(version.downloads, 10);
  assert.deepEqual(version.gameVersions, ['1.20.1']);
  assert.deepEqual(version.loaders, ['fabric']);
  assert.ok(Object.isFrozen(version));

  assert.equal(version.files.length, 1);
  const file = version.files[0];
  assert.deepEqual(file, {
    filename: 'fabric-api.jar',
    url: FILE_URL,
    primary: true,
    size: 1024,
    sha1: SHA1,
    sha512: SHA512,
  });
  assert.ok(Object.isFrozen(file));
  assert.ok(Object.isFrozen(version.files));

  assert.deepEqual(version.dependencies, [
    { projectId: 'PRJ99999', versionId: 'VER99999', fileName: null, dependencyType: 'required' },
    { projectId: 'PRJ88888', versionId: null, fileName: 'dep.jar', dependencyType: 'optional' },
    { projectId: 'PRJ77777', versionId: null, fileName: null, dependencyType: 'incompatible' },
  ]);
  assert.ok(Object.isFrozen(version.dependencies[0]));

  await assert.rejects(api.listVersions('fabric-api', { loaders: [] }), { code: 'INVALID_MODRINTH_FILTER' });
  await assert.rejects(api.listVersions('fabric-api', { gameVersions: '1.20.1' }), { code: 'INVALID_MODRINTH_FILTER' });
  await assert.rejects(api.listVersions('fabric-api', { limit: 0 }), { code: 'INVALID_SEARCH_LIMIT' });
  assert.equal(client.calls.length, 1, 'invalid filters must not reach the network');
});

test('getVersion returns one normalized version', async () => {
  const client = fakeClient(async (url) => {
    assert.equal(url, `https://api.modrinth.com/v2/version/${VERSION_ID}`);
    return { status: 200, data: makeVersion() };
  });
  const api = createModrinthApi({ client });

  const version = await api.getVersion(VERSION_ID);
  assert.equal(version.id, VERSION_ID);
  assert.equal(version.files[0].sha1, SHA1);
  assert.deepEqual(version.dependencies, []);
  assert.equal(client.calls[0].opts.source, 'modrinth');
});

test('corrupt responses are rejected with MODRINTH_RESPONSE_INVALID', async () => {
  const cases = [
    ['search', (api) => api.search('x'), { hits: [{ slug: 'no-id' }], total_hits: 1, offset: 0, limit: 20 }],
    ['search envelope', (api) => api.search('x'), { hits: [] }],
    ['search hit downloads', (api) => api.search('x'), { hits: [makeHit({ downloads: 'lots' })], total_hits: 1, offset: 0, limit: 20 }],
    ['project downloads', (api) => api.getProject('fabric-api'), makeProject({ downloads: 'lots' })],
    ['project donations', (api) => api.getProject('fabric-api'), makeProject({ donation_urls: ['ko-fi'] })],
    ['project license', (api) => api.getProject('fabric-api'), makeProject({ license: 'Apache-2.0' })],
    ['version list', (api) => api.listVersions('fabric-api'), { nope: true }],
    ['version type', (api) => api.getVersion(VERSION_ID), makeVersion({ version_type: 'weird' })],
    ['version files', (api) => api.getVersion(VERSION_ID), makeVersion({ files: 'nope' })],
    ['version dependencies', (api) => api.getVersion(VERSION_ID), makeVersion({ dependencies: null })],
    ['dependency type', (api) => api.getVersion(VERSION_ID), makeVersion({ dependencies: [{ version_id: null, project_id: 'PRJ1', file_name: null, dependency_type: 'maybe' }] })],
    ['file foreign host', (api) => api.getVersion(VERSION_ID), makeVersion({ files: [makeFile({ url: 'https://evil.example.com/mod.jar' })] })],
    ['file bad sha1', (api) => api.getVersion(VERSION_ID), makeVersion({ files: [makeFile({ hashes: { sha1: 'xyz' } })] })],
    ['file no hash', (api) => api.getVersion(VERSION_ID), makeVersion({ files: [makeFile({ hashes: {} })] })],
    ['tags', (api) => api.listLoaderTags(), { not: 'an array' }],
  ];

  for (const [label, run, payload] of cases) {
    const { api } = apiReturning(payload);
    await assert.rejects(run(api), (err) => {
      assert.ok(err instanceof CorruptDataError, `${label}: expected CorruptDataError, got ${err?.code}`);
      assert.equal(err.code, 'MODRINTH_RESPONSE_INVALID', label);
      return true;
    }, label);
  }

  const { api } = apiReturning(null);
  await assert.rejects(api.getProject('fabric-api'), (err) => err instanceof CorruptDataError && err.code === 'MODRINTH_RESPONSE_INVALID');
});

test('tag endpoints normalize game versions and loaders', async () => {
  const client = fakeClient(async (url) => {
    if (url === 'https://api.modrinth.com/v2/tag/game_version') {
      return {
        status: 200,
        data: [
          { version: '1.20.1', version_type: 'release', date: '2023-06-12T00:00:00Z', major: true },
          { version: '24w14a', version_type: 'snapshot', date: '2024-04-03T00:00:00Z', major: false },
        ],
      };
    }
    assert.equal(url, 'https://api.modrinth.com/v2/tag/loader');
    return {
      status: 200,
      data: [
        { icon: '<svg></svg>', name: 'fabric', supported_project_types: ['mod'] },
        { icon: '<svg></svg>', name: 'babric', supported_project_types: [] },
      ],
    };
  });
  const api = createModrinthApi({ client });

  const gameVersions = await api.listGameVersionTags();
  assert.equal(gameVersions.length, 2);
  assert.deepEqual(gameVersions[0], { version: '1.20.1', versionType: 'release', date: '2023-06-12T00:00:00Z', major: true });
  assert.equal(gameVersions[1].major, false);
  assert.ok(Object.isFrozen(gameVersions));

  const loaders = await api.listLoaderTags();
  assert.deepEqual(loaders[0], { name: 'fabric', supportedProjectTypes: ['mod'] });
  assert.deepEqual(loaders[1], { name: 'babric', supportedProjectTypes: [] });
  assert.ok(Object.isFrozen(loaders[0]));
  assert.equal(client.calls[0].opts.source, 'modrinth');
  assert.equal(client.calls[1].opts.source, 'modrinth');
});

test('createModrinthApi validates its collaborators and shared constants', () => {
  assert.throws(
    () => createModrinthApi({ client: {} }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_HTTP_CLIENT',
  );
  assert.ok(Object.isFrozen(MODRINTH_DEPENDENCY_TYPES));
  assert.deepEqual(MODRINTH_DEPENDENCY_TYPES, ['required', 'optional', 'incompatible', 'embedded']);
});

test('live: searches modrinth, loads project, versions, files, dependencies and tags', { skip: !process.env.TML_LIVE }, async () => {
  const api = createModrinthApi();

  const search = await api.search('fabric-api', { limit: 3 });
  assert.ok(search.totalHits >= search.hits.length);
  assert.ok(search.hits.length > 0);
  for (const hit of search.hits) {
    assert.ok(hit.projectId.length >= 8);
    assert.ok(hit.slug);
    assert.ok(typeof hit.downloads === 'number');
    assert.ok(Array.isArray(hit.gameVersions));
  }

  const facetSearch = await api.search('', { facets: [['versions:1.20.1'], ['categories:fabric']], limit: 2 });
  assert.ok(facetSearch.totalHits > 0);

  const project = await api.getProject('fabric-api');
  assert.equal(project.id, 'P7dR8mSH');
  assert.equal(project.slug, 'fabric-api');
  assert.equal(project.title, 'Fabric API');
  assert.ok(project.loaders.includes('fabric'));
  assert.ok(project.gameVersions.includes('1.20.1'));
  assert.ok(project.versions.length > 0);
  assert.ok(project.iconUrl.startsWith('https://cdn.modrinth.com/'));
  assert.ok(typeof project.downloads === 'number');

  const versions = await api.listVersions('fabric-api', { gameVersions: ['1.20.1'], loaders: ['fabric'], limit: 5 });
  assert.ok(versions.length > 0);
  for (const version of versions) {
    assert.ok(version.loaders.includes('fabric'));
    assert.ok(version.gameVersions.includes('1.20.1'));
    assert.ok(version.files.length > 0);
    for (const file of version.files) {
      assert.ok(file.url.startsWith('https://cdn.modrinth.com/'));
      assert.ok(file.sha1 === null || /^[0-9a-f]{40}$/.test(file.sha1));
      assert.ok(file.sha512 === null || /^[0-9a-f]{128}$/.test(file.sha512));
      assert.ok(file.sha1 !== null || file.sha512 !== null);
      assert.ok(file.size > 0);
    }
    assert.ok(Array.isArray(version.dependencies));
  }

  const single = await api.getVersion(versions[0].id);
  assert.equal(single.id, versions[0].id);
  assert.deepEqual(single.files.map((file) => file.sha1), versions[0].files.map((file) => file.sha1));

  const irisVersions = await api.listVersions('iris', { limit: 100 });
  const withDeps = irisVersions.find((version) => version.dependencies.length > 0);
  assert.ok(withDeps, 'expected at least one iris version with dependencies');
  for (const dep of withDeps.dependencies) {
    assert.ok(MODRINTH_DEPENDENCY_TYPES.includes(dep.dependencyType));
    assert.ok(dep.projectId);
    assert.ok(dep.versionId === null || typeof dep.versionId === 'string');
  }

  await assert.rejects(api.getProject('does-not-exist-xyz'), { code: 'MODRINTH_PROJECT_NOT_FOUND', status: 404 });

  const loaders = await api.listLoaderTags();
  assert.ok(loaders.some((tag) => tag.name === 'fabric'));
  const gameVersions = await api.listGameVersionTags();
  assert.ok(gameVersions.some((tag) => tag.version === '1.20.1'));
});
