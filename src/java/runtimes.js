// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fsp from 'node:fs/promises';
import path from 'node:path';
import { CorruptDataError, JavaRuntimeError, ValidationError } from '../core/errors.js';
import { ensureDir, pathExists, removePath, resolveWithin, writeJson } from '../core/filesystem.js';
import { downloadToFile } from '../download/downloader.js';
import { percentOf } from '../download/progress.js';
import { httpClient } from '../net/http.js';
import { validateUrl } from '../security/urls.js';

export const JAVA_RUNTIME_ALL_URL =
  'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
export const RUNTIME_PLATFORM = 'linux';
export const JAVA_RUNTIME_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const RUNTIME_MARKER = '.tml-runtime.json';
const LIST_TTL_MS = 10 * 60 * 1000;
const SKIP_RUNTIME_NAMES = new Set(['minecraft-java-exe']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateRuntimeName(value) {
  if (typeof value !== 'string' || !JAVA_RUNTIME_NAME_PATTERN.test(value)) {
    throw new ValidationError(`Invalid Java runtime name: ${JSON.stringify(value)}`, {
      code: 'INVALID_JAVA_RUNTIME',
      details: { field: 'name' },
    });
  }
  return value;
}

export function majorFromJavaVersion(name) {
  const major = Number.parseInt(String(name), 10);
  return Number.isFinite(major) && major > 0 ? major : null;
}

export function parseJavaRuntimeList(data, { platform = RUNTIME_PLATFORM } = {}) {
  if (!isPlainObject(data)) {
    throw new CorruptDataError('Java runtime list must be a JSON object', {
      code: 'JAVA_RUNTIME_LIST_INVALID',
    });
  }
  const byPlatform = isPlainObject(data[platform]) ? data[platform] : {};
  const runtimes = [];

  for (const [name, entries] of Object.entries(byPlatform)) {
    if (!Array.isArray(entries) || SKIP_RUNTIME_NAMES.has(name)) continue;
    const entry = entries.find(
      (candidate) =>
        typeof candidate?.manifest?.url === 'string' &&
        typeof candidate?.version?.name === 'string' &&
        (candidate?.availability?.progress ?? 100) === 100,
    );
    if (!entry) continue;
    runtimes.push({
      name,
      javaVersion: entry.version.name,
      released: typeof entry.version.released === 'string' ? entry.version.released : null,
      major: majorFromJavaVersion(entry.version.name),
      manifestUrl: entry.manifest.url,
      manifestSha1: typeof entry.manifest.sha1 === 'string' ? entry.manifest.sha1 : null,
      manifestSize: Number.isFinite(entry.manifest.size) ? entry.manifest.size : null,
    });
  }

  runtimes.sort((a, b) => (b.major ?? 0) - (a.major ?? 0) || a.name.localeCompare(b.name));
  if (runtimes.length === 0) {
    throw new CorruptDataError(`Java runtime list has no usable runtimes for "${platform}"`, {
      code: 'JAVA_RUNTIME_LIST_INVALID',
      details: { platform },
    });
  }
  return runtimes;
}

export function parseRuntimeManifest(manifest) {
  if (!isPlainObject(manifest) || !isPlainObject(manifest.files)) {
    throw new CorruptDataError('Java runtime manifest must contain a "files" object', {
      code: 'JAVA_RUNTIME_MANIFEST_INVALID',
    });
  }

  const directories = [];
  const downloads = [];
  const links = [];

  for (const [rel, entry] of Object.entries(manifest.files)) {
    if (!isPlainObject(entry)) continue;
    if (entry.type === 'directory') {
      directories.push(rel);
      continue;
    }
    if (entry.type === 'link') {
      links.push({ rel, target: typeof entry.target === 'string' ? entry.target : null });
      continue;
    }
    if (entry.type === 'file') {
      const raw = isPlainObject(entry.downloads) ? entry.downloads.raw : null;
      if (!isPlainObject(raw) || typeof raw.url !== 'string') continue;
      downloads.push({
        rel,
        url: raw.url,
        sha1: typeof raw.sha1 === 'string' ? raw.sha1 : null,
        size: Number.isFinite(raw.size) ? raw.size : null,
        executable: entry.executable === true,
      });
    }
  }

  directories.sort();
  downloads.sort((a, b) => a.rel.localeCompare(b.rel));
  links.sort((a, b) => a.rel.localeCompare(b.rel));
  return { directories, downloads, links };
}

export function createJavaRuntimes(options = {}) {
  const {
    config,
    logger = null,
    client = httpClient,
    validator = validateUrl,
    now = () => Date.now(),
    ttlMs = LIST_TTL_MS,
    dir = config?.paths?.javaDir ?? null,
  } = options;

  if (!config || !isPlainObject(config.paths) || !config.paths.cacheDir) {
    throw new ValidationError('createJavaRuntimes requires a config with paths.cacheDir');
  }
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new ValidationError('createJavaRuntimes requires a java install directory');
  }

  const manifestCacheDir = path.join(config.paths.cacheDir, 'java');
  let cache = null;
  let chosen = typeof config.java?.runtime === 'string' ? config.java.runtime : null;
  const inflight = new Map();

  function getChosen() {
    return chosen;
  }

  function setChosen(name) {
    chosen = name === null || name === undefined ? null : validateRuntimeName(name);
    return chosen;
  }

  function runtimeRoot(name) {
    return resolveWithin(dir, validateRuntimeName(name));
  }

  async function isDownloaded(name) {
    const root = runtimeRoot(name);
    return (await pathExists(path.join(root, RUNTIME_MARKER))) && (await pathExists(path.join(root, 'bin', 'java')));
  }

  async function list({ refresh = false } = {}) {
    if (!refresh && cache && now() - cache.at < ttlMs) return withDownloaded(cache.runtimes);

    const response = await client.getJson(JAVA_RUNTIME_ALL_URL, { source: 'minecraft' });
    const runtimes = parseJavaRuntimeList(response.data);
    cache = { at: now(), runtimes };
    return withDownloaded(runtimes);
  }

  async function withDownloaded(runtimes) {
    const result = [];
    for (const runtime of runtimes) {
      result.push({ ...runtime, downloaded: await isDownloaded(runtime.name) });
    }
    return result;
  }

  async function loadManifest(runtime) {
    if (runtime.manifestSha1) {
      const cacheFile = path.join(manifestCacheDir, `manifest-${runtime.manifestSha1}.json`);
      await downloadToFile({
        id: `java-manifest:${runtime.manifestSha1}`,
        url: runtime.manifestUrl,
        dest: cacheFile,
        source: 'minecraft',
        sha1: runtime.manifestSha1,
        size: runtime.manifestSize,
        force: false,
        validator,
        logger,
      });
      try {
        return JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
      } catch (err) {
        throw new CorruptDataError('Cached Java runtime manifest is not valid JSON', {
          code: 'JAVA_RUNTIME_MANIFEST_INVALID',
          cause: err,
          details: { name: runtime.name },
        });
      }
    }

    const response = await client.getJson(runtime.manifestUrl, { source: 'minecraft' });
    return response.data;
  }

  async function doDownload(runtime, { force, onProgress, signal }) {
    const root = runtimeRoot(runtime.name);
    if (!force && (await isDownloaded(runtime.name))) {
      logger?.info('java runtime already installed', { name: runtime.name });
      return { name: runtime.name, path: root, cached: true, files: 0, bytes: 0 };
    }

    const manifest = await loadManifest(runtime);
    const { directories, downloads, links } = parseRuntimeManifest(manifest);
    const total = downloads.reduce((sum, file) => sum + (file.size ?? 0), 0);
    let loaded = 0;
    let bytes = 0;
    let done = 0;

    const report = () => {
      if (typeof onProgress !== 'function') return;
      onProgress({
        stage: 'java',
        loaded,
        total,
        percent: percentOf(loaded, total),
        files: { done, count: downloads.length },
      });
    };

    await ensureDir(root);
    for (const rel of directories) {
      await ensureDir(resolveWithin(root, rel));
    }

    for (const file of downloads) {
      const dest = resolveWithin(root, file.rel);
      await ensureDir(path.dirname(dest));
      const out = await downloadToFile({
        id: `java:${runtime.name}:${file.rel}`,
        url: file.url,
        dest,
        source: 'minecraft',
        sha1: file.sha1,
        size: file.size,
        force,
        validator,
        logger,
        signal,
      });
      if (file.executable) await fsp.chmod(dest, 0o755);
      loaded += file.size ?? 0;
      bytes += out?.bytes ?? 0;
      done += 1;
      report();
    }

    for (const link of links) {
      if (!link.target) continue;
      const dest = resolveWithin(root, link.rel);
      const targetAbs = path.resolve(path.dirname(dest), link.target);
      const relative = path.relative(root, targetAbs);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        logger?.warn('java runtime link escapes install directory — skipped', {
          name: runtime.name,
          link: link.rel,
        });
        continue;
      }
      if (!(await pathExists(targetAbs))) {
        logger?.warn('java runtime link target missing — skipped', {
          name: runtime.name,
          link: link.rel,
        });
        continue;
      }
      await ensureDir(path.dirname(dest));
      await fsp.copyFile(targetAbs, dest);
    }

    await writeJson(path.join(root, RUNTIME_MARKER), {
      name: runtime.name,
      javaVersion: runtime.javaVersion,
      installedAt: new Date().toISOString(),
      files: done,
      bytes,
    });

    logger?.info('java runtime installed', { name: runtime.name, files: done, bytes });
    return { name: runtime.name, path: root, cached: false, files: done, bytes };
  }

  async function download(name, { force = false, onProgress = null, signal = null } = {}) {
    validateRuntimeName(name);
    const runtimes = await list();
    const runtime = runtimes.find((candidate) => candidate.name === name);
    if (!runtime) {
      throw new JavaRuntimeError(`Unknown Java runtime: ${name}`, {
        code: 'JAVA_RUNTIME_NOT_FOUND',
        status: 404,
        details: { name },
      });
    }

    const existing = inflight.get(name);
    if (existing) return existing;

    const promise = doDownload(runtime, { force, onProgress, signal }).finally(() => inflight.delete(name));
    inflight.set(name, promise);
    return promise;
  }

  async function remove(name) {
    validateRuntimeName(name);
    if (inflight.has(name)) {
      throw new JavaRuntimeError(`Java runtime ${name} is downloading right now`, {
        code: 'JAVA_RUNTIME_BUSY',
        status: 409,
        details: { name },
      });
    }
    const root = runtimeRoot(name);
    if (!(await pathExists(root))) {
      throw new JavaRuntimeError(`Java runtime ${name} is not downloaded`, {
        code: 'JAVA_RUNTIME_NOT_DOWNLOADED',
        status: 404,
        details: { name },
      });
    }
    await removePath(root);
    const clearedChosen = chosen === name;
    if (clearedChosen) chosen = null;
    logger?.info('java runtime removed', { name, clearedChosen });
    return { name, deleted: true, clearedChosen };
  }

  async function ensure({ requiredMajor = null, requiredComponent = null, onProgress = null, signal = null } = {}) {
    const runtimes = await list();
    let pick = null;

    if (requiredComponent) {
      pick =
        runtimes.find(
          (runtime) => runtime.name === requiredComponent && (requiredMajor === null || runtime.major === requiredMajor),
        ) ?? null;
    }
    if (!pick && requiredMajor !== null) {
      pick = runtimes.find((runtime) => runtime.major === requiredMajor) ?? null;
    }
    if (!pick && requiredComponent) {
      pick = runtimes.find((runtime) => runtime.name === requiredComponent) ?? null;
    }
    if (!pick) {
      throw new JavaRuntimeError(
        `No Microsoft Java runtime matches this game (requires Java ${requiredMajor ?? requiredComponent ?? '?'})`,
        {
          code: 'JAVA_RUNTIME_UNAVAILABLE',
          status: 409,
          details: { requiredMajor, requiredComponent },
        },
      );
    }

    return download(pick.name, { onProgress, signal });
  }

  return { list, download, ensure, remove, getChosen, setChosen };
}
