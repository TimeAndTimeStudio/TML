// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fsp from 'node:fs/promises';
import {
  CorruptDataError,
  InstanceError,
  NotFoundError,
  ValidationError,
} from '../core/errors.js';
import { pathExists, readJson, removePath, writeJson } from '../core/filesystem.js';
import { generateInstanceId, createInstance } from './create.js';
import { resolveInstancePaths } from './isolation.js';
import { resolveLaunchVersion } from './launch.js';
import { validateInstanceMeta, validateInstanceName, validateInstanceId } from './validate.js';

function notFound(id) {
  return new NotFoundError(`Instance not found: ${id}`, {
    code: 'INSTANCE_NOT_FOUND',
    details: { id },
  });
}

const PATCHABLE_FIELDS = Object.freeze([
  'name',
  'java',
  'memory',
  'extraJvmArgs',
  'extraGameArgs',
  'minecraftVersion',
  'port',
  'eulaAccepted',
]);

export function createInstanceManager(options = {}) {
  const config = options.config ?? null;
  const instancesDir = options.instancesDir ?? config?.paths?.instancesDir ?? null;
  if (typeof instancesDir !== 'string' || instancesDir === '') {
    throw new ValidationError('"instancesDir" must be a non-empty path', {
      code: 'INVALID_INSTANCES_DIR',
    });
  }
  const logger = options.logger ?? null;
  const installer = options.installer ?? null;
  const launcher = options.launcher ?? null;
  const fabric = options.fabric ?? null;

  const running = new Map();
  const runningSince = new Map();
  const launchProgress = new Map();
  let playtimeQueue = Promise.resolve();

  function paths(id) {
    return resolveInstancePaths(instancesDir, id);
  }

  async function readMeta(id) {
    validateInstanceId(id);
    const { metaFile } = paths(id);
    if (!(await pathExists(metaFile))) throw notFound(id);
    let raw;
    try {
      raw = await readJson(metaFile);
    } catch (err) {
      if (err instanceof CorruptDataError) {
        throw new InstanceError(`Instance metadata is corrupt: ${id}`, {
          code: 'INSTANCE_CORRUPT',
          cause: err,
          details: { stage: 'read', id, file: metaFile },
        });
      }
      throw err;
    }
    try {
      return validateInstanceMeta(raw);
    } catch (err) {
      throw new InstanceError(`Instance metadata is invalid: ${id}`, {
        code: 'INSTANCE_INVALID',
        cause: err,
        details: { stage: 'read', id, file: metaFile },
      });
    }
  }

  async function create(createOptions) {
    const meta = await createInstance({ instancesDir, ...createOptions });
    logger?.info('instance created', { id: meta.id, name: meta.name });
    return meta;
  }

  async function get(id) {
    return readMeta(id);
  }

  async function list() {
    let entries;
    try {
      entries = await fsp.readdir(instancesDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }

    const metas = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        metas.push(await readMeta(entry.name));
      } catch (err) {
        logger?.warn('skipping invalid instance', { id: entry.name, code: err.code ?? null });
      }
    }
    metas.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return metas;
  }

  async function rename(id, newName) {
    const meta = await readMeta(id);
    const name = validateInstanceName(newName);
    if (name === meta.name) return meta;
    const updated = validateInstanceMeta({ ...meta, name });
    await writeJson(paths(id).metaFile, updated);
    logger?.debug('instance renamed', { id, name });
    return updated;
  }

  async function update(id, patch) {
    const meta = await readMeta(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ValidationError('Instance settings patch must be an object', {
        code: 'INVALID_INSTANCE_PATCH',
        details: { received: Array.isArray(patch) ? 'array' : typeof patch },
      });
    }
    const unknown = Object.keys(patch).filter((key) => !PATCHABLE_FIELDS.includes(key));
    if (unknown.length > 0) {
      throw new ValidationError(`Field ${JSON.stringify(unknown[0])} cannot be updated`, {
        code: 'FIELD_NOT_ALLOWED',
        details: { field: unknown[0], allowed: [...PATCHABLE_FIELDS] },
      });
    }
    const next = { ...meta };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.java !== undefined) next.java = patch.java;
    if (patch.memory !== undefined) next.memory = patch.memory;
    if (patch.extraJvmArgs !== undefined) next.extraJvmArgs = patch.extraJvmArgs;
    if (patch.extraGameArgs !== undefined) next.extraGameArgs = patch.extraGameArgs;
    if (patch.port !== undefined) next.port = patch.port;
    if (patch.eulaAccepted !== undefined) next.eulaAccepted = patch.eulaAccepted;
    if (patch.minecraftVersion !== undefined) {
      // เปลี่ยนเวอร์ชั่น → จำเวอร์ชั่นก่อนหน้าไว้ให้ UI ย้อนกลับได้ (previousMinecraftVersion ไม่ใช่ field ที่ client ส่งเอง)
      if (patch.minecraftVersion !== meta.minecraftVersion) {
        next.previousMinecraftVersion = meta.minecraftVersion;
      }
      next.minecraftVersion = patch.minecraftVersion;
    }
    const updated = validateInstanceMeta(next);
    const changed =
      updated.name !== meta.name ||
      updated.java !== meta.java ||
      updated.minecraftVersion !== meta.minecraftVersion ||
      updated.previousMinecraftVersion !== (meta.previousMinecraftVersion ?? null) ||
      updated.port !== meta.port ||
      updated.eulaAccepted !== meta.eulaAccepted ||
      JSON.stringify(updated.memory) !== JSON.stringify(meta.memory) ||
      JSON.stringify(updated.extraJvmArgs) !== JSON.stringify(meta.extraJvmArgs ?? []) ||
      JSON.stringify(updated.extraGameArgs) !== JSON.stringify(meta.extraGameArgs ?? []);
    if (!changed) return meta;
    await writeJson(paths(id).metaFile, updated);
    logger?.debug('instance settings updated', { id, fields: Object.keys(patch) });
    return updated;
  }

  async function duplicate(id, options = {}) {
    const meta = await readMeta(id);
    const newId = options.id ?? generateInstanceId();
    validateInstanceId(newId);

    const src = paths(id);
    const dst = paths(newId);
    if (await pathExists(dst.dir)) {
      throw new InstanceError(`Instance already exists: ${newId}`, {
        code: 'INSTANCE_EXISTS',
        status: 409,
        details: { stage: 'duplicate', id: newId },
      });
    }

    const fallbackCopyName =
      meta.name.length + 7 <= 80 ? `${meta.name} (copy)` : `${meta.name.slice(0, 73)} (copy)`;
    const name = options.name === undefined ? fallbackCopyName : validateInstanceName(options.name);
    const newMeta = validateInstanceMeta({ ...meta, id: newId, name });

    await fsp.mkdir(dst.dir, { recursive: true });
    try {
      await fsp.cp(src.gameDir, dst.gameDir, { recursive: true, dereference: true, force: false, errorOnExist: true });
      await writeJson(dst.metaFile, newMeta);
    } catch (err) {
      await removePath(dst.dir).catch(() => {});
      throw err;
    }

    logger?.info('instance duplicated', { from: meta.id, id: newId });
    return newMeta;
  }

  async function remove(id) {
    validateInstanceId(id);
    if (running.has(id)) {
      throw new InstanceError(`Instance is running: ${id}`, {
        code: 'INSTANCE_RUNNING',
        status: 409,
        details: { stage: 'delete', id, pid: running.get(id).pid ?? null },
      });
    }
    const { dir, metaFile } = paths(id);
    if (!(await pathExists(metaFile))) throw notFound(id);
    await removePath(dir);
    logger?.info('instance deleted', { id });
    return { id, deleted: true };
  }

  async function launch(id, opts = {}) {
    const meta = await readMeta(id);
    const existing = running.get(id);
    if (existing) {
      throw new InstanceError(`Instance is already running: ${id}`, {
        code: 'INSTANCE_ALREADY_RUNNING',
        status: 409,
        details: { stage: 'launch', id, pid: existing.pid ?? null },
      });
    }
    if (!launcher || typeof launcher.launch !== 'function') {
      throw new ValidationError('createInstanceManager() requires a launcher to launch', {
        code: 'NO_LAUNCHER',
        details: { id },
      });
    }

    const progress = { instanceId: id, stage: 'resolve', percent: 0, loaded: 0, total: 0 };
    const report = (info) => {
      if (!info || typeof info !== 'object') return;
      if (typeof info.stage === 'string' && info.stage !== '') progress.stage = info.stage;
      if (Number.isFinite(info.loaded)) progress.loaded = info.loaded;
      if (Number.isFinite(info.total)) progress.total = info.total;
      if (Number.isFinite(info.percent)) progress.percent = info.percent;
    };
    launchProgress.set(id, progress);

    try {
      const resolved = await resolveLaunchVersion(meta, { fabric, logger });
      const { gameDir } = paths(id);

      if (installer && typeof installer.status === 'function') {
        const state = await installer.status(resolved.version);
        if (state?.ready !== true) {
          if (typeof installer.install !== 'function') {
            throw new ValidationError('Installer cannot install missing files', {
              code: 'NO_INSTALLER',
              details: { id, version: resolved.id },
            });
          }
          logger?.info('installing instance version', { id, version: resolved.id });
          await installer.install(resolved.version, { force: false, onProgress: report });
        }
      }

      const handle = await launcher.launch(resolved.version, {
        gameDir,
        auth: opts.auth,
        features: opts.features,
        resolution: opts.resolution,
        signal: opts.signal,
        onOutput: opts.onOutput,
        onProgress: report,
        extraJvmArgs: meta.extraJvmArgs ?? [],
        extraGameArgs: meta.extraGameArgs ?? [],
      });
      report({ stage: 'spawn', percent: 100 });

      running.set(id, handle);
      const startedAt = Date.now();
      runningSince.set(id, startedAt);
      const release = () => {
        if (running.get(id) === handle) running.delete(id);
        if (runningSince.get(id) === startedAt) runningSince.delete(id);
      };
      const recordSession = () => {
        const job = () => recordPlaytime(id, startedAt);
        playtimeQueue = playtimeQueue.then(job, job);
      };
      handle.exited.then(
        () => {
          release();
          recordSession();
        },
        () => {
          release();
          recordSession();
        }
      );

      logger?.info('instance launched', {
        id,
        pid: handle.pid,
        version: resolved.id,
        source: resolved.source,
        gameDir,
      });

      return {
        id,
        pid: handle.pid,
        version: resolved.id,
        source: resolved.source,
        gameDir,
        handle,
      };
    } finally {
      launchProgress.delete(id);
    }
  }

  function getLaunchProgress(id) {
    validateInstanceId(id);
    const entry = launchProgress.get(id);
    if (!entry) {
      return { instanceId: id, launching: false, stage: 'idle', percent: 0, loaded: 0, total: 0 };
    }
    return { launching: true, ...entry };
  }

  async function stop(id, signal = 'SIGTERM') {
    validateInstanceId(id);
    const handle = running.get(id);
    if (!handle) {
      throw new NotFoundError(`Instance is not running: ${id}`, {
        code: 'INSTANCE_NOT_RUNNING',
        details: { id },
      });
    }
    handle.kill(signal);
    const result = await handle.exited;
    await playtimeQueue;
    logger?.info('instance stopped', { id, code: result?.code ?? null, signal: result?.signal ?? null });
    return { id, stopped: true, ...result };
  }

  async function recordPlaytime(id, startedAt) {
    try {
      const meta = await readMeta(id);
      const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      const updated = validateInstanceMeta({
        ...meta,
        playSeconds: (meta.playSeconds ?? 0) + elapsed,
        lastPlayedAt: new Date().toISOString(),
      });
      await writeJson(paths(id).metaFile, updated);
      logger?.debug('playtime recorded', { id, seconds: elapsed });
    } catch (err) {
      logger?.warn('failed to record playtime', { id, code: err?.code ?? null });
    }
  }

  function status(id) {
    validateInstanceId(id);
    const handle = running.get(id) ?? null;
    const startedAt = runningSince.get(id) ?? null;
    const sessionSeconds =
      handle !== null && startedAt !== null ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
    return {
      id,
      running: handle !== null,
      pid: handle?.pid ?? null,
      sessionSeconds,
    };
  }

  return {
    create,
    get,
    list,
    rename,
    update,
    duplicate,
    delete: remove,
    launch,
    getLaunchProgress,
    stop,
    status,
    paths,
  };
}
