// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AuthError, JavaRuntimeError, NotFoundError, ValidationError } from '../core/errors.js';
import { ensureDir, pathExists, readJson, removePath, writeJson } from '../core/filesystem.js';
import { createRouter } from './router.js';
import {
  publicConfig,
  VERSION,
  OFFLINE_NAME_PATTERN,
  AUTH_FLOW_VALUES, // LIVE FLOW — ลบพร้อม src/auth/live.js
  DEFAULT_AUTH_FLOW, // LIVE FLOW
  WINDOW_PLATFORM_VALUES,
  DEFAULT_WINDOW_PLATFORM,
} from '../core/config.js';
import { listSources } from '../security/urls.js';
import { validateRuntimeName } from '../java/runtimes.js';
import { createMinecraftApi } from '../minecraft/api.js';
import { createSkinService, SKIN_DEFAULT_VARIANT } from '../minecraft/skin.js';

const startedAt = Date.now();

const IMPORT_UPLOAD_LIMIT_BYTES = 256 * 1024 * 1024;
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;
const STAGED_TOKEN_RE = /^[a-f0-9]{32}$/;
const AUTH_WAIT_TIMEOUT_MS = 4 * 60 * 1000;
const AUTH_DEVICE_MAX = 32;
const SEARCH_DEFAULT_LIMIT = 12;
const VERSIONS_DEFAULT_LIMIT = 20;
const LOG_LEVEL_VALUES = ['debug', 'info', 'warn', 'error', 'silent'];
const LOG_LEVEL_SET = new Set(LOG_LEVEL_VALUES);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wantsRefresh(query) {
  const value = query.get('refresh');
  return value === '1' || value === 'true';
}

async function sweepStaging(stagingDir, logger) {
  let names;
  try {
    names = await fsp.readdir(stagingDir);
  } catch (err) {
    if (err?.code !== 'ENOENT') logger?.warn('import staging unreadable', { code: err?.code ?? null });
    return;
  }
  for (const name of names) {
    const file = path.join(stagingDir, name);
    try {
      const stat = await fsp.stat(file);
      if (stat.isFile() && Date.now() - stat.mtimeMs > STAGING_MAX_AGE_MS) {
        await removePath(file);
      }
    } catch {
      continue;
    }
  }
}

async function streamUpload(req, dest, limitBytes) {
  let total = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > limitBytes) {
        callback(new ValidationError('Import upload is too large', {
          code: 'IMPORT_TOO_LARGE',
          details: { limitBytes },
        }));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(req, limiter, fs.createWriteStream(dest, { mode: 0o600 }));
  } catch (err) {
    await removePath(dest).catch(() => {});
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('Import upload failed', { code: 'IMPORT_UPLOAD_FAILED', cause: err });
  }
}

function registerAuthRoutes(router, config, logger, auth, store, getConfig = () => config) {
  const deviceLogins = new Map();

  // LIVE FLOW — ตัดสินใจว่าใช้ AAD (แอปของตัวเอง) หรือ live (login.live.com) — ลบพร้อม src/auth/live.js
  function liveFlowSelected() {
    return getConfig().auth?.flow === 'live';
  }

  function rememberStart(start) {
    if (deviceLogins.size >= AUTH_DEVICE_MAX) {
      deviceLogins.delete(deviceLogins.keys().next().value);
    }
    deviceLogins.set(start.deviceCode, start);
  }

  router.post('/api/auth/device', async () => {
    // LIVE FLOW — flow 'live' ใช้ login.live.com + title ID (ไม่ต้องรอ review) — ลบพร้อม src/auth/live.js
    const flow = liveFlowSelected() ? 'live' : 'aad';
    const client = flow === 'live' ? auth.live : auth.requireClient();
    const start = await client.startDeviceLogin();
    rememberStart({ ...start, flow });
    return {
      body: {
        deviceCode: start.deviceCode,
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        verificationUriComplete: start.verificationUriComplete,
        interval: start.interval,
        expiresIn: start.expiresIn,
        expiresAt: start.expiresAt,
        message: start.message,
      },
    };
  });

  router.post('/api/auth/login', async ({ body }) => {
    const deviceCode = typeof body?.deviceCode === 'string' ? body.deviceCode : '';
    if (deviceCode === '') {
      throw new ValidationError('Field "deviceCode" must be a non-empty string', {
        details: { field: 'deviceCode' },
      });
    }

    const start = deviceLogins.get(deviceCode);
    if (!start) {
      throw new NotFoundError('Unknown or expired device login, start again', {
        code: 'AUTH_DEVICE_UNKNOWN',
        status: 404,
        details: { stage: 'device' },
      });
    }
    if (Number.isFinite(start.expiresAt) && Date.now() >= start.expiresAt) {
      deviceLogins.delete(deviceCode);
      throw new AuthError('The device login code has expired', {
        code: 'AUTH_DEVICE_EXPIRED',
        status: 400,
        details: { stage: 'device' },
      });
    }

    // LIVE FLOW — เลือก client ตาม flow ที่ผูกไว้ตอนขอ device code — ลบพร้อม src/auth/live.js
    const client = start.flow === 'live' ? auth.live : auth.requireClient();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_WAIT_TIMEOUT_MS);
    timer.unref?.();
    try {
      const session = await client.completeDeviceLogin(start, { signal: controller.signal });
      deviceLogins.delete(deviceCode);
      const saved = await store.save(session);
      logger.info('microsoft sign-in complete', { username: saved.username, uuid: saved.uuid });
      return { body: { session: saved } };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new AuthError('Still waiting for sign-in, retry with the same device code', {
          code: 'AUTH_WAIT_TIMEOUT',
          status: 400,
          details: { stage: 'device' },
        });
      }
      if (err?.code === 'AUTH_DECLINED' || err?.code === 'AUTH_DEVICE_EXPIRED') {
        deviceLogins.delete(deviceCode);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  });

  router.get('/api/auth/session', async () => {
    const clientConfigured = auth.isConfigured();
    const session = await store.read();
    if (!session) return { body: { signedIn: false, clientConfigured } };
    return {
      body: {
        ...store.publicSession(session),
        clientConfigured,
        expired: clientConfigured ? auth.requireClient().isExpired(session) : false,
      },
    };
  });

  router.post('/api/auth/refresh', async () => {
    const session = await store.read();
    if (!session) {
      throw new AuthError('No account is signed in', { code: 'AUTH_NO_SESSION', status: 401 });
    }
    // LIVE FLOW — session จาก live flow ต้อง refresh ผ่าน login.live.com — ลบพร้อม src/auth/live.js
    const client = session.flow === 'live' ? auth.live : auth.requireClient();
    try {
      const fresh = await client.refreshSession(session);
      const saved = await store.save(fresh);
      return { body: { session: saved } };
    } catch (err) {
      if (err?.status === 401) await store.clear().catch(() => {});
      throw err;
    }
  });

  router.delete('/api/auth/session', async () => {
    await store.clear();
    return { body: { signedIn: false } };
  });
}

// เปลี่ยน skin ผ่าน Minecraft Services API — ใช้ accessToken ของ session ที่ล็อกอินไว้ (หมดอายุ → refresh ให้ก่อน)
function registerSkinRoutes(router, config, logger, auth, account, skin) {
  async function accessToken() {
    const stored = await account.read();
    if (!stored) {
      throw new AuthError('Sign in with a Microsoft account to change your skin', {
        code: 'AUTH_NO_SESSION',
        status: 401,
        details: { stage: 'config' },
      });
    }
    // LIVE FLOW — session จาก live flow refresh ผ่าน live client — ลบพร้อม src/auth/live.js
    const client = stored.flow === 'live' && auth.live ? auth.live : auth.requireClient();
    if (client.isExpired(stored)) {
      const fresh = await client.refreshSession(stored);
      await account.save(fresh);
      return fresh.accessToken;
    }
    return stored.accessToken;
  }

  router.post('/api/minecraft/skin', async ({ body }) => {
    const payload = isPlainObject(body) ? body : {};
    if (typeof payload.data !== 'string' || payload.data === '') {
      throw new ValidationError('Field "data" must be a base64-encoded PNG skin image', {
        code: 'INVALID_SKIN',
        details: { field: 'data' },
      });
    }
    const variant =
      payload.variant === undefined || payload.variant === null
        ? SKIN_DEFAULT_VARIANT
        : payload.variant;
    const token = await accessToken();
    await skin.upload({
      token,
      data: Buffer.from(payload.data, 'base64'),
      variant,
      filename: typeof payload.filename === 'string' ? payload.filename : 'skin.png',
    });
    logger.info('skin changed', { variant });
    return { body: { changed: true, variant } };
  });

  router.delete('/api/minecraft/skin', async () => {
    const token = await accessToken();
    await skin.reset({ token });
    logger.info('skin reset to default', {});
    return { body: { changed: true } };
  });

  // skin ที่ใช้อยู่ตอนนี้ (สำหรับหน้าต่างสกิน — แสดงของที่ใช้อยู่ + เปลี่ยนได้)
  router.get('/api/minecraft/skin', async () => {
    const token = await accessToken();
    const profile = await skin.active({ token });
    return { body: profile };
  });

  // รูปสกินสำหรับ preview — อ่านจาก cache บนเครื่องเท่านั้น (ไฟล์ที่เกมเขียน + ไฟล์ที่อัปโหลดไว้) ไม่ยิงออกไปโหลดจากเน็ต
  router.get('/api/minecraft/skin/image', async ({ query }) => {
    const hash = String(query.get('hash') ?? '');
    if (hash !== '' && !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(hash)) {
      throw new ValidationError('A skin hash must be 40 or 64 lowercase hex characters', {
        code: 'INVALID_SKIN_HASH',
        details: { field: 'hash' },
      });
    }
    await accessToken(); // ต้อง sign in (ตรวจจาก session ฝั่ง server — รูปโหลดผ่าน URL จึงไม่ต้องส่ง token ทาง client)
    const texture = await skin.texture({ hash: hash === '' ? null : hash });
    return {
      body: {
        hash: texture.hash,
        source: texture.source,
        dataUrl: `data:image/png;base64,${texture.data.toString('base64')}`,
      },
    };
  });
}

function registerInstanceRoutes(router, config, logger, instance, session = null, getConfig = () => config, java = null) {
  const { manager, exporter = null, importer = null, installer = null } = instance;
  const stagingDir = path.join(config.paths.tmpDir, 'import-staging');

  async function launchAuth() {
    if (!session || !session.auth || !session.store) return undefined;
    let stored = await session.store.read();
    if (!stored) return undefined;
    // LIVE FLOW — session จาก live flow refresh ผ่าน live client — ลบพร้อม src/auth/live.js
    let client;
    if (stored.flow === 'live' && session.auth.live) {
      client = session.auth.live;
    } else {
      if (typeof session.auth.isConfigured === 'function' && !session.auth.isConfigured()) return undefined;
      client = typeof session.auth.requireClient === 'function' ? session.auth.requireClient() : session.auth;
    }
    if (client.isExpired(stored)) {
      stored = await client.refreshSession(stored);
      await session.store.save(stored);
    }
    return {
      username: stored.username,
      uuid: stored.uuid,
      accessToken: stored.accessToken,
      userType: stored.userType ?? 'msa',
      xuid: stored.xuid ?? undefined,
    };
  }

  // ไม่มี Microsoft session → ใช้ชื่อ offline ที่ตั้งไว้ใน config (ถ้ามี) ไม่งั้น default ของ launcher
  function offlineAuth() {
    const name = getConfig().auth?.offlineName;
    return typeof name === 'string' && name !== '' ? { username: name } : undefined;
  }

  async function shape(meta) {
    const status = manager.status(meta.id);
    let mods = null;
    if (installer && typeof installer.list === 'function') {
      try {
        mods = (await installer.list(meta.id)).length;
      } catch {
        mods = null;
      }
    }
    return {
      id: meta.id,
      name: meta.name,
      minecraftVersion: meta.minecraftVersion,
      loader: meta.loader,
      fabricLoaderVersion: meta.fabricLoaderVersion,
      java: meta.java,
      memory: meta.memory,
      extraJvmArgs: meta.extraJvmArgs ?? [],
      extraGameArgs: meta.extraGameArgs ?? [],
      running: status.running,
      pid: status.pid,
      sessionSeconds: status.sessionSeconds,
      playSeconds: meta.playSeconds ?? 0,
      lastPlayedAt: meta.lastPlayedAt ?? null,
      mods,
    };
  }

  router.get('/api/instances', async () => {
    const metas = await manager.list();
    const instances = [];
    for (const meta of metas) instances.push(await shape(meta));
    return { body: { count: instances.length, instances } };
  });

  router.post('/api/instances', async ({ body }) => {
    const meta = await manager.create({
      id: body?.id ?? undefined,
      name: body?.name,
      minecraftVersion: body?.minecraftVersion,
      loader: body?.loader ?? undefined,
      fabricLoaderVersion: body?.fabricLoaderVersion,
      java: body?.java ?? undefined,
      memory: body?.memory ?? undefined,
      extraJvmArgs: body?.extraJvmArgs ?? undefined,
      extraGameArgs: body?.extraGameArgs ?? undefined,
    });
    return { status: 201, body: { instance: await shape(meta) } };
  });

  if (importer) {
    router.post('/api/instances/import', async ({ req, body, query, upload }) => {
      if (upload) {
        await ensureDir(stagingDir);
        await sweepStaging(stagingDir, logger);
        const token = crypto.randomBytes(16).toString('hex');
        const staged = path.join(stagingDir, `${token}.zip`);
        await streamUpload(req, staged, IMPORT_UPLOAD_LIMIT_BYTES);

        let manifest;
        try {
          ({ manifest } = await importer.inspect(staged));
        } catch (err) {
          await removePath(staged).catch(() => {});
          throw err;
        }

        const preview = query.get('preview');
        if (preview !== '1' && preview !== 'true') {
          await removePath(staged).catch(() => {});
          throw new ValidationError('Uploaded archives must be validated first: use ?preview=1', {
            code: 'IMPORT_PREVIEW_REQUIRED',
          });
        }
        return { body: { token, manifest, preview: true } };
      }

      const token = typeof body?.token === 'string' ? body.token : '';
      if (!STAGED_TOKEN_RE.test(token)) {
        throw new ValidationError('Field "token" must be a token from a validated upload', {
          code: 'IMPORT_INVALID_TOKEN',
          details: { field: 'token' },
        });
      }
      const staged = path.join(stagingDir, `${token}.zip`);
      if (!(await pathExists(staged))) {
        throw new NotFoundError('Validated upload not found or already imported', {
          code: 'IMPORT_STAGED_NOT_FOUND',
          details: { token },
        });
      }

      try {
        const result = await importer.import(staged, { name: body?.name, id: body?.id });
        return {
          status: 201,
          body: {
            instanceId: result.instanceId,
            name: result.name,
            manifest: result.manifest,
            files: result.files,
            bytes: result.bytes,
          },
        };
      } finally {
        await removePath(staged).catch(() => {});
      }
    });
  }

  router.get('/api/instances/:id', async ({ params }) => {
    const meta = await manager.get(params.id);
    return { body: { instance: await shape(meta) } };
  });

  router.patch('/api/instances/:id', async ({ params, body }) => {
    const meta = await manager.update(params.id, body);
    return { body: { instance: await shape(meta) } };
  });

  router.delete('/api/instances/:id', async ({ params }) => {
    const result = await manager.delete(params.id);
    return { body: { ...result, instanceId: result.id } };
  });

  router.post('/api/instances/:id/launch', async ({ params }) => {
    // PLAY ใช้ได้เฉพาะเมื่อผู้ใช้เลือก runtime ที่ดาวน์โหลดมาแล้วไว้เท่านั้น
    if (java) {
      const chosen = typeof java.getChosen === 'function' ? java.getChosen() : null;
      const runtimes = chosen ? await java.list() : [];
      const picked = chosen ? runtimes.find((runtime) => runtime.name === chosen) ?? null : null;
      if (!picked || picked.downloaded !== true) {
        throw new JavaRuntimeError(
          'No downloaded Java runtime is selected — open Settings → Java Runtime, download a version and select it, then press PLAY again',
          {
            code: 'JAVA_RUNTIME_UNAVAILABLE',
            status: 409,
            details: { chosen },
          },
        );
      }
    }
    const auth = (await launchAuth()) ?? offlineAuth();
    const result = await manager.launch(params.id, {
      ...(auth ? { auth } : {}),
      windowPlatform: getConfig().window?.platform ?? DEFAULT_WINDOW_PLATFORM,
    });
    return {
      status: 202,
      body: {
        instanceId: result.id,
        running: true,
        pid: result.pid,
        version: result.version,
        source: result.source,
      },
    };
  });

  router.post('/api/instances/:id/stop', async ({ params }) => {
    const result = await manager.stop(params.id);
    return {
      body: {
        instanceId: result.id,
        running: false,
        code: result.code ?? null,
        signal: result.signal ?? null,
      },
    };
  });

  if (exporter) {
    router.post('/api/instances/:id/export', async ({ params, body }) => {
      const result = await exporter.export(params.id, {
        name: body?.name ?? undefined,
        path: body?.path ?? undefined,
        force: body?.force === true,
      });
      return {
        status: 201,
        body: {
          instanceId: result.instanceId,
          filename: result.filename,
          path: result.path,
          sha1: result.sha1,
          bytes: result.bytes,
          files: result.files,
          dirs: result.dirs,
          skipped: result.skipped,
        },
      };
    });
  }

  if (installer) {
    router.get('/api/instances/:id/mods', async ({ params }) => {
      const mods = await installer.list(params.id);
      return {
        body: {
          instanceId: params.id,
          count: mods.length,
          mods: mods.map((mod) => ({ filename: mod.filename, size: mod.size })),
        },
      };
    });

    router.post('/api/instances/:id/mods', async ({ params, body }) => {
      const versionId = body?.versionId;
      if (typeof versionId !== 'string' || versionId === '') {
        throw new ValidationError('Field "versionId" must be a non-empty string', {
          details: { field: 'versionId' },
        });
      }
      const result = await installer.install(params.id, versionId, { force: body?.force === true });
      return {
        status: 201,
        body: {
          instanceId: result.instanceId,
          projectId: result.projectId,
          versionId: result.versionId,
          versionNumber: result.versionNumber,
          installed: result.installed,
          skipped: result.skipped,
          files: result.files.map((file) => ({
            filename: file.filename,
            bytes: file.bytes,
            sha1: file.sha1 ?? null,
            sha512: file.sha512 ?? null,
          })),
        },
      };
    });

    router.delete('/api/instances/:id/mods/:modId', async ({ params }) => {
      const result = await installer.remove(params.id, params.modId);
      return { body: result };
    });

    router.get('/api/instances/:id/packs', async ({ params, query }) => {
      const kind = query.get('kind') ?? 'mods';
      const packs = await installer.list(params.id, { kind });
      return {
        body: {
          instanceId: params.id,
          kind,
          count: packs.length,
          packs: packs.map((pack) => ({ filename: pack.filename, size: pack.size })),
        },
      };
    });

    router.post('/api/instances/:id/packs', async ({ params, body }) => {
      const versionId = body?.versionId;
      const kind = body?.kind ?? 'mods';
      if (typeof versionId !== 'string' || versionId === '') {
        throw new ValidationError('Field "versionId" must be a non-empty string', {
          details: { field: 'versionId' },
        });
      }
      const result = await installer.install(params.id, versionId, { force: body?.force === true, kind });
      return {
        status: 201,
        body: {
          instanceId: result.instanceId,
          kind: result.kind,
          projectId: result.projectId,
          versionId: result.versionId,
          versionNumber: result.versionNumber,
          installed: result.installed,
          skipped: result.skipped,
          files: result.files.map((file) => ({
            filename: file.filename,
            bytes: file.bytes,
            sha1: file.sha1 ?? null,
            sha512: file.sha512 ?? null,
          })),
        },
      };
    });

    router.delete('/api/instances/:id/packs/:fileId', async ({ params, query, body }) => {
      const kind = query.get('kind') ?? (isPlainObject(body) && typeof body.kind === 'string' ? body.kind : 'mods');
      const result = await installer.remove(params.id, params.fileId, { kind });
      return { body: result };
    });
  }

  router.get('/api/instances/:id/launch-progress', async ({ params }) => {
    if (!instance?.manager || typeof instance.manager.getLaunchProgress !== 'function') {
      throw new NotFoundError(`Launch progress is not available for instance: ${params.id}`, {
        code: 'LAUNCH_PROGRESS_UNAVAILABLE',
        details: { id: params.id },
      });
    }
    const progress = instance.manager.getLaunchProgress(params.id);
    return { body: progress };
  });

  logger.debug('instance routes registered', { routes: router.list().length });
}

export function createApiRouter({
  config,
  logger,
  minecraft = null,
  instance = null,
  auth = null,
  account = null,
  modrinth = null,
  fabric = null,
  java = null,
  skin = null,
}) {
  const router = createRouter();
  const mc = minecraft ?? createMinecraftApi({ config, logger });
  const skinApi = skin ?? createSkinService({ config, logger });
  let liveConfig = config;

  async function saveJavaRuntime(name) {
    const current = await readJson(config.paths.configFile, { optional: true });
    const base = isPlainObject(current) ? current : {};
    const fileJava = isPlainObject(base.java) ? base.java : {};
    await writeJson(config.paths.configFile, { ...base, java: { ...fileJava, runtime: name } });
  }

  if ((auth && !account) || (!auth && account)) {
    throw new ValidationError('Auth API requires both an auth client and a token store', {
      code: 'INVALID_AUTH_CONFIG',
    });
  }
  if (auth && account) {
    registerAuthRoutes(router, config, logger, auth, account, () => liveConfig); // LIVE FLOW: getConfig
    registerSkinRoutes(router, config, logger, auth, account, skinApi);
  }

  if (instance && instance.manager) {
    registerInstanceRoutes(router, config, logger, instance, {
      auth: auth ?? null,
      store: account ?? null,
    }, () => liveConfig, java);
  } else if (instance) {
    throw new ValidationError('Instance API requires an instance manager', { code: 'INVALID_INSTANCE_MANAGER' });
  }

  if (modrinth) {
    router.get('/api/modrinth/search', async ({ query }) => {
      const q = query.get('q') ?? '';
      const limitRaw = query.get('limit');
      const limit = limitRaw === null || limitRaw === '' ? SEARCH_DEFAULT_LIMIT : Number(limitRaw);
      const offsetRaw = query.get('offset');
      const offset = offsetRaw === null || offsetRaw === '' ? 0 : Number(offsetRaw);
      const indexRaw = query.get('index');
      const index = indexRaw !== null && indexRaw !== '' ? indexRaw : q.trim() === '' ? 'downloads' : 'relevance';
      const typeRaw = query.get('type');
      const SEARCH_PROJECT_TYPES = ['mod', 'resourcepack', 'shader'];
      let facets;
      if (typeRaw !== null && typeRaw !== '') {
        if (!SEARCH_PROJECT_TYPES.includes(typeRaw)) {
          throw new ValidationError(`Field "type" must be one of: ${SEARCH_PROJECT_TYPES.join(', ')}`, {
            code: 'INVALID_SEARCH_TYPE',
            details: { field: 'type', known: SEARCH_PROJECT_TYPES },
          });
        }
        facets = [[`project_type:${typeRaw}`]];
      }

      const searchOptions = { limit, offset, index };
      if (facets) searchOptions.facets = facets;
      const result = await modrinth.search(q, searchOptions);
      return {
        body: {
          query: q,
          type: typeRaw !== null && typeRaw !== '' ? typeRaw : null,
          total: result.totalHits,
          offset: result.offset,
          limit: result.limit,
          count: result.hits.length,
          hits: result.hits.map((hit) => ({
            projectId: hit.projectId,
            slug: hit.slug,
            title: hit.title,
            description: hit.description,
            author: hit.author,
            downloads: hit.downloads,
            iconUrl: hit.iconUrl,
            categories: hit.categories,
            gameVersions: hit.gameVersions,
            latestVersionId: hit.latestVersionId,
          })),
        },
      };
    });

    router.get('/api/modrinth/project/:id', async ({ params }) => {
      const project = await modrinth.getProject(params.id);
      return {
        body: {
          project: {
            projectId: project.projectId,
            slug: project.slug,
            title: project.title,
            description: project.description,
            downloads: project.downloads,
            iconUrl: project.iconUrl,
            categories: project.categories,
            gameVersions: project.gameVersions ?? [],
            loaders: project.loaders ?? [],
          },
        },
      };
    });

    router.get('/api/modrinth/project/:id/versions', async ({ params, query }) => {
      const game = query.get('game');
      const loader = query.get('loader');
      const filters = { limit: VERSIONS_DEFAULT_LIMIT };
      if (game) filters.gameVersions = [game];
      if (loader) filters.loaders = [loader];

      const versions = await modrinth.listVersions(params.id, filters);
      return {
        body: {
          projectId: params.id,
          count: versions.length,
          versions: versions.map((version) => ({
            id: version.id,
            projectId: version.projectId,
            versionNumber: version.versionNumber,
            name: version.name,
            versionType: version.versionType,
            gameVersions: version.gameVersions,
            loaders: version.loaders,
            datePublished: version.datePublished,
            downloads: version.downloads,
            files: version.files.map((file) => ({
              filename: file.filename,
              size: file.size ?? null,
              primary: file.primary === true,
            })),
          })),
        },
      };
    });
  }

  if (fabric) {
    router.get('/api/fabric/loaders', async () => {
      const loaders = await fabric.listLoaderVersions();
      return {
        body: {
          count: loaders.length,
          loaders: loaders.map((entry) => ({
            version: entry.version,
            stable: entry.stable === true,
          })),
        },
      };
    });
  }

  if (java) {
    // ความคืบหน้าของ download แต่ละชื่อ — หน้า Java Runtime แยก overlay ของตัวเองมา poll ตรงนี้
    const javaDownloads = new Map();

    router.get('/api/java/runtimes', async () => {
      const runtimes = await java.list();
      return {
        body: {
          chosen: typeof java.getChosen === 'function' ? java.getChosen() : null,
          count: runtimes.length,
          runtimes: runtimes.map((runtime) => ({
            name: runtime.name,
            javaVersion: runtime.javaVersion,
            released: runtime.released ?? null,
            major: runtime.major ?? null,
            downloaded: runtime.downloaded === true,
          })),
        },
      };
    });

    router.get('/api/java/runtimes/:name/progress', async ({ params }) => {
      const name = validateRuntimeName(params.name);
      const entry = javaDownloads.get(name) ?? null;
      return {
        body: {
          name,
          active: entry?.phase === 'downloading',
          phase: entry?.phase ?? 'idle',
          loaded: entry?.loaded ?? 0,
          total: entry?.total ?? 0,
          percent: entry?.percent ?? 0,
          files: entry?.files ?? { done: 0, count: 0 },
        },
      };
    });

    router.post('/api/java/runtimes/:name/download', async ({ params, body }) => {
      const name = validateRuntimeName(params.name);
      const entry = { phase: 'downloading', loaded: 0, total: 0, percent: 0, files: { done: 0, count: 0 } };
      javaDownloads.set(name, entry);
      let result;
      try {
        result = await java.download(name, {
          force: body?.force === true,
          onProgress: (info) => {
            if (!info || typeof info !== 'object') return;
            if (Number.isFinite(info.loaded)) entry.loaded = info.loaded;
            if (Number.isFinite(info.total)) entry.total = info.total;
            if (Number.isFinite(info.percent)) entry.percent = info.percent;
            if (info.files && typeof info.files === 'object') entry.files = info.files;
          },
        });
      } catch (err) {
        javaDownloads.delete(name);
        throw err;
      }
      if (typeof java.setChosen === 'function') java.setChosen(name);
      liveConfig = { ...liveConfig, java: { ...(liveConfig.java ?? {}), runtime: name } };
      await saveJavaRuntime(name);
      entry.phase = 'done';
      entry.percent = 100;
      logger?.info('java runtime downloaded', { name, cached: result.cached === true });
      return {
        status: result.cached === true ? 200 : 201,
        body: {
          chosen: name,
          name: result.name,
          path: result.path,
          cached: result.cached === true,
          files: result.files,
          bytes: result.bytes,
        },
      };
    });

    router.delete('/api/java/runtimes/:name', async ({ params }) => {
      const name = validateRuntimeName(params.name);
      const result = await java.remove(name);
      javaDownloads.delete(name);
      const chosenNow = typeof java.getChosen === 'function' ? java.getChosen() : null;
      if (result.clearedChosen === true) {
        liveConfig = { ...liveConfig, java: { ...(liveConfig.java ?? {}), runtime: null } };
        await saveJavaRuntime(null);
      }
      logger?.info('java runtime deleted', { name, clearedChosen: result.clearedChosen === true });
      return {
        body: {
          name: result.name,
          deleted: true,
          clearedChosen: result.clearedChosen === true,
          chosen: chosenNow,
        },
      };
    });
  }

  router.get('/api/health', () => ({
    body: {
      status: 'ok',
      name: config.name,
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
  }));

  router.get('/api/config', () => {
    const body = publicConfig(liveConfig);
    if (auth) body.auth = { ...body.auth, configured: auth.isConfigured(), source: auth.source };
    return { body };
  });

  router.patch('/api/config', async ({ body }) => {
    const patch = isPlainObject(body) ? body : {};
    const serverPatch = isPlainObject(patch.server) ? patch.server : null;
    const logPatch = isPlainObject(patch.log) ? patch.log : null;
    const javaPatch = isPlainObject(patch.java) ? patch.java : null;
    const authPatch = isPlainObject(patch.auth) ? patch.auth : null;
    const windowPatch = isPlainObject(patch.window) ? patch.window : null;
    if (!serverPatch && !logPatch && !javaPatch && !authPatch && !windowPatch) {
      throw new ValidationError('Provide a "server", "log", "java", "auth" or "window" object to update', {
        code: 'CONFIG_PATCH_EMPTY',
        details: { fields: ['server', 'log', 'java', 'auth', 'window'] },
      });
    }

    const next = { host: liveConfig.server.host, port: liveConfig.server.port, level: liveConfig.log.level };
    let nextJava = liveConfig.java?.runtime ?? null;
    let nextOfflineName = liveConfig.auth?.offlineName ?? null;
    let nextFlow = liveConfig.auth?.flow ?? DEFAULT_AUTH_FLOW; // LIVE FLOW
    let nextWindowPlatform = liveConfig.window?.platform ?? DEFAULT_WINDOW_PLATFORM;
    const changedFields = [];

    if (serverPatch && serverPatch.host !== undefined) {
      if (liveConfig.server.hostFromEnv) {
        throw new ValidationError('server.host comes from the TML_HOST environment variable — change it there instead of config.json', {
          code: 'CONFIG_FROM_ENV',
          status: 409,
          details: { field: 'server.host' },
        });
      }
      if (typeof serverPatch.host !== 'string' || serverPatch.host.trim() === '') {
        throw new ValidationError('Field "server.host" must be a non-empty string', {
          code: 'INVALID_HOST',
          details: { field: 'server.host' },
        });
      }
      next.host = serverPatch.host.trim();
      if (next.host !== liveConfig.server.host) changedFields.push('server.host');
    }

    if (serverPatch && serverPatch.port !== undefined) {
      if (liveConfig.server.portFromEnv) {
        throw new ValidationError('server.port comes from the TML_PORT environment variable — change it there instead of config.json', {
          code: 'CONFIG_FROM_ENV',
          status: 409,
          details: { field: 'server.port' },
        });
      }
      const port = typeof serverPatch.port === 'string' ? Number(serverPatch.port.trim()) : serverPatch.port;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new ValidationError('Field "server.port" must be an integer between 0 and 65535', {
          code: 'INVALID_PORT',
          details: { field: 'server.port' },
        });
      }
      next.port = port;
      if (next.port !== liveConfig.server.port) changedFields.push('server.port');
    }

    if (logPatch && logPatch.level !== undefined) {
      if (liveConfig.log.fromEnv) {
        throw new ValidationError('log.level comes from the TML_LOG_LEVEL environment variable — change it there instead of config.json', {
          code: 'CONFIG_FROM_ENV',
          status: 409,
          details: { field: 'log.level' },
        });
      }
      const level = typeof logPatch.level === 'string' ? logPatch.level.trim().toLowerCase() : logPatch.level;
      if (!LOG_LEVEL_SET.has(level)) {
        throw new ValidationError(`Field "log.level" must be one of: ${LOG_LEVEL_VALUES.join(', ')}`, {
          code: 'INVALID_LOG_LEVEL',
          details: { field: 'log.level' },
        });
      }
      next.level = level;
      if (next.level !== liveConfig.log.level) changedFields.push('log.level');
    }

    if (javaPatch && javaPatch.runtime !== undefined) {
      nextJava = javaPatch.runtime === null ? null : validateRuntimeName(javaPatch.runtime);
      if (nextJava !== (liveConfig.java?.runtime ?? null)) changedFields.push('java.runtime');
    }

    if (authPatch && authPatch.offlineName !== undefined) {
      const raw = authPatch.offlineName;
      if (raw !== null && typeof raw !== 'string') {
        throw new ValidationError('Field "auth.offlineName" must be a string or null', {
          code: 'INVALID_OFFLINE_NAME',
          details: { field: 'auth.offlineName' },
        });
      }
      const value = raw === null ? null : raw.trim();
      if (value !== null && !OFFLINE_NAME_PATTERN.test(value)) {
        throw new ValidationError('Field "auth.offlineName" must be 3–16 characters of a–z, A–Z, 0–9 or "_"', {
          code: 'INVALID_OFFLINE_NAME',
          details: { field: 'auth.offlineName' },
        });
      }
      nextOfflineName = value;
      if (nextOfflineName !== (liveConfig.auth?.offlineName ?? null)) changedFields.push('auth.offlineName');
    }

    // LIVE FLOW — auth.flow เลือกวิธี sign in — ลบบล็อกนี้พร้อม src/auth/live.js
    if (authPatch && authPatch.flow !== undefined) {
      const rawFlow = authPatch.flow;
      if (rawFlow !== null && (typeof rawFlow !== 'string' || !AUTH_FLOW_VALUES.includes(rawFlow))) {
        throw new ValidationError(
          `Field "auth.flow" must be one of: ${AUTH_FLOW_VALUES.join(', ')} or null`,
          {
            code: 'INVALID_AUTH_FLOW',
            details: { field: 'auth.flow', known: [...AUTH_FLOW_VALUES] },
          },
        );
      }
      nextFlow = rawFlow === null ? DEFAULT_AUTH_FLOW : rawFlow;
      if (nextFlow !== (liveConfig.auth?.flow ?? DEFAULT_AUTH_FLOW)) changedFields.push('auth.flow');
    }

    // ตัวเลือก platform ของหน้าต่างเกม: 'auto' = ตาม session (Wayland native), 'x11' = ผ่าน XWayland
    if (windowPatch && windowPatch.platform !== undefined) {
      const rawPlatform = windowPatch.platform;
      const platform = typeof rawPlatform === 'string' ? rawPlatform.trim().toLowerCase() : rawPlatform;
      if (platform !== null && !WINDOW_PLATFORM_VALUES.includes(platform)) {
        throw new ValidationError(`Field "window.platform" must be one of: ${WINDOW_PLATFORM_VALUES.join(', ')} or null`, {
          code: 'INVALID_WINDOW_PLATFORM',
          details: { field: 'window.platform', known: [...WINDOW_PLATFORM_VALUES] },
        });
      }
      nextWindowPlatform = platform === null ? DEFAULT_WINDOW_PLATFORM : platform;
      if (nextWindowPlatform !== (liveConfig.window?.platform ?? DEFAULT_WINDOW_PLATFORM)) {
        changedFields.push('window.platform');
      }
    }

    const saved = changedFields.length > 0;
    const restartRequired = changedFields.some((field) => field.startsWith('server.')) ? ['server'] : [];
    if (changedFields.includes('log.level')) logger.setLevel(next.level);
    if (changedFields.includes('java.runtime') && typeof java?.setChosen === 'function') java.setChosen(nextJava);

    liveConfig = {
      ...liveConfig,
      server: { ...liveConfig.server, host: next.host, port: next.port },
      log: { ...liveConfig.log, level: next.level },
      java: { ...(liveConfig.java ?? {}), runtime: nextJava },
      window: { ...(liveConfig.window ?? {}), platform: nextWindowPlatform },
      auth: {
        ...(liveConfig.auth ?? {}),
        offlineName: nextOfflineName,
        flow: nextFlow, // LIVE FLOW — ลบ key นี้พร้อม src/auth/live.js
      },
    };

    if (saved) {
      const current = await readJson(config.paths.configFile, { optional: true });
      const base = isPlainObject(current) ? current : {};
      const nextFile = { ...base };
      const serverChanged = changedFields.some((field) => field.startsWith('server.'));
      const logChanged = changedFields.includes('log.level');
      if (serverChanged) {
        const fileServer = isPlainObject(base.server) ? base.server : {};
        nextFile.server = { ...fileServer };
        if (changedFields.includes('server.host')) nextFile.server.host = next.host;
        if (changedFields.includes('server.port')) nextFile.server.port = next.port;
      }
      if (logChanged) {
        const fileLog = isPlainObject(base.log) ? base.log : {};
        nextFile.log = { ...fileLog, level: next.level };
      }
      if (changedFields.includes('java.runtime')) {
        const fileJava = isPlainObject(base.java) ? base.java : {};
        nextFile.java = { ...fileJava, runtime: nextJava };
      }
      if (changedFields.includes('window.platform')) {
        const fileWindow = isPlainObject(base.window) ? base.window : {};
        nextFile.window = { ...fileWindow, platform: nextWindowPlatform };
      }
      if (changedFields.some((field) => field.startsWith('auth.'))) {
        const fileAuth = isPlainObject(base.auth) ? base.auth : {};
        nextFile.auth = { ...fileAuth };
        if (changedFields.includes('auth.offlineName')) {
          if (nextOfflineName === null) delete nextFile.auth.offlineName;
          else nextFile.auth.offlineName = nextOfflineName;
        }
        if (changedFields.includes('auth.flow')) {
          // LIVE FLOW — persist auth.flow — ลบพร้อม src/auth/live.js
          if (nextFlow === DEFAULT_AUTH_FLOW) delete nextFile.auth.flow;
          else nextFile.auth.flow = nextFlow;
        }
      }
      await writeJson(config.paths.configFile, nextFile);
      logger.info('launcher configuration updated', { changed: changedFields, restartRequired });
    }

    const view = publicConfig(liveConfig);
    if (auth) view.auth = { ...view.auth, configured: auth.isConfigured(), source: auth.source };
    return { body: { saved, changed: changedFields, restartRequired, config: view } };
  });

  router.get('/api/routes', () => ({
    body: { routes: router.list() },
  }));

  router.get('/api/sources', () => ({
    body: {
      version: VERSION,
      rules: {
        protocols: ['http:', 'https:'],
        defaultPortOnly: true,
        credentialsNotAllowed: true,
        categoryScoped: true,
      },
      sources: listSources(),
    },
  }));

  router.get('/api/minecraft/manifest', async ({ query }) => {
    const { manifest, source, cachedAt } = await mc.getManifest({ refresh: wantsRefresh(query) });
    return {
      body: {
        latest: manifest.latest,
        count: manifest.versions.length,
        source,
        cachedAt,
      },
    };
  });

  router.get('/api/minecraft/versions', async ({ query }) => {
    const type = query.get('type') ?? 'all';
    const limitRaw = query.get('limit');
    const limit = limitRaw === null || limitRaw === '' ? 0 : Number(limitRaw);

    const versions = await mc.listVersions({ type, limit, refresh: wantsRefresh(query) });
    return { body: { type, count: versions.length, versions } };
  });

  router.get('/api/minecraft/versions/:id', async ({ params }) => {
    const { version, source } = await mc.getVersion(params.id);
    const publicVersion = { ...version };
    delete publicVersion.raw;
    return { body: { version: publicVersion, source } };
  });

  logger.debug('api routes registered', { routes: router.list().length });
  return router;
}
