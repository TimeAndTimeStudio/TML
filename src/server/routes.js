// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AuthError, InstanceError, JavaRuntimeError, NotFoundError, ValidationError } from '../core/errors.js';
import { ensureDir, pathExists, readJson, removePath, writeJson } from '../core/filesystem.js';
import { createRouter } from './router.js';
import {
  publicConfig,
  writeDataDirPointer,
  VERSION,
  OFFLINE_NAME_PATTERN,
  WINDOW_PLATFORM_VALUES,
  DEFAULT_WINDOW_PLATFORM,
} from '../core/config.js';
import { findInstanceIcon, isIconFilename, sniffImage, ICON_MAX_BYTES, ICON_MIME } from '../instance/icon.js';
import { listSources } from '../security/urls.js';
import { validateRuntimeName } from '../java/runtimes.js';
import { safeVersionId } from '../minecraft/versions.js';
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
// ไม่กรอง game/loader (เช่น browse resource pack ทุกเวอร์ชี) → คืนให้ครบเท่าที่ Modrinth ให้ (สูงสุด 100)
const VERSIONS_ALL_LIMIT = 100;
const LOG_LEVEL_VALUES = ['debug', 'info', 'warn', 'error', 'silent'];
const LOG_LEVEL_SET = new Set(LOG_LEVEL_VALUES);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// body versionIds (อัปเดตหลายไฟล์ครั้งเดียว) → array ของ id หรือ null (เส้นทาง versionId เดี่ยว)
const BATCH_VERSION_IDS_MAX = 50;
function readVersionIds(body) {
  const raw = body?.versionIds;
  if (raw === undefined || raw === null) return null;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > BATCH_VERSION_IDS_MAX ||
    raw.some((value) => typeof value !== 'string' || value === '')
  ) {
    throw new ValidationError(
      `Field "versionIds" must be a non-empty array of version id strings (max ${BATCH_VERSION_IDS_MAX})`,
      { details: { field: 'versionIds' } }
    );
  }
  return raw;
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

// import จาก path บนเครื่อง (ไม่อัปโหลด) — คัดลอก .zip เข้า staging แล้วใช้ flow preview/confirm เดิม
async function stageImportPath(sourcePath, stagingDir, logger) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
    throw new ValidationError('Field "path" must be an absolute path', {
      code: 'IMPORT_PATH_NOT_ABSOLUTE',
      details: { field: 'path' },
    });
  }
  if (!sourcePath.toLowerCase().endsWith('.zip')) {
    throw new ValidationError('Field "path" must point to a .zip archive', {
      code: 'IMPORT_PATH_NOT_ZIP',
      details: { field: 'path' },
    });
  }
  let stats;
  try {
    stats = await fsp.stat(sourcePath);
  } catch {
    throw new NotFoundError(`Archive not found: ${sourcePath}`, {
      code: 'IMPORT_PATH_NOT_FOUND',
      details: { path: sourcePath },
    });
  }
  if (!stats.isFile()) {
    throw new ValidationError('Field "path" must point to a file', {
      code: 'IMPORT_PATH_NOT_A_FILE',
      details: { path: sourcePath },
    });
  }
  if (stats.size > IMPORT_UPLOAD_LIMIT_BYTES) {
    throw new ValidationError('Archive exceeds the import size limit', {
      code: 'IMPORT_PATH_TOO_LARGE',
      details: { size: stats.size, limit: IMPORT_UPLOAD_LIMIT_BYTES },
    });
  }

  await ensureDir(stagingDir);
  await sweepStaging(stagingDir, logger);
  const token = crypto.randomBytes(16).toString('hex');
  const staged = path.join(stagingDir, `${token}.zip`);
  try {
    await fsp.copyFile(sourcePath, staged);
    await fsp.chmod(staged, 0o600);
  } catch (err) {
    await removePath(staged).catch(() => {});
    throw new ValidationError('Could not read the archive at that path', {
      code: 'IMPORT_PATH_UNREADABLE',
      cause: err,
      details: { path: sourcePath },
    });
  }
  return staged;
}

function registerAuthRoutes(router, config, logger, auth, store) {
  const deviceLogins = new Map();

  function rememberStart(start) {
    if (deviceLogins.size >= AUTH_DEVICE_MAX) {
      deviceLogins.delete(deviceLogins.keys().next().value);
    }
    deviceLogins.set(start.deviceCode, start);
  }

  router.post('/api/auth/device', async () => {
    const client = auth.requireClient();
    const start = await client.startDeviceLogin();
    rememberStart(start);
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

    const client = auth.requireClient();

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
      },
    };
  });

  router.delete('/api/auth/session', async () => {
    await store.clear();
    return { body: { signedIn: false } };
  });
}

// เปลี่ยน skin ผ่าน Minecraft Services API — ใช้ accessToken ของ session ที่ล็อกอินไว้ (หมดอายุ → token-store ลบ session ให้เอง)
function registerSkinRoutes(router, config, logger, account, skin) {
  async function accessToken() {
    const stored = await account.read();
    if (!stored) {
      throw new AuthError('Sign in with a Microsoft account to change your skin', {
        code: 'AUTH_NO_SESSION',
        status: 401,
        details: { stage: 'config' },
      });
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
  const { manager, exporter = null, importer = null, installer = null, gameserver = null } = instance;
  const stagingDir = path.join(config.paths.tmpDir, 'import-staging');
  // สถานะล่าสุดของ POST /check ต่อ instance+kind ให้ UI poll ระหว่างที่คำนวณยังไม่จบ (คล้าย launch-progress)
  const checkProgress = new Map();

  async function launchAuth() {
    if (!session || !session.auth || !session.store) return undefined;
    const stored = await session.store.read();
    if (!stored) return undefined;
    if (typeof session.auth.isConfigured === 'function' && !session.auth.isConfigured()) return undefined;
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
    const isServer = meta.type === 'server';
    let status;
    let installed = null;
    if (isServer) {
      // server รันคนละ map กับ client (gameserver) — ไม่งั้น status จะฟ้อง stopped ตลอด
      status = gameserver ? await gameserver.status(meta.id) : { running: false, pid: null, sessionSeconds: 0 };
      installed = gameserver ? status.installed : null;
    } else {
      status = manager.status(meta.id);
    }
    let mods = null;
    if (installer && typeof installer.list === 'function') {
      try {
        mods = (await installer.list(meta.id)).length;
      } catch {
        mods = null;
      }
    }
    const iconName = await findInstanceIcon(manager.paths(meta.id).dir);
    return {
      id: meta.id,
      name: meta.name,
      type: meta.type ?? 'client',
      minecraftVersion: meta.minecraftVersion,
      previousMinecraftVersion: meta.previousMinecraftVersion ?? null,
      loader: meta.loader,
      fabricLoaderVersion: meta.fabricLoaderVersion,
      java: meta.java,
      memory: meta.memory,
      extraJvmArgs: meta.extraJvmArgs ?? [],
      extraGameArgs: meta.extraGameArgs ?? [],
      port: meta.port ?? 25565,
      eulaAccepted: meta.eulaAccepted === true,
      installed,
      running: status.running,
      pid: status.pid,
      sessionSeconds: status.sessionSeconds,
      playSeconds: meta.playSeconds ?? 0,
      lastPlayedAt: meta.lastPlayedAt ?? null,
      mods,
      icon: iconName !== null,
    };
  }

  // server routes เฉพาะทาง — instance ที่เป็น client เรียกมาต้องโดนปฏิเสธชัดเจน
  async function serverMeta(id) {
    const meta = await manager.get(id);
    if (meta.type !== 'server') {
      throw new ValidationError('This instance is a game client — manage it from Instances', {
        code: 'NOT_SERVER_INSTANCE',
        status: 400,
        details: { id, type: meta.type },
      });
    }
    return meta;
  }

  function requireGameserver() {
    if (!gameserver) {
      throw new NotFoundError('Server management is not available', {
        code: 'GAME_SERVER_UNAVAILABLE',
        details: { id: null },
      });
    }
    return gameserver;
  }

  router.get('/api/instances', async () => {
    const metas = await manager.list();
    const instances = [];
    // list นี้ = client อย่างเดียว — server แยกขึ้น /api/servers
    for (const meta of metas) {
      if (meta.type === 'server') continue;
      instances.push(await shape(meta));
    }
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

  router.get('/api/servers', async () => {
    const metas = await manager.list();
    const servers = [];
    for (const meta of metas) {
      if (meta.type !== 'server') continue;
      servers.push(await shape(meta));
    }
    return { body: { count: servers.length, servers } };
  });

  router.post('/api/servers', async ({ body }) => {
    const meta = await manager.create({
      id: body?.id ?? undefined,
      name: body?.name,
      type: 'server',
      minecraftVersion: body?.minecraftVersion,
      loader: body?.loader ?? undefined,
      fabricLoaderVersion: body?.fabricLoaderVersion,
      java: body?.java ?? undefined,
      memory: body?.memory ?? undefined,
      extraJvmArgs: body?.extraJvmArgs ?? undefined,
      port: body?.port ?? undefined,
    });
    return { status: 201, body: { server: await shape(meta) } };
  });

  if (importer) {
    // expectedType = 'client' | 'server' — archive ผิดชนิดถูกปฏิเสธตั้งแต่ preview
    const importHandler = (expectedType) => async ({ req, body, query, upload }) => {
      if (upload) {
        await ensureDir(stagingDir);
        await sweepStaging(stagingDir, logger);
        const token = crypto.randomBytes(16).toString('hex');
        const staged = path.join(stagingDir, `${token}.zip`);
        await streamUpload(req, staged, IMPORT_UPLOAD_LIMIT_BYTES);

        let manifest;
        try {
          ({ manifest } = await importer.inspect(staged, { expectedType }));
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

      // import จาก path บนเครื่อง — ไม่ใช่ upload (content-type ไม่ใช่ zip) → body = { path }
      if (typeof body?.path === 'string' && body.path !== '' && typeof body?.token !== 'string') {
        const preview = query.get('preview');
        if (preview !== '1' && preview !== 'true') {
          throw new ValidationError('Path imports must be validated first: use ?preview=1', {
            code: 'IMPORT_PREVIEW_REQUIRED',
          });
        }
        const staged = await stageImportPath(body.path, stagingDir, logger);
        let manifest;
        try {
          ({ manifest } = await importer.inspect(staged, { expectedType }));
        } catch (err) {
          await removePath(staged).catch(() => {});
          throw err;
        }
        return { body: { token: path.basename(staged, '.zip'), manifest, preview: true } };
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
        const result = await importer.import(staged, { name: body?.name, id: body?.id, expectedType });
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
    };

    router.post('/api/instances/import', importHandler('client'));
    router.post('/api/servers/import', importHandler('server'));
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
    if (gameserver?.isRunning(params.id)) {
      throw new InstanceError(`Server is running: ${params.id}`, {
        code: 'INSTANCE_RUNNING',
        status: 409,
        details: { id: params.id },
      });
    }
    const result = await manager.delete(params.id);
    return { body: { ...result, instanceId: result.id } };
  });

  // ---------- Instance icon (รูปแทน instance — อัปโหลดเป็น raw bytes, sniff magic bytes เอง) ----------

  router.get('/api/instances/:id/icon', async ({ params, res }) => {
    await manager.get(params.id);
    const dir = manager.paths(params.id).dir;
    const name = await findInstanceIcon(dir);
    if (name === null) {
      throw new NotFoundError('No icon is set for this instance', {
        code: 'INSTANCE_ICON_NOT_FOUND',
        details: { id: params.id },
      });
    }
    const data = await fsp.readFile(path.join(dir, name));
    res.statusCode = 200;
    res.setHeader('Content-Type', ICON_MIME[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', data.length);
    res.end(data);
  });

  router.post('/api/instances/:id/icon', async ({ params, req, upload }) => {
    if (!upload) {
      throw new ValidationError('Send the icon image as raw bytes (content-type: application/octet-stream)', {
        code: 'ICON_UPLOAD_TYPE',
        details: { field: 'content-type' },
      });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > ICON_MAX_BYTES) {
        throw new ValidationError('Icon image is too large', {
          code: 'ICON_TOO_LARGE',
          details: { limitBytes: ICON_MAX_BYTES },
        });
      }
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const kind = sniffImage(data);
    if (kind === null) {
      throw new ValidationError('Unsupported image — use a PNG, JPEG, WebP or GIF', {
        code: 'ICON_UNSUPPORTED_TYPE',
      });
    }
    await manager.get(params.id);
    const dir = manager.paths(params.id).dir;
    await ensureDir(dir);
    for (const existing of await fsp.readdir(dir)) {
      if (isIconFilename(existing)) await removePath(path.join(dir, existing));
    }
    await fsp.writeFile(path.join(dir, `icon.${kind}`), data, { mode: 0o644 });
    logger.debug('instance icon set', { id: params.id, bytes: data.length, type: kind });
    return { body: { id: params.id, icon: true } };
  });

  router.delete('/api/instances/:id/icon', async ({ params }) => {
    await manager.get(params.id);
    const dir = manager.paths(params.id).dir;
    let removed = false;
    try {
      for (const existing of await fsp.readdir(dir)) {
        if (isIconFilename(existing)) {
          await removePath(path.join(dir, existing));
          removed = true;
        }
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    logger.debug('instance icon removed', { id: params.id, removed });
    return { body: { id: params.id, icon: false, removed } };
  });

  // ---------- Servers (Fabric server ในตัว — ชนิดเดียวกับ client จัดการคนละทาง) ----------

  router.get('/api/servers/:id', async ({ params }) => {
    const meta = await serverMeta(params.id);
    return { body: { server: await shape(meta) } };
  });

  router.get('/api/servers/:id/status', async ({ params }) => {
    await serverMeta(params.id);
    return { body: await requireGameserver().status(params.id) };
  });

  router.get('/api/servers/:id/console', async ({ params, query }) => {
    await serverMeta(params.id);
    const since = Number.parseInt(String(query.get('since') ?? '0'), 10);
    return { body: requireGameserver().readConsole(params.id, Number.isFinite(since) ? since : 0) };
  });

  router.post('/api/servers/:id/install', async ({ params, body }) => {
    await serverMeta(params.id);
    const result = await requireGameserver().install(params.id, { force: body?.force === true });
    return { status: 202, body: { instanceId: result.id, installed: true, skipped: result.skipped === true } };
  });

  // START = ยังไม่มีไฟล์ก็ลงให้เอง (แบบเดียวกับ PLAY ของ client ที่ลงเกมก่อน)
  router.post('/api/servers/:id/start', async ({ params }) => {
    await serverMeta(params.id);
    const result = await requireGameserver().start(params.id);
    return {
      status: 202,
      body: { instanceId: result.id, running: true, pid: result.pid, port: result.port, installed: result.installed },
    };
  });

  router.post('/api/servers/:id/stop', async ({ params }) => {
    await serverMeta(params.id);
    const result = await requireGameserver().stop(params.id);
    return {
      body: { instanceId: result.id, running: false, code: result.code ?? null, signal: result.signal ?? null },
    };
  });

  router.post('/api/servers/:id/eula', async ({ params, body }) => {
    await serverMeta(params.id);
    const accept = isPlainObject(body) && body.accept === true;
    const result = await requireGameserver().setEula(params.id, accept);
    return { body: { instanceId: result.id, eulaAccepted: result.eulaAccepted } };
  });

  router.post('/api/instances/:id/launch', async ({ params }) => {
    // มีอยู่จริงค่อยตรวจชนิด (instance ไม่มีจริงต้องยังคืน 404 ตามเดิม — java gate มาก่อน)
    const existing = await manager.get(params.id).catch((err) => {
      if (err?.code === 'INSTANCE_NOT_FOUND') return null;
      throw err;
    });
    if (existing?.type === 'server') {
      throw new InstanceError('This is a server — press START from its server page instead', {
        code: 'SERVER_INSTANCE',
        status: 409,
        details: { id: params.id },
      });
    }
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
    const existing = await manager.get(params.id).catch((err) => {
      if (err?.code === 'INSTANCE_NOT_FOUND') return null;
      throw err;
    });
    if (existing?.type === 'server') {
      throw new InstanceError('This is a server — use STOP from its server page instead', {
        code: 'SERVER_INSTANCE',
        status: 409,
        details: { id: params.id },
      });
    }
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
      if (gameserver?.isRunning(params.id)) {
        throw new InstanceError(`Server is running: ${params.id}`, {
          code: 'INSTANCE_RUNNING',
          status: 409,
          details: { id: params.id },
        });
      }
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
      const versionIds = readVersionIds(body);
      if (versionIds) {
        const result = await installer.installMany(params.id, versionIds, { force: body?.force === true });
        return { status: 201, body: result };
      }
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
      const versionIds = readVersionIds(body);
      if (versionIds) {
        const kind = body?.kind ?? 'mods';
        const result = await installer.installMany(params.id, versionIds, { force: body?.force === true, kind });
        return { status: 201, body: result };
      }
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

    // ไฟล์ที่อัปเดตแล้วไม่รองรับ → ย้ายไป .removed/ พร้อมจดจำเหตุผล เพื่อกู้คืนได้ภายหลัง
    router.post('/api/instances/:id/removed', async ({ params, body }) => {
      const payload = isPlainObject(body) ? body : {};
      const kind = typeof payload.kind === 'string' ? payload.kind : 'mods';
      const result = await installer.trash(params.id, payload.filename, {
        kind,
        reason: payload.reason ?? null,
        targetVersion: payload.targetVersion ?? null,
      });
      return { status: 201, body: result };
    });

    router.get('/api/instances/:id/removed', async ({ params, query }) => {
      // ?minecraftVersion=<target> → คำนวณ supported ต่อรายการ (ใช้ตอน auto-restore ไฟล์ที่เวอร์ชั่นเป้าหมายรองรับแล้ว)
      let minecraftVersion = null;
      const rawVersion = query.get('minecraftVersion');
      if (typeof rawVersion === 'string' && rawVersion !== '') minecraftVersion = safeVersionId(rawVersion);
      const removed = await installer.listRemoved(params.id, { minecraftVersion });
      return { body: { instanceId: params.id, count: removed.length, removed } };
    });

    router.post('/api/instances/:id/removed/restore', async ({ params, body }) => {
      const payload = isPlainObject(body) ? body : {};
      const kind = typeof payload.kind === 'string' ? payload.kind : 'mods';
      const result = await installer.restore(params.id, payload.filename, { kind });
      return { body: result };
    });

    // เช็คไฟล์ .jar/.zip กับ Modrinth (hash) → ถ้าตรงเพิ่มเข้า registry + เทียบเวอร์ชีว่ามีอัปเดตไหม
    router.post('/api/instances/:id/check', async ({ params, body }) => {
      if (typeof installer.check !== 'function') {
        throw new NotFoundError('File check is not available for this instance', {
          code: 'INSTANCE_CHECK_UNAVAILABLE',
          details: { id: params.id },
        });
      }
      const kind = isPlainObject(body) && typeof body.kind === 'string' ? body.kind : 'mods';
      // slot ต่อ instance+kind → เช็คหลาย kind พร้อมกันได้ (เหมือนกัน kind เดียวกันยังกัน 409 ซ้ำอยู่)
      const slots = checkProgress.get(params.id) ?? new Map();
      const running = slots.get(kind);
      if (running?.running) {
        throw new ValidationError('A file check is already running for this instance', {
          code: 'CHECK_ALREADY_RUNNING',
          status: 409,
          details: { id: params.id, kind },
        });
      }
      const adopt = !(isPlainObject(body) && body.adopt === false);
      // minecraftVersion ใน body = ดูความเข้ากันได้กับเวอร์ชีที่ยังไม่บันทึก (preview ก่อนกด SAVE)
      let minecraftVersion = null;
      if (isPlainObject(body) && body.minecraftVersion !== undefined && body.minecraftVersion !== null) {
        minecraftVersion = safeVersionId(body.minecraftVersion);
      }
      const slot = {
        instanceId: params.id,
        kind,
        running: true,
        phase: 'start',
        current: 0,
        total: 0,
        message: 'Starting…',
        startedAt: Date.now(),
        finishedAt: null,
      };
      slots.set(kind, slot);
      checkProgress.set(params.id, slots);
      try {
        const result = await installer.check(params.id, {
          kind,
          adopt,
          ...(minecraftVersion ? { minecraftVersion } : {}),
          onProgress: (progress) => {
            slot.phase = progress.phase;
            slot.current = progress.current;
            slot.total = progress.total;
            slot.message = progress.message;
          },
        });
        slot.running = false;
        slot.phase = 'done';
        slot.message = 'Check complete';
        slot.finishedAt = Date.now();
        return { body: result };
      } catch (err) {
        slot.running = false;
        slot.phase = 'error';
        slot.message = err?.message ?? 'Check failed';
        slot.finishedAt = Date.now();
        throw err;
      }
    });

    router.get('/api/instances/:id/check-progress', async ({ params }) => {
      const slots = [...(checkProgress.get(params.id)?.values() ?? [])];
      if (slots.length === 0) {
        return {
          body: { instanceId: params.id, running: false, phase: 'idle', current: 0, total: 0, message: '' },
        };
      }
      const runningSlots = slots.filter((slot) => slot.running);
      // มีหลาย kind วิ่งพร้อมกัน → รวม current/total ทุก slot และเอา slot ล่าสุดเป็นตัวแทน phase/message
      const source =
        runningSlots.length > 0
          ? runningSlots.reduce((a, b) => (a.startedAt > b.startedAt ? a : b))
          : slots.reduce((a, b) => ((a.finishedAt ?? 0) >= (b.finishedAt ?? 0) ? a : b));
      return {
        body: {
          instanceId: params.id,
          running: runningSlots.length > 0,
          phase: source.phase,
          current: slots.reduce((sum, slot) => sum + (slot.current ?? 0), 0),
          total: slots.reduce((sum, slot) => sum + (slot.total ?? 0), 0),
          message: source.message,
          startedAt: Math.min(...slots.map((slot) => slot.startedAt)),
          finishedAt:
            runningSlots.length > 0
              ? null
              : Math.max(...slots.map((slot) => slot.finishedAt ?? slot.startedAt)),
          kind: source.kind ?? null,
        },
      };
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
    registerAuthRoutes(router, config, logger, auth, account);
    registerSkinRoutes(router, config, logger, account, skinApi);
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
      const filters = {
        limit: game || loader ? VERSIONS_DEFAULT_LIMIT : VERSIONS_ALL_LIMIT,
      };
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
    const dataDirPatch = patch.dataDir !== undefined && patch.dataDir !== null ? patch.dataDir : null;
    if (!serverPatch && !logPatch && !javaPatch && !authPatch && !windowPatch && dataDirPatch === null) {
      throw new ValidationError('Provide a "server", "log", "java", "auth", "window" or "dataDir" field to update', {
        code: 'CONFIG_PATCH_EMPTY',
        details: { fields: ['server', 'log', 'java', 'auth', 'window', 'dataDir'] },
      });
    }

    const next = { host: liveConfig.server.host, port: liveConfig.server.port, level: liveConfig.log.level };
    let nextJava = liveConfig.java?.runtime ?? null;
    let nextOfflineName = liveConfig.auth?.offlineName ?? null;
    let nextWindowPlatform = liveConfig.window?.platform ?? DEFAULT_WINDOW_PLATFORM;
    let nextDataDir = null;
    const changedFields = [];

    if (dataDirPatch !== null) {
      if (liveConfig.dataDirFromEnv) {
        throw new ValidationError('dataDir comes from the TML_DATA_DIR environment variable — change it there instead', {
          code: 'CONFIG_FROM_ENV',
          status: 409,
          details: { field: 'dataDir' },
        });
      }
      if (typeof dataDirPatch !== 'string' || dataDirPatch.trim() === '') {
        throw new ValidationError('Field "dataDir" must be a non-empty string', {
          code: 'INVALID_DATA_DIR',
          details: { field: 'dataDir' },
        });
      }
      nextDataDir = path.resolve(dataDirPatch.trim());
      const currentDataDir = liveConfig.paths.dataDir;
      if (nextDataDir === currentDataDir) {
        throw new ValidationError('The new data directory is already the current one', {
          code: 'DATA_DIR_UNCHANGED',
          details: { field: 'dataDir', path: nextDataDir },
        });
      }
      if (nextDataDir.startsWith(currentDataDir + path.sep)) {
        throw new ValidationError('The data directory cannot be moved inside itself', {
          code: 'DATA_DIR_INSIDE',
          details: { field: 'dataDir', path: nextDataDir },
        });
      }
      // target ต้องยังไม่มีหรือเป็น folder ว่าง — กันไฟล์ชนกันตอนย้าย
      try {
        const stat = await fsp.stat(nextDataDir);
        if (!stat.isDirectory()) {
          throw new ValidationError('The target path exists and is not a folder', {
            code: 'DATA_DIR_NOT_A_DIRECTORY',
            details: { field: 'dataDir', path: nextDataDir },
          });
        }
        const existing = await fsp.readdir(nextDataDir);
        if (existing.length > 0) {
          throw new ValidationError('The target folder must be empty or not exist', {
            code: 'DATA_DIR_NOT_EMPTY',
            details: { field: 'dataDir', path: nextDataDir },
          });
        }
      } catch (err) {
        if (err?.code === 'ENOENT') {
          /* ยังไม่มี folder → ตอน restart applyDataDirMoveSync จะสร้างให้ */
        } else if (err instanceof ValidationError) {
          throw err;
        } else {
          throw new ValidationError('The target folder cannot be used', {
            code: 'DATA_DIR_INVALID_TARGET',
            cause: err,
            details: { field: 'dataDir', path: nextDataDir },
          });
        }
      }
    }

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

    // ตัวเลือก platform ของหน้าต่างเกม: 'auto' = ตาม session, 'wayland' = บังคับ Wayland เท่านั้น
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

    if (nextDataDir !== null) changedFields.push('dataDir');

    const saved = changedFields.length > 0;
    const restartRequired = [];
    if (changedFields.some((field) => field.startsWith('server.'))) restartRequired.push('server');
    if (changedFields.includes('dataDir')) restartRequired.push('dataDir');
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
      }
      await writeJson(config.paths.configFile, nextFile);
      logger.info('launcher configuration updated', { changed: changedFields, restartRequired });
    }

    // เขียน pointer { dataDir, from } — ย้ายข้อมูลจริงตอน start รอบถัดไป (applyDataDirMoveSync)
    // server ยังรันด้วย data dir เดิมต่อได้จนกว่าจะ restart
    if (nextDataDir !== null) {
      writeDataDirPointer(nextDataDir, { from: liveConfig.paths.dataDir });
      logger.info('data directory move scheduled', { from: liveConfig.paths.dataDir, to: nextDataDir });
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
