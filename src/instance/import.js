// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CancelledError, ValidationError } from '../core/errors.js';
import { ensureDir, pathExists, removePath, resolveWithin } from '../core/filesystem.js';
import { extractZip, listZipEntries, readZipEntry } from '../archive/unzip.js';
import { validateZipEntryName } from '../archive/zip.js';
import { EXPORT_INSTANCE_FILE, validateExportManifest } from './export.js';
import { validateInstanceId, validateInstanceName } from './validate.js';

export const IMPORT_MANIFEST_FILE = EXPORT_INSTANCE_FILE;
export const IMPORT_GAME_ROOT = 'minecraft/';

function invalid(message, code, details = {}) {
  return new ValidationError(message, { code, details });
}

function importZipError(file, err) {
  return new ValidationError(`Archive cannot be imported: ${file}`, {
    code: 'IMPORT_INVALID_ZIP',
    cause: err,
    details: { file, reason: err?.code ?? err?.name ?? 'unreadable' },
  });
}

async function movePath(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    await fsp.cp(src, dest, { recursive: true, force: true });
    await removePath(src);
  }
}

export function createInstanceImporter(options = {}) {
  const manager = options.manager ?? null;
  const listEntries = options.listZipEntries ?? listZipEntries;
  const readEntry = options.readZipEntry ?? readZipEntry;
  const extract = options.extractZip ?? extractZip;
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const logger = options.logger ?? null;

  if (!manager || typeof manager.create !== 'function' || typeof manager.paths !== 'function') {
    throw invalid('createInstanceImporter requires an instance manager with create() and paths()', 'INVALID_INSTANCE_MANAGER');
  }

  async function inspect(zipFile) {
    if (typeof zipFile !== 'string' || zipFile === '') {
      throw importZipError(String(zipFile), null);
    }

    let entries;
    try {
      entries = await listEntries(zipFile);
    } catch (err) {
      throw importZipError(zipFile, err);
    }

    const seen = new Set();
    let manifestEntry = null;
    for (const entry of entries) {
      const name = entry.normalized ?? entry.name;
      validateZipEntryName(entry.name, { dir: entry.isDirectory });
      if (seen.has(name)) {
        throw invalid(`Duplicate archive entry: ${name}`, 'ZIP_DUPLICATE_ENTRY', { entry: name });
      }
      seen.add(name);

      if (name === IMPORT_MANIFEST_FILE) {
        if (entry.isDirectory) {
          throw invalid('Manifest entry must be a file', 'IMPORT_NO_MANIFEST', { entry: name });
        }
        manifestEntry = entry;
        continue;
      }
      if (name !== IMPORT_GAME_ROOT && !name.startsWith(IMPORT_GAME_ROOT)) {
        throw invalid(`Archive entry outside the allowed layout: ${name}`, 'IMPORT_UNKNOWN_ENTRY', { entry: name });
      }
    }

    if (!manifestEntry) {
      throw invalid(`Archive is missing ${IMPORT_MANIFEST_FILE}`, 'IMPORT_NO_MANIFEST', { file: zipFile });
    }

    let manifestBytes;
    try {
      manifestBytes = await readEntry(zipFile, manifestEntry);
    } catch (err) {
      throw importZipError(zipFile, err);
    }

    let raw;
    try {
      raw = JSON.parse(manifestBytes.toString('utf8'));
    } catch (err) {
      throw invalid(`${IMPORT_MANIFEST_FILE} is not valid JSON`, 'IMPORT_NO_MANIFEST', { file: zipFile, reason: err?.message ?? null });
    }

    return { entries, manifest: validateExportManifest(raw) };
  }

  async function importInstance(zipFile, importOptions = {}) {
    if (importOptions.id !== undefined) validateInstanceId(importOptions.id);
    if (importOptions.name !== undefined) validateInstanceName(importOptions.name);

    const { entries, manifest } = await inspect(zipFile);
    const signal = importOptions.signal ?? null;
    if (signal?.aborted) throw new CancelledError('Import cancelled', { details: { file: zipFile } });

    const tempDir = await fsp.mkdtemp(path.join(tempRoot, 'tml-import-'));
    let created = false;
    let paths = null;

    try {
      for (const entry of entries) {
        if (!entry.isDirectory) continue;
        await ensureDir(resolveWithin(tempDir, entry.normalized ?? entry.name));
      }

      const { files: extracted } = await extract(zipFile, tempDir, { signal });

      const manifestFile = path.join(tempDir, IMPORT_MANIFEST_FILE);
      let verified;
      try {
        verified = validateExportManifest(JSON.parse(await fsp.readFile(manifestFile, 'utf8')));
      } catch (err) {
        throw invalid('Extracted manifest failed verification', 'IMPORT_NO_MANIFEST', { file: zipFile, reason: err?.code ?? err?.message ?? null });
      }
      if (JSON.stringify(verified) !== JSON.stringify(manifest)) {
        throw invalid('Extracted manifest does not match the archive listing', 'IMPORT_NO_MANIFEST', { file: zipFile });
      }

      const meta = await manager.create({
        id: importOptions.id,
        name: importOptions.name ?? manifest.name,
        minecraftVersion: manifest.minecraftVersion,
        loader: manifest.loader,
        fabricLoaderVersion: manifest.fabricLoaderVersion,
      });
      created = true;
      paths = manager.paths(meta.id);

      const stagedGame = path.join(tempDir, IMPORT_GAME_ROOT);
      if (await pathExists(stagedGame)) {
        for (const child of await fsp.readdir(stagedGame, { withFileTypes: true })) {
          await movePath(path.join(stagedGame, child.name), path.join(paths.gameDir, child.name));
        }
      }

      const content = extracted.filter((entry) => entry.name !== IMPORT_MANIFEST_FILE);
      logger?.info('instance imported', { id: meta.id, name: meta.name, files: content.length, source: zipFile });

      return Object.freeze({
        instanceId: meta.id,
        name: meta.name,
        manifest,
        dir: paths.dir,
        files: content.length,
        bytes: content.reduce((sum, entry) => sum + entry.bytes, 0),
      });
    } catch (err) {
      if (created && paths) await removePath(paths.dir).catch(() => {});
      throw err;
    } finally {
      await removePath(tempDir).catch(() => {});
    }
  }

  return { inspect, import: importInstance };
}
