// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fsp from 'node:fs/promises';
import path from 'node:path';
import { InstanceError, ValidationError } from '../core/errors.js';
import { ensureDir, pathExists, resolveWithin } from '../core/filesystem.js';
import { hashFile } from '../download/hash.js';
import { assertExportableMeta, sanitizeExportName } from '../instance/export.js';
import { readModRegistry } from '../mods/registry.js';

export const MODPACK_INDEX_FILE = 'modrinth.index.json';
export const MODPACK_FORMAT_VERSION = 1;
export const MODPACK_FILENAME_SUFFIX = '-modpack';

function invalid(message, code, details = {}) {
  return new ValidationError(message, { code, details });
}

export function buildModpackIndex({ meta, mods, registry }) {
  assertExportableMeta(meta);

  const files = mods
    .map((mod) => {
      const record = registry[mod.filename] ?? null;
      const downloads = record?.url ? [record.url] : [];
      return {
        path: `mods/${mod.filename}`,
        hashes: { sha1: mod.sha1, sha512: mod.sha512 },
        fileSize: mod.size,
        downloads,
        env: { client: 'required', server: 'unsupported' },
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return Object.freeze({
    formatVersion: MODPACK_FORMAT_VERSION,
    game: 'minecraft',
    versionId: meta.id,
    name: meta.name,
    files: Object.freeze(files.map((file) => Object.freeze({ ...file, hashes: Object.freeze(file.hashes), env: Object.freeze(file.env) }))),
    dependencies: Object.freeze({
      minecraft: meta.minecraftVersion,
      'fabric-loader': meta.fabricLoaderVersion,
    }),
  });
}

function serializeIndex(index) {
  return `${JSON.stringify(index, null, 2)}\n`;
}

export function createModpackExporter(options = {}) {
  const manager = options.manager ?? null;
  const writeZip = options.writeZip ?? null;
  const exportsDir = options.exportsDir ?? null;
  const logger = options.logger ?? null;

  if (!manager || typeof manager.get !== 'function' || typeof manager.paths !== 'function' || typeof manager.status !== 'function') {
    throw invalid('createModpackExporter requires an instance manager with get(), paths() and status()', 'INVALID_INSTANCE_MANAGER');
  }
  if (typeof writeZip !== 'function') {
    throw invalid('createModpackExporter requires a zip writer function', 'NO_ZIP_WRITER');
  }
  if (typeof exportsDir !== 'string' || exportsDir === '') {
    throw invalid('createModpackExporter requires an exports directory', 'INVALID_EXPORTS_DIR');
  }

  async function plan(instanceId) {
    const meta = await manager.get(instanceId);
    const paths = manager.paths(instanceId);

    let registry;
    try {
      registry = await readModRegistry(paths.dir);
    } catch (err) {
      logger?.warn('mod registry unreadable, exporting without download urls', {
        instanceId,
        code: err?.code ?? null,
      });
      registry = {};
    }

    let dirents = [];
    try {
      dirents = await fsp.readdir(paths.modsDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }

    const mods = [];
    for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!dirent.isFile()) continue;
      const file = path.join(paths.modsDir, dirent.name);
      const hashes = await hashFile(file, ['sha1', 'sha512']);
      const stat = await fsp.stat(file);
      mods.push({ filename: dirent.name, file, size: stat.size, sha1: hashes.sha1, sha512: hashes.sha512 });
    }

    const index = buildModpackIndex({ meta, mods, registry });
    const indexData = Buffer.from(serializeIndex(index), 'utf8');

    const entries = [
      { name: MODPACK_INDEX_FILE, src: null, data: indexData, dir: false, size: indexData.length },
      ...mods.map((mod) => ({ name: `mods/${mod.filename}`, src: mod.file, data: null, dir: false, size: mod.size })),
    ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return Object.freeze({
      instanceId,
      name: meta.name,
      index,
      entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
      modCount: mods.length,
      fileCount: entries.length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    });
  }

  async function exportModpack(instanceId, exportOptions = {}) {
    const exportPlan = await plan(instanceId);

    if (exportOptions.name !== undefined && typeof exportOptions.name !== 'string') {
      throw invalid('"name" must be a string', 'INVALID_EXPORT_NAME');
    }
    if (manager.status(instanceId).running) {
      throw new InstanceError(`Instance is running: ${instanceId}`, {
        code: 'INSTANCE_RUNNING',
        status: 409,
        details: { stage: 'modpack-export', id: instanceId },
      });
    }

    const base = sanitizeExportName(exportOptions.name ?? exportPlan.name) ?? instanceId;
    const filename = `${base}${MODPACK_FILENAME_SUFFIX}.zip`;
    const dest = resolveWithin(exportsDir, filename);

    if (exportOptions.force !== true && (await pathExists(dest))) {
      throw new InstanceError(`Modpack export already exists: ${filename}`, {
        code: 'MODPACK_EXISTS',
        status: 409,
        details: { id: instanceId, filename },
      });
    }

    await ensureDir(exportsDir);
    const zipEntries = exportPlan.entries.map((entry) => (entry.data ? { name: entry.name, data: entry.data } : { name: entry.name, file: entry.src }));
    const result = await writeZip(zipEntries, dest, { signal: exportOptions.signal ?? null });
    const hashes = await hashFile(dest, ['sha1']);

    logger?.info('modpack exported', {
      id: instanceId,
      filename,
      mods: exportPlan.modCount,
      bytes: result.bytes,
    });

    return Object.freeze({
      instanceId,
      name: exportPlan.name,
      filename,
      path: dest,
      sha1: hashes.sha1,
      bytes: result.bytes,
      mods: exportPlan.modCount,
      files: exportPlan.fileCount,
    });
  }

  return { plan, export: exportModpack };
}
