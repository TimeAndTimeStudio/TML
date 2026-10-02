// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { ValidationError } from '../../src/core/errors.js';
import { createApiRouter } from '../../src/server/routes.js';
import { createTmlServer } from '../../src/server/server.js';

function createFakeModrinth() {
  const calls = { search: [], listVersions: [], project: [] };
  return {
    calls,
    async search(query, options = {}) {
      calls.search.push({ query, options });
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
        throw new ValidationError('bad limit', { code: 'INVALID_SEARCH_LIMIT', details: { field: 'limit' } });
      }
      if (!Number.isInteger(options.offset) || options.offset < 0) {
        throw new ValidationError('bad offset', { code: 'INVALID_SEARCH_OFFSET', details: { field: 'offset' } });
      }
      const indexes = ['relevance', 'downloads', 'follows', 'updated', 'newest'];
      if (options.index !== undefined && !indexes.includes(options.index)) {
        throw new ValidationError('bad index', { code: 'INVALID_SEARCH_INDEX', details: { field: 'index' } });
      }
      return {
        hits: [
          {
            projectId: 'P1',
            slug: 'sodium',
            title: 'Sodium',
            description: 'Rendering engine',
            author: 'jellysquid',
            downloads: 100000,
            iconUrl: 'https://cdn.modrinth.com/icon.png',
            categories: ['optimization'],
            gameVersions: ['1.20.1'],
            latestVersionId: 'v1',
          },
        ],
        totalHits: 1,
        offset: options.offset,
        limit: options.limit,
      };
    },
    async getProject(idOrSlug) {
      calls.project.push(idOrSlug);
      return {
        projectId: 'P1',
        slug: idOrSlug,
        title: 'Sodium',
        description: 'Rendering engine',
        downloads: 100000,
        iconUrl: 'https://cdn.modrinth.com/icon.png',
        categories: ['optimization'],
        gameVersions: ['1.20.1'],
        loaders: ['fabric'],
      };
    },
    async listVersions(idOrSlug, filters = {}) {
      calls.listVersions.push({ idOrSlug, filters });
      return [
        {
          id: 'v1',
          projectId: 'P1',
          versionNumber: '0.5.8',
          name: 'Sodium 0.5.8',
          versionType: 'release',
          gameVersions: ['1.20.1'],
          loaders: ['fabric'],
          datePublished: '2024-01-01T00:00:00Z',
          downloads: 50000,
          files: [{ filename: 'sodium.jar', size: 1234, primary: true, url: 'https://cdn.modrinth.com/x.jar' }],
          dependencies: [],
        },
      ];
    },
  };
}

const fakeFabric = {
  calls: 0,
  async listLoaderVersions() {
    this.calls += 1;
    return [
      { version: '0.15.7', stable: true, maven: 'net.fabricmc:fabric-loader:0.15.7', build: 1 },
      { version: '0.16.0', stable: false, maven: null, build: null },
    ];
  },
};

let server;
let port;
let dataDir;
let modrinth;

function request(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { accept: 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-catalog-'));
  const config = loadConfig({ env: { TML_DATA_DIR: dataDir, TML_PORT: '0', TML_LOG_LEVEL: 'silent' } });
  const logger = createLogger({ level: 'silent' });

  modrinth = createFakeModrinth();
  const router = createApiRouter({ config, logger, modrinth, fabric: fakeFabric });
  server = createTmlServer({ config, logger, router });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('search maps hits and applies default paging', async () => {
  const res = await request('/api/modrinth/search?q=sodium');
  assert.equal(res.status, 200);
  assert.equal(res.json.query, 'sodium');
  assert.equal(res.json.total, 1);
  assert.equal(res.json.count, 1);

  const { options } = modrinth.calls.search.at(-1);
  assert.equal(options.limit, 12, 'default limit must come from the route');
  assert.equal(options.offset, 0);

  const hit = res.json.hits[0];
  assert.deepEqual(Object.keys(hit).sort(), [
    'author',
    'categories',
    'description',
    'downloads',
    'gameVersions',
    'iconUrl',
    'latestVersionId',
    'projectId',
    'slug',
    'title',
  ]);
  assert.equal(hit.title, 'Sodium');
});

test('search passes explicit paging and forwards validation errors', async () => {
  const ok = await request('/api/modrinth/search?q=sodium&limit=5&offset=10');
  assert.equal(ok.status, 200);
  assert.deepEqual(
    { ...modrinth.calls.search.at(-1).options },
    { limit: 5, offset: 10, index: 'relevance' },
  );

  const bad = await request('/api/modrinth/search?q=sodium&limit=abc');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_SEARCH_LIMIT');
});

test('search maps the type parameter to a project_type facet and rejects unknown types', async () => {
  const shader = await request('/api/modrinth/search?q=light&type=shader');
  assert.equal(shader.status, 200);
  assert.equal(shader.json.type, 'shader');
  assert.deepEqual(modrinth.calls.search.at(-1).options.facets, [['project_type:shader']]);

  const resourcePack = await request('/api/modrinth/search?q=faithful&type=resourcepack');
  assert.equal(resourcePack.status, 200);
  assert.deepEqual(modrinth.calls.search.at(-1).options.facets, [['project_type:resourcepack']]);

  const plain = await request('/api/modrinth/search?q=sodium');
  assert.equal(plain.status, 200);
  assert.equal(plain.json.type, null);
  assert.equal('facets' in modrinth.calls.search.at(-1).options, false, 'no facet is sent without a type');

  const bad = await request('/api/modrinth/search?q=x&type=plugin');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_SEARCH_TYPE');
  assert.deepEqual(bad.json.error.details.known, ['mod', 'resourcepack', 'shader']);
});

test('search defaults to popular downloads for an empty query and forwards index', async () => {
  const popular = await request('/api/modrinth/search?q=');
  assert.equal(popular.status, 200);
  assert.equal(modrinth.calls.search.at(-1).options.index, 'downloads', 'empty query → popular by downloads');

  const explicit = await request('/api/modrinth/search?q=sodium&index=follows');
  assert.equal(explicit.status, 200);
  assert.equal(modrinth.calls.search.at(-1).options.index, 'follows');

  const bad = await request('/api/modrinth/search?q=sodium&index=bogus');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_SEARCH_INDEX');
});

test('project endpoint maps a public project shape', async () => {
  const res = await request('/api/modrinth/project/sodium');
  assert.equal(res.status, 200);
  assert.equal(modrinth.calls.project.at(-1), 'sodium');
  assert.equal(res.json.project.title, 'Sodium');
  assert.equal(res.json.project.projectId, 'P1');
  assert.deepEqual(res.json.project.loaders, ['fabric']);
});

test('versions endpoint forwards game and loader filters and maps files', async () => {
  const res = await request('/api/modrinth/project/P1/versions?game=1.20.1&loader=fabric');
  assert.equal(res.status, 200);
  assert.deepEqual({ ...modrinth.calls.listVersions.at(-1).filters }, {
    limit: 20,
    gameVersions: ['1.20.1'],
    loaders: ['fabric'],
  });

  const version = res.json.versions[0];
  assert.equal(version.id, 'v1');
  assert.equal(version.versionNumber, '0.5.8');
  assert.deepEqual(version.files, [{ filename: 'sodium.jar', size: 1234, primary: true }]);
  assert.equal('url' in version.files[0], false, 'raw download urls stay server-side');
});

test('fabric loader endpoint maps the meta list', async () => {
  fakeFabric.calls = 0;
  const res = await request('/api/fabric/loaders');
  assert.equal(res.status, 200);
  assert.equal(fakeFabric.calls, 1);
  assert.equal(res.json.count, 2);
  assert.deepEqual(res.json.loaders[0], { version: '0.15.7', stable: true });
  assert.deepEqual(res.json.loaders[1], { version: '0.16.0', stable: false });
});
