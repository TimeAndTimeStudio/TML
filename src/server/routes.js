// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { JavaRuntimeError, NotFoundError, ValidationError } from '../core/errors.js';
import { ensureDir, pathExists, readJson, removePath, writeJson } from '../core/filesystem.js';
import { createRouter } from './router.js';
import {
  publicConfig,
  writeDataDirPointer,
  VERSION,
  OFFLINE_NAME_PATTERN,
} from '../core/config.js';
import { findInstanceIcon, isIconFilename, sniffImage, ICON_MAX_BYTES, ICON_MIME } from '../instance/icon.js';
import { listSources } from '../security/urls.js';
import { validateRuntimeName } from '../java/runtimes.js';
import { safeVersionId } from '../minecraft/versions.js';
import { createMinecraftApi } from '../minecraft/api.js';

const startedAt = Date.now();

const IMPORT_UPLOAD_LIMIT_BYTES = 256 * 1024 * 1024;
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;
const STAGED_TOKEN_RE = /^[a-f0-9]{32}$/;
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

function registerInstanceRoutes(router, config, logger, instance, getConfig = () => config, java = null) {
  const { manager, exporter = null, importer = null, installer = null } = instance;
  const stagingDir = path.join(config.paths.tmpDir, 'import-staging');
  // สถานะล่าสุดของ POST /check ต่อ instance+kind ให้ UI poll ระหว่างที่คำนวณยังไม่จบ (คล้าย launch-progress)
  const checkProgress = new Map();

  // ชื่อผู้เล่น = offline name ที่ตั้งไว้ใน Settings (ไม่มี login ในระบบแล้ว)
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
      extraJvmArgsConfigured: meta.extraJvmArgsConfigured === true,
      extraGameArgs: meta.extraGameArgs ?? [],
      installed: null,
      running: status.running,
      pid: status.pid,
      sessionSeconds: status.sessionSeconds,
      playSeconds: meta.playSeconds ?? 0,
      lastPlayedAt: meta.lastPlayedAt ?? null,
      mods,
      icon: iconName !== null,
    };
  }

  router.get('/api/instances', async () => {
    const metas = await manager.list();
    const instances = [];
    for (const meta of metas) {
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

  if (importer) {
    // archive ผิดชนิดถูกปฏิเสธตั้งแต่ preview (expectedType = 'client' เสมอ)
    const importHandler = async ({ req, body, query, upload }) => {
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
          ({ manifest } = await importer.inspect(staged));
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
    };

    router.post('/api/instances/import', importHandler);
  }

  router.get('/api/instances/:id', async ({ params }) => {
    const meta = await manager.get(params.id);
    return { body: { instance: await shape(meta) } };
  });

  router.get('/api/instances/:id/console', async ({ params, query }) => {
    if (typeof manager.readConsole !== 'function') {
      throw new NotFoundError(`Instance console is not available: ${params.id}`, {
        code: 'INSTANCE_CONSOLE_UNAVAILABLE', details: { id: params.id },
      });
    }
    const since = Number.parseInt(String(query.get('since') ?? '0'), 10);
    const generation = Number.parseInt(String(query.get('generation') ?? ''), 10);
    return {
      body: manager.readConsole(
        params.id,
        Number.isFinite(since) ? since : 0,
        Number.isFinite(generation) ? generation : null,
      ),
    };
  });

  router.get('/api/instances/:id/default-jvm-args', async ({ params }) => {
    if (typeof manager.getDefaultJvmArgs !== 'function') return { body: { args: [] } };
    return { body: { args: await manager.getDefaultJvmArgs(params.id) } };
  });

  router.post('/api/instances/:id/open-folder', async ({ params }) => {
    await manager.get(params.id);
    const directory = manager.paths(params.id).dir;
    await new Promise((resolve, reject) => {
      const opener = spawn('explorer.exe', [directory], { detached: true, stdio: 'ignore' });
      opener.once('error', reject);
      opener.once('spawn', () => {
        opener.unref();
        resolve();
      });
    });
    return { body: { opened: true } };
  });

  router.patch('/api/instances/:id', async ({ params, body }) => {
    const meta = await manager.update(params.id, body);
    return { body: { instance: await shape(meta) } };
  });

  router.delete('/api/instances/:id', async ({ params }) => {
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

  router.post('/api/instances/:id/launch', async ({ params }) => {
    // มีอยู่จริงค่อยตรวจชนิด (instance ไม่มีจริงต้องยังคืน 404 ตามเดิม — java gate มาก่อน)
    const existing = await manager.get(params.id).catch((err) => {
      if (err?.code === 'INSTANCE_NOT_FOUND') return null;
      throw err;
    });
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
    const auth = offlineAuth();
    const result = await manager.launch(params.id, {
      ...(auth ? { auth } : {}),
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
          mods: mods.map((mod) => ({ filename: mod.filename, size: mod.size, ...(mod.projectId ? { projectId: mod.projectId } : {}) })),
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
          packs: packs.map((pack) => ({ filename: pack.filename, size: pack.size, ...(pack.projectId ? { projectId: pack.projectId } : {}) })),
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
  modrinth = null,
  fabric = null,
  java = null,
}) {
  const router = createRouter();
  const mc = minecraft ?? createMinecraftApi({ config, logger });
  let liveConfig = config;

  async function saveJavaRuntime(name) {
    const current = await readJson(config.paths.configFile, { optional: true });
    const base = isPlainObject(current) ? current : {};
    await writeJson(config.paths.configFile, { ...base, java: name });
  }

  if (instance && instance.manager) {
    registerInstanceRoutes(router, config, logger, instance, () => liveConfig, java);
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
      const gameRaw = query.get('game');
      const SEARCH_PROJECT_TYPES = ['mod', 'resourcepack', 'shader'];
      if (typeRaw !== null && typeRaw !== '') {
        if (!SEARCH_PROJECT_TYPES.includes(typeRaw)) {
          throw new ValidationError(`Field "type" must be one of: ${SEARCH_PROJECT_TYPES.join(', ')}`, {
            code: 'INVALID_SEARCH_TYPE',
            details: { field: 'type', known: SEARCH_PROJECT_TYPES },
          });
        }
      }
      if (gameRaw !== null && gameRaw !== '' && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(gameRaw)) {
        throw new ValidationError('Field "game" must be a valid Minecraft version tag', {
          code: 'INVALID_GAME_VERSION', details: { field: 'game' },
        });
      }

      const facets = [];
      if (typeRaw) facets.push([`project_type:${typeRaw}`]);
      if (gameRaw) facets.push([`versions:${gameRaw}`]);

      const searchOptions = { limit, offset, index };
      if (facets.length) searchOptions.facets = facets;
      const result = await modrinth.search(q, searchOptions);
      return {
        body: {
          query: q,
          type: typeRaw !== null && typeRaw !== '' ? typeRaw : null,
          gameVersion: gameRaw || null,
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
            clientSide: hit.clientSide,
            serverSide: hit.serverSide,
            gameVersions: hit.gameVersions,
            latestVersionId: hit.latestVersionId,
          })),
        },
      };
    });

    router.post('/api/modrinth/projects', async ({ body }) => {
      if (!Array.isArray(body?.ids) || body.ids.length > 50
          || body.ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id))) {
        throw new ValidationError('Project IDs must be an array of at most 50 safe identifiers');
      }
      const projects = await modrinth.getProjects(body.ids);
      return { body: { projects: projects.map((project) => ({
        projectId: project.projectId ?? project.id,
        slug: project.slug, title: project.title, iconUrl: project.iconUrl,
        clientSide: project.clientSide, serverSide: project.serverSide,
      })) } };
    });

    router.get('/api/modrinth/project/:id', async ({ params }) => {
      const project = await modrinth.getProject(params.id);
      return {
        body: {
          project: {
            projectId: project.projectId ?? project.id,
            slug: project.slug,
            title: project.title,
            description: project.description,
            downloads: project.downloads,
            iconUrl: project.iconUrl,
            categories: project.categories,
            clientSide: project.clientSide,
            serverSide: project.serverSide,
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
    return { body };
  });

  router.patch('/api/config', async ({ body }) => {
    const patch = isPlainObject(body) ? body : {};
    const hasHost = patch.host !== undefined;
    const hasPort = patch.port !== undefined;
    const hasLog = patch.log !== undefined;
    const hasJava = patch.java !== undefined;
    const hasOfflineName = patch.offlineName !== undefined;
    const dataDirPatch = patch.dataDir !== undefined && patch.dataDir !== null ? patch.dataDir : null;
    if (!hasHost && !hasPort && !hasLog && !hasJava && !hasOfflineName && dataDirPatch === null) {
      throw new ValidationError('Provide a "host", "port", "log", "java", "offlineName" or "dataDir" field to update', {
        code: 'CONFIG_PATCH_EMPTY',
        details: { fields: ['host', 'port', 'log', 'java', 'offlineName', 'dataDir'] },
      });
    }

    const next = { host: liveConfig.server.host, port: liveConfig.server.port, level: liveConfig.log.level };
    let nextJava = liveConfig.java?.runtime ?? null;
    let nextOfflineName = liveConfig.auth?.offlineName ?? null;
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

    if (hasHost) {
      if (liveConfig.server.hostFromEnv) {
        throw new ValidationError('host comes from the TML_HOST environment variable — change it there instead of config.json', {
          code: 'CONFIG_FROM_ENV',
          status: 409,
          details: { field: 'host' },
        });
      }
      if (typeof patch.host !== 'string' || patch.host.trim() === '') {
        throw new ValidationError('Field "host" must be a non-empty string', {
          code: 'INVALID_HOST',
          details: { field: 'host' },
        });
      }
      next.host = patch.host.trim();
      if (next.host !== liveConfig.server.host) changedFields.push('host');
    }

    if (hasPort) {
      if (liveConfig.server.portFromEnv) {
        throw new ValidationError('port comes from the TML_PORT environment variable — change it there instead of config.json', {
          code: 'CONFIG_FROM_ENV',
          status: 409,
          details: { field: 'port' },
        });
      }
      const port = typeof patch.port === 'string' ? Number(patch.port.trim()) : patch.port;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new ValidationError('Field "port" must be an integer between 0 and 65535', {
          code: 'INVALID_PORT',
          details: { field: 'port' },
        });
      }
      next.port = port;
      if (next.port !== liveConfig.server.port) changedFields.push('port');
    }

    if (hasLog) {
      if (liveConfig.log.fromEnv) {
        throw new ValidationError('log comes from the TML_LOG_LEVEL environment variable — change it there instead of config.json', {
          code: 'CONFIG_FROM_ENV',
          status: 409,
          details: { field: 'log' },
        });
      }
      const level = typeof patch.log === 'string' ? patch.log.trim().toLowerCase() : patch.log;
      if (!LOG_LEVEL_SET.has(level)) {
        throw new ValidationError(`Field "log" must be one of: ${LOG_LEVEL_VALUES.join(', ')}`, {
          code: 'INVALID_LOG_LEVEL',
          details: { field: 'log' },
        });
      }
      next.level = level;
      if (next.level !== liveConfig.log.level) changedFields.push('log');
    }

    if (hasJava) {
      nextJava = patch.java === null ? null : validateRuntimeName(patch.java);
      if (nextJava !== (liveConfig.java?.runtime ?? null)) changedFields.push('java');
    }

    if (hasOfflineName) {
      const raw = patch.offlineName;
      if (raw !== null && typeof raw !== 'string') {
        throw new ValidationError('Field "offlineName" must be a string or null', {
          code: 'INVALID_OFFLINE_NAME',
          details: { field: 'offlineName' },
        });
      }
      const value = raw === null ? null : raw.trim();
      if (value !== null && !OFFLINE_NAME_PATTERN.test(value)) {
        throw new ValidationError('Field "offlineName" must be 3–16 characters of a–z, A–Z, 0–9 or "_"', {
          code: 'INVALID_OFFLINE_NAME',
          details: { field: 'offlineName' },
        });
      }
      nextOfflineName = value;
      if (nextOfflineName !== (liveConfig.auth?.offlineName ?? null)) changedFields.push('offlineName');
    }

    if (nextDataDir !== null) changedFields.push('dataDir');

    const saved = changedFields.length > 0;
    const restartRequired = [];
    if (changedFields.includes('host') || changedFields.includes('port')) restartRequired.push('server');
    if (changedFields.includes('dataDir')) restartRequired.push('dataDir');
    if (changedFields.includes('log')) logger.setLevel(next.level);
    if (changedFields.includes('java') && typeof java?.setChosen === 'function') java.setChosen(nextJava);

    liveConfig = {
      ...liveConfig,
      server: { ...liveConfig.server, host: next.host, port: next.port },
      log: { ...liveConfig.log, level: next.level },
      java: { ...(liveConfig.java ?? {}), runtime: nextJava },
      auth: {
        ...(liveConfig.auth ?? {}),
        offlineName: nextOfflineName,
      },
    };

    if (saved) {
      const current = await readJson(config.paths.configFile, { optional: true });
      const base = isPlainObject(current) ? current : {};
      const nextFile = { ...base };
      if (changedFields.includes('host')) nextFile.host = next.host;
      if (changedFields.includes('port')) nextFile.port = next.port;
      if (changedFields.includes('log')) nextFile.log = next.level;
      if (changedFields.includes('java')) nextFile.java = nextJava;
      if (changedFields.includes('offlineName')) {
        if (nextOfflineName === null) delete nextFile.offlineName;
        else nextFile.offlineName = nextOfflineName;
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
    return { body: { saved, changed: changedFields, restartRequired, config: view } };
  });

  router.get('/api/routes', () => ({
    body: { routes: router.list() },
  }));

  router.get('/api/sources', () => ({
    body: {
      version: VERSION,
      rules: {
        protocols: ['https:'],
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
