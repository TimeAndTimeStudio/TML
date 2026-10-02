// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fsp from 'node:fs/promises';
import path from 'node:path';
import { ValidationError } from '../core/errors.js';
import { ensureDir, pathExists, resolveWithin } from '../core/filesystem.js';
import { validateUrl } from '../security/urls.js';
import { downloadToFile } from '../download/downloader.js';
import { hashFile } from '../download/hash.js';
import { createModrinthApi } from '../modrinth/api.js';
import { forgetInstalledMod, recordInstalledMods } from './registry.js';

export const MOD_FILENAME_MAX_LENGTH = 200;
export const PACK_KINDS = ['mods', 'resourcepacks', 'shaderpacks'];

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export function safeModFilename(filename) {
  if (typeof filename !== 'string' || filename === '') {
    throw new ValidationError('Mod filename must be a non-empty string', {
      code: 'INVALID_MOD_FILENAME',
      details: { filename: typeof filename === 'string' ? filename : typeof filename },
    });
  }
  if (
    filename.length > MOD_FILENAME_MAX_LENGTH
    || filename === '.'
    || filename === '..'
    || filename.includes('/')
    || filename.includes('\\')
    || CONTROL_CHARS_RE.test(filename)
  ) {
    throw new ValidationError(`Unsafe mod filename: ${JSON.stringify(filename)}`, {
      code: 'INVALID_MOD_FILENAME',
      details: { filename },
    });
  }
  return filename;
}

export function pickModFiles(version) {
  const files = Array.isArray(version?.files) ? version.files : [];
  const primary = files.filter((file) => file.primary === true);
  return primary.length > 0 ? primary : files.slice(0, 1);
}

async function fileMatches(dest, file) {
  try {
    const stats = await fsp.stat(dest);
    if (!stats.isFile()) return false;
    if (typeof file.size === 'number' && stats.size !== file.size) return false;
    const algorithms = file.sha1 ? ['sha1'] : ['sha512'];
    const hashes = await hashFile(dest, algorithms);
    const expected = (file.sha1 ? file.sha1 : file.sha512).toLowerCase();
    return String(hashes[algorithms[0]]).toLowerCase() === expected;
  } catch {
    return false;
  }
}

export function normalizePackKind(kind) {
  if (kind === undefined || kind === null || kind === '') return 'mods';
  if (!PACK_KINDS.includes(kind)) {
    throw new ValidationError(`Unknown pack kind: ${JSON.stringify(kind)}`, {
      code: 'INVALID_PACK_KIND',
      details: { field: 'kind', known: PACK_KINDS },
    });
  }
  return kind;
}

export function createModInstaller(options = {}) {
  const manager = options.manager ?? null;
  const modrinth = options.modrinth ?? null;
  const logger = options.logger ?? null;
  const validator = options.validator ?? validateUrl;
  const http = options.http ?? null;
  const retries = options.retries ?? undefined;

  if (!manager || typeof manager.get !== 'function' || typeof manager.paths !== 'function') {
    throw new ValidationError('createModInstaller requires an instance manager', {
      code: 'INVALID_INSTANCE_MANAGER',
    });
  }
  if (modrinth !== null && typeof modrinth.getVersion !== 'function') {
    throw new ValidationError('createModInstaller requires a Modrinth API with getVersion()', {
      code: 'INVALID_MODRINTH_API',
    });
  }

  const modrinthApi = modrinth ?? createModrinthApi(http ? { client: http } : {});

  function dirOf(instanceId, kind = 'mods') {
    const normalized = normalizePackKind(kind);
    if (normalized === 'mods') return manager.paths(instanceId).modsDir;
    return path.join(manager.paths(instanceId).gameDir, normalized);
  }

  async function install(instanceId, versionId, { force = false, signal = null, onProgress = null, kind = 'mods' } = {}) {
    const packKind = normalizePackKind(kind);
    await manager.get(instanceId);
    const version = await modrinthApi.getVersion(versionId);
    const files = pickModFiles(version);
    if (files.length === 0) {
      throw new ValidationError(`Modrinth version "${version.id}" has no files`, {
        code: 'MOD_VERSION_NO_FILES',
        details: { versionId: version.id },
      });
    }

    const targetDir = dirOf(instanceId, packKind);
    await ensureDir(targetDir);

    const results = [];
    for (const file of files) {
      const filename = safeModFilename(file.filename);
      const dest = resolveWithin(targetDir, filename);
      const outcome = await downloadToFile({
        id: `mod:${version.id}:${filename}`,
        url: file.url,
        dest,
        source: 'modrinth',
        sha1: file.sha1,
        sha512: file.sha512,
        size: file.size,
        force,
        validator,
        signal,
        onProgress,
        logger,
        retries,
      });
      results.push({
        filename,
        path: dest,
        bytes: outcome.bytes,
        cached: outcome.cached === true,
        sha1: file.sha1,
        sha512: file.sha512,
      });
    }

    const skipped = !force && results.every((result) => result.cached);
    if (packKind === 'mods') {
      await recordInstalledMods(
        manager.paths(instanceId).dir,
        version,
        results.map((result, index) => ({ ...result, url: files[index]?.url ?? null })),
      );
    }
    logger?.info('pack file installed', {
      instanceId,
      kind: packKind,
      projectId: version.projectId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      files: results.map((result) => result.filename),
      skipped,
    });

    return {
      instanceId,
      kind: packKind,
      projectId: version.projectId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      files: results,
      installed: true,
      skipped,
    };
  }

  async function status(instanceId, versionId, { kind = 'mods' } = {}) {
    const packKind = normalizePackKind(kind);
    await manager.get(instanceId);
    const version = await modrinthApi.getVersion(versionId);
    const targetDir = dirOf(instanceId, packKind);

    const files = [];
    for (const file of pickModFiles(version)) {
      const filename = safeModFilename(file.filename);
      const dest = resolveWithin(targetDir, filename);
      const present = await pathExists(dest);
      files.push({
        filename,
        path: dest,
        present,
        verified: present ? await fileMatches(dest, file) : false,
      });
    }

    return {
      instanceId,
      projectId: version.projectId,
      versionId: version.id,
      files,
      installed: files.length > 0 && files.every((file) => file.verified),
    };
  }

  async function list(instanceId, { kind = 'mods' } = {}) {
    const packKind = normalizePackKind(kind);
    await manager.get(instanceId);
    const targetDir = dirOf(instanceId, packKind);
    let entries;
    try {
      entries = await fsp.readdir(targetDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }

    const packs = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.')) continue;
      const full = resolveWithin(targetDir, entry.name);
      try {
        const stats = await fsp.stat(full);
        packs.push({ filename: entry.name, path: full, size: stats.size });
      } catch {
        continue;
      }
    }
    packs.sort((a, b) => a.filename.localeCompare(b.filename));
    return packs;
  }

  return {
    install,
    status,
    list,
    async remove(instanceId, modId, { kind = 'mods' } = {}) {
      const packKind = normalizePackKind(kind);
      await manager.get(instanceId);
      const filename = safeModFilename(modId);
      const dest = resolveWithin(dirOf(instanceId, packKind), filename);
      if (!(await pathExists(dest))) {
        throw new ValidationError(`Mod not found in instance: ${filename}`, {
          code: packKind === 'mods' ? 'MOD_NOT_FOUND' : 'PACK_FILE_NOT_FOUND',
          status: 404,
          details: { instanceId, filename, kind: packKind },
        });
      }
      await fsp.rm(dest, { force: true });
      if (packKind === 'mods') await forgetInstalledMod(manager.paths(instanceId).dir, filename);
      logger?.info('pack file removed', { instanceId, kind: packKind, filename });
      return { instanceId, kind: packKind, filename, removed: true };
    },
  };
}
