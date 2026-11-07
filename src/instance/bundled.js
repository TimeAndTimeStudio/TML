import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureDir, pathExists, readJson, removePath, writeJson } from '../core/filesystem.js';
import { createInstance } from './create.js';
import { validateExportManifest } from './export.js';
import { isIconFilename } from './icon.js';

const DEFAULT_BUNDLES = fileURLToPath(new URL('../../bundled-instances/', import.meta.url));

// Copy each bundled export once. User instances remain independent of the
// application package, including after an update or deletion in the launcher.
export async function installBundledInstances({ dataDir, instancesDir, bundledDir = DEFAULT_BUNDLES, logger }) {
  let entries;
  try {
    entries = await fsp.readdir(bundledDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const stateFile = path.join(dataDir, 'bundled-instances.json');
  const state = await readJson(stateFile, { optional: true }) ?? { version: 1, installed: [] };
  if (state.version !== 1 || !Array.isArray(state.installed) || state.installed.some((name) => typeof name !== 'string')) {
    throw new Error('Invalid bundled instance installation state');
  }
  const completed = new Set(state.installed);
  const installed = [];
  await ensureDir(instancesDir);
  const existing = [];
  for (const entry of await fsp.readdir(instancesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      existing.push(await readJson(path.join(instancesDir, entry.name, 'instance.json')));
    } catch {
      // Unrelated incomplete or corrupt instances do not block first-run setup.
    }
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || completed.has(entry.name)) continue;
    const source = path.join(bundledDir, entry.name);
    const manifest = validateExportManifest(await readJson(path.join(source, 'instance.json')));
    const id = `bundled-${createHash('sha256').update(entry.name).digest('hex').slice(0, 16)}`;
    const destination = path.join(instancesDir, id);
    const matching = existing.some((meta) => meta &&
      ['name', 'type', 'minecraftVersion', 'loader', 'fabricLoaderVersion'].every((key) => meta[key] === manifest[key]));
    if (!matching && !(await pathExists(destination))) {
      // Stage the complete instance before making it visible to the launcher.
      const temporary = await fsp.mkdtemp(path.join(instancesDir, '.tml-bundled-'));
      try {
        await createInstance({ instancesDir: temporary, id, ...manifest });
        const staged = path.join(temporary, id);
        const gameSource = path.join(source, 'minecraft');
        if (await pathExists(gameSource)) {
          await fsp.cp(gameSource, path.join(staged, 'minecraft'), { recursive: true });
        }
        for (const item of await fsp.readdir(source, { withFileTypes: true })) {
          if (item.isFile() && isIconFilename(item.name)) {
            await fsp.copyFile(path.join(source, item.name), path.join(staged, item.name));
          }
        }
        await fsp.rename(staged, destination);
        installed.push(id);
        logger?.info('bundled instance installed', { id, name: manifest.name, type: manifest.type });
      } finally {
        await removePath(temporary);
      }
    }
    completed.add(entry.name);
    await writeJson(stateFile, { version: 1, installed: [...completed] });
  }
  return installed;
}
