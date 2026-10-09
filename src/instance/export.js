// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fsp from 'node:fs/promises';
import path from 'node:path';
import { InstanceError, ValidationError } from '../core/errors.js';
import { ensureDir, pathExists, resolveWithin } from '../core/filesystem.js';
import { hashFile } from '../download/hash.js';
import { safeVersionId } from '../minecraft/versions.js';
import { findInstanceIcon } from './icon.js';
import { SUPPORTED_LOADER, validateInstanceName } from './validate.js';

export const EXPORT_INSTANCE_FILE = 'instance.json';
export const EXPORT_GAME_DIRS = Object.freeze(['mods', 'config', 'saves', 'resourcepacks', 'shaderpacks']);
export const EXPORT_GAME_FILES = Object.freeze(['options.txt']);
// server instance → เอาเฉพาะไฟล์ที่ server ใช้จริง (world + server.properties + eula) ไม่เอา saves/resourcepacks ของ client
export const EXPORT_SERVER_GAME_DIRS = Object.freeze(['mods', 'config', 'world']);
export const EXPORT_SERVER_GAME_FILES = Object.freeze(['server.properties', 'eula.txt']);
export const EXPORT_TYPES = Object.freeze(['client', 'server']);
export const EXPORT_MAX_NAME_LENGTH = 150;
export const EXPORT_FORBIDDEN_KEY_PATTERN = /(token|secret|password|credential|authorization|cookie|api[_-]?key|session)/i;

export function assertExportableMeta(meta) {
  const found = [];
  const walk = (value, keyPath) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${keyPath}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const full = keyPath === '' ? key : `${keyPath}.${key}`;
      if (EXPORT_FORBIDDEN_KEY_PATTERN.test(key)) found.push(full);
      walk(child, full);
    }
  };
  walk(meta, '');
  if (found.length > 0) {
    throw new InstanceError('Refusing to export instance metadata containing secret fields', {
      code: 'EXPORT_FORBIDDEN_DATA',
      details: { keys: found },
    });
  }
  return meta;
}

function manifestInvalid(field, reason, details = {}) {
  return new ValidationError(`Export manifest has an invalid "${field}": ${reason}`, {
    code: 'EXPORT_MANIFEST_INVALID',
    details: { field, ...details },
  });
}

export function validateExportManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('Export manifest must be an object', {
      code: 'EXPORT_MANIFEST_INVALID',
      details: { field: 'manifest', received: raw === null ? 'null' : typeof raw },
    });
  }
  let name;
  try {
    name = validateInstanceName(raw.name);
  } catch (err) {
    throw manifestInvalid('name', 'must be a valid instance name', { cause: err.code ?? null });
  }

  let minecraftVersion;
  try {
    minecraftVersion = safeVersionId(raw.minecraftVersion);
  } catch (err) {
    throw manifestInvalid('minecraftVersion', 'must be a valid Minecraft version id', { cause: err.code ?? null });
  }

  if (raw.loader !== SUPPORTED_LOADER) {
    throw manifestInvalid('loader', `only "${SUPPORTED_LOADER}" is supported`, { loader: typeof raw.loader === 'string' ? raw.loader : typeof raw.loader });
  }

  let fabricLoaderVersion;
  try {
    fabricLoaderVersion = safeVersionId(raw.fabricLoaderVersion);
  } catch (err) {
    throw manifestInvalid('fabricLoaderVersion', 'must be a valid Fabric loader version', { cause: err.code ?? null });
  }

  // เวอร์ชั่นเก่าไม่มี type → ถือเป็น client เสมอ
  const type = raw.type === undefined || raw.type === null ? 'client' : raw.type;
  if (!EXPORT_TYPES.includes(type)) {
    throw manifestInvalid('type', `must be one of: ${EXPORT_TYPES.join(', ')}`, { type: typeof type === 'string' ? type : typeof type });
  }

  return Object.freeze({ name, minecraftVersion, loader: raw.loader, fabricLoaderVersion, type });
}

export function buildExportManifest(meta) {
  assertExportableMeta(meta);
  return validateExportManifest({
    name: meta.name,
    minecraftVersion: meta.minecraftVersion,
    loader: meta.loader,
    fabricLoaderVersion: meta.fabricLoaderVersion,
    type: meta.type ?? 'client',
  });
}

export function serializeExportManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function sanitizeExportName(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, EXPORT_MAX_NAME_LENGTH)
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned === '' ? null : cleaned;
}

function compareNames(a, b) {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

export function createInstanceExporter(options = {}) {
  const manager = options.manager ?? null;
  const writeZip = options.writeZip ?? null;
  const exportsDir = options.exportsDir ?? null;
  const logger = options.logger ?? null;

  if (!manager || typeof manager.get !== 'function' || typeof manager.paths !== 'function' || typeof manager.status !== 'function') {
    throw new ValidationError('createInstanceExporter requires an instance manager with get(), paths() and status()', {
      code: 'INVALID_INSTANCE_MANAGER',
    });
  }
  if (typeof writeZip !== 'function') {
    throw new ValidationError('createInstanceExporter requires a zip writer function', {
      code: 'NO_ZIP_WRITER',
    });
  }
  if (typeof exportsDir !== 'string' || exportsDir === '') {
    throw new ValidationError('createInstanceExporter requires an exports directory', {
      code: 'INVALID_EXPORTS_DIR',
    });
  }

  async function collectDir(gameDir, srcRel, entries, skipped, instanceId) {
    const zipRel = `minecraft/${srcRel}`;
    const abs = path.join(gameDir, srcRel);

    let dirents;
    try {
      dirents = await fsp.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }

    entries.push({ name: `${zipRel}/`, src: null, dir: true, size: 0 });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const dirent of dirents) {
      const childSrcRel = `${srcRel}/${dirent.name}`;
      const childZipRel = `minecraft/${childSrcRel}`;

      if (dirent.isSymbolicLink()) {
        skipped.push({ name: childZipRel, reason: 'symlink' });
        logger?.warn('skipping symlink during export', { instanceId, entry: childZipRel });
        continue;
      }
      if (dirent.isDirectory()) {
        await collectDir(gameDir, childSrcRel, entries, skipped, instanceId);
        continue;
      }
      if (!dirent.isFile()) {
        skipped.push({ name: childZipRel, reason: 'unsupported' });
        logger?.warn('skipping special file during export', { instanceId, entry: childZipRel });
        continue;
      }

      const stat = await fsp.stat(path.join(gameDir, childSrcRel));
      entries.push({ name: childZipRel, src: path.join(gameDir, childSrcRel), dir: false, size: stat.size });
    }
  }

  async function plan(instanceId) {
    const meta = await manager.get(instanceId);
    const manifest = buildExportManifest(meta);
    const manifestData = Buffer.from(serializeExportManifest(manifest), 'utf8');
    const paths = manager.paths(instanceId);

    const entries = [];
    const skipped = [];

    entries.push({ name: EXPORT_INSTANCE_FILE, src: null, data: manifestData, dir: false, size: manifestData.length });

    // ไอคอน custom ของ instance (icon.<ext> ชั้นบนสุด) — ให้ import กลับมาได้ครบ
    const iconName = await findInstanceIcon(paths.dir);
    if (iconName !== null) {
      const src = path.join(paths.dir, iconName);
      try {
        const stat = await fsp.stat(src);
        if (stat.isFile()) entries.push({ name: iconName, src, dir: false, size: stat.size });
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }

    if (await pathExists(paths.gameDir)) {
      entries.push({ name: 'minecraft/', src: null, dir: true, size: 0 });
      const isServer = meta.type === 'server';
      const gameDirs = isServer ? EXPORT_SERVER_GAME_DIRS : EXPORT_GAME_DIRS;
      const gameFiles = isServer ? EXPORT_SERVER_GAME_FILES : EXPORT_GAME_FILES;
      for (const sub of gameDirs) {
        await collectDir(paths.gameDir, sub, entries, skipped, instanceId);
      }
      for (const file of gameFiles) {
        const src = path.join(paths.gameDir, file);
        try {
          const stat = await fsp.stat(src);
          if (stat.isFile()) {
            entries.push({ name: `minecraft/${file}`, src, dir: false, size: stat.size });
          }
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
          logger?.warn('exportable file missing, skipping', { instanceId, entry: `minecraft/${file}` });
        }
      }
    }

    entries.sort(compareNames);
    const fileCount = entries.filter((entry) => !entry.dir).length;
    const dirCount = entries.length - fileCount;
    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);

    return Object.freeze({
      instanceId,
      name: meta.name,
      manifest,
      instanceDir: paths.dir,
      entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
      skipped: Object.freeze(skipped.map((entry) => Object.freeze(entry))),
      fileCount,
      dirCount,
      totalBytes,
    });
  }

  async function exportInstance(instanceId, exportOptions = {}) {
    const exportPlan = await plan(instanceId);

    if (exportOptions.name !== undefined && typeof exportOptions.name !== 'string') {
      throw new ValidationError('"name" must be a string', { code: 'INVALID_EXPORT_NAME' });
    }
    let destDir = exportsDir;
    if (exportOptions.path !== undefined && exportOptions.path !== null) {
      if (typeof exportOptions.path !== 'string' || exportOptions.path.trim() === '') {
        throw new ValidationError('"path" must be a non-empty string', {
          code: 'INVALID_EXPORT_PATH',
          details: { field: 'path' },
        });
      }
      const rawPath = exportOptions.path.trim();
      if (!path.isAbsolute(rawPath)) {
        throw new ValidationError('"path" must be an absolute directory path', {
          code: 'INVALID_EXPORT_PATH',
          details: { field: 'path', path: rawPath },
        });
      }
      destDir = path.resolve(rawPath);
    }
    if (manager.status(instanceId).running) {
      throw new InstanceError(`Instance is running: ${instanceId}`, {
        code: 'INSTANCE_RUNNING',
        status: 409,
        details: { stage: 'export', id: instanceId },
      });
    }

    const defaultName = `${exportPlan.name}-${exportPlan.manifest.minecraftVersion}`;
    const base = sanitizeExportName(exportOptions.name ?? defaultName) ?? instanceId;
    const filename = `${base}.zip`;
    const dest = resolveWithin(destDir, filename);

    if (exportOptions.force !== true && (await pathExists(dest))) {
      throw new InstanceError(`Export already exists: ${filename}`, {
        code: 'EXPORT_EXISTS',
        status: 409,
        details: { id: instanceId, filename },
      });
    }

    try {
      await ensureDir(destDir);
    } catch (err) {
      throw new ValidationError(`Cannot create export directory: ${destDir}`, {
        code: 'INVALID_EXPORT_PATH',
        details: { field: 'path', path: destDir, cause: err?.code ?? null },
      });
    }
    const zipEntries = exportPlan.entries.map((entry) => {
      if (entry.dir) return { name: entry.name, dir: true };
      if (entry.data) return { name: entry.name, data: entry.data };
      return { name: entry.name, file: entry.src };
    });
    const result = await writeZip(zipEntries, dest, { signal: exportOptions.signal ?? null });
    const hashes = await hashFile(dest, ['sha1']);

    logger?.info('instance exported', {
      id: instanceId,
      filename,
      files: exportPlan.fileCount,
      bytes: result.bytes,
      skipped: exportPlan.skipped.length,
    });

    return Object.freeze({
      instanceId,
      name: exportPlan.name,
      filename,
      path: dest,
      sha1: hashes.sha1,
      bytes: result.bytes,
      files: exportPlan.fileCount,
      dirs: exportPlan.dirCount,
      skipped: exportPlan.skipped,
    });
  }

  return { plan, export: exportInstance };
}
