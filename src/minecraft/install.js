// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fsp from 'node:fs/promises';
import path from 'node:path';
import { CancelledError, CorruptDataError, InstallError, ValidationError } from '../core/errors.js';
import { assertLinuxPlatform } from '../core/platform.js';
import { pathExists, readJson, removePath, resolveWithin, writeJson, ensureDir } from '../core/filesystem.js';
import { createDownloader } from '../download/downloader.js';
import { hashFile } from '../download/hash.js';
import { percentOf } from '../download/progress.js';
import { extractZip } from '../archive/unzip.js';
import { inferSource } from '../security/urls.js';
import { safeVersionId } from './versions.js';

export const LIBRARY_HOST = 'https://libraries.minecraft.net';
export const ASSET_HOST = 'https://resources.download.minecraft.net';
export const NATIVES_MANIFEST = '.tml-natives.json';

export const INSTALL_SECTIONS = Object.freeze(['client', 'libraries', 'logging', 'assets', 'natives']);
export const INSTALL_STAGES = Object.freeze([
  'metadata',
  'client',
  'libraries',
  'logging',
  'assets',
  'natives',
  'done',
]);

const SAFE_NAME_RE = /^[A-Za-z0-9 ._=-]+$/;

export function detectPlatform(arch = process.arch, platform = process.platform) {
  assertLinuxPlatform(platform);
  const archName = arch === 'x64' ? 'x86_64' : arch === 'ia32' ? 'x86' : arch;
  return Object.freeze({
    name: 'linux',
    arch: archName,
    bits: arch === 'x64' || arch === 'arm64' || arch === 's390x' ? 64 : 32,
    rawPlatform: 'linux',
    rawArch: arch,
  });
}

export function evaluateRules(rules, context) {
  if (!Array.isArray(rules) || rules.length === 0) return true;

  let allowed = false;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    if (ruleMatches(rule, context)) allowed = rule.action === 'allow';
  }
  return allowed;
}

function ruleMatches(rule, context) {
  const os = rule.os;
  if (os && typeof os === 'object') {
    if (os.name !== undefined && os.name !== context.os.name) return false;
    if (os.arch !== undefined && os.arch !== context.os.arch) return false;
  }

  const features = rule.features;
  if (features && typeof features === 'object') {
    for (const [key, expected] of Object.entries(features)) {
      if (Boolean(context.features?.[key]) !== Boolean(expected)) return false;
    }
  }

  return true;
}

export function mavenPath(name) {
  const raw = typeof name === 'string' ? name.trim() : '';
  const [coord, extension = 'jar'] = raw.split('@');
  const parts = coord.split(':');

  if (parts.length < 2 || parts.length > 4 || parts.some((part) => part === '')) {
    throw new ValidationError(`Invalid maven coordinate: ${raw}`, {
      code: 'INVALID_MAVEN_COORDINATE',
      details: { name: raw },
    });
  }

  const [group, artifact, version, classifier] = parts;
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;
  return `${group.split('.').join('/')}/${artifact}/${version}/${file}`;
}

function safeName(value, label) {
  if (typeof value !== 'string' || value === '' || !SAFE_NAME_RE.test(value) || value === '.' || value === '..') {
    throw new ValidationError(`Invalid ${label}: ${String(value)}`, {
      code: 'INVALID_NAME',
      details: { value: String(value) },
    });
  }
  return value;
}

function requireDownload(value, label, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CorruptDataError(`Version "${id}" is missing "${label}"`, { details: { id, label } });
  }
  if (typeof value.url !== 'string' || value.url === '') {
    throw new CorruptDataError(`Version "${id}" has no download url for "${label}"`, { details: { id, label } });
  }
  return {
    url: value.url,
    sha1: typeof value.sha1 === 'string' && value.sha1 !== '' ? value.sha1.toLowerCase() : null,
    size: typeof value.size === 'number' && value.size >= 0 ? value.size : null,
  };
}

export function createLayout(cacheDir) {
  const root = path.resolve(cacheDir);
  const minecraft = path.join(root, 'minecraft');

  const layout = {
    root,
    minecraft,
    versions: path.join(minecraft, 'versions'),
    client: path.join(minecraft, 'client'),
    logging: path.join(minecraft, 'logging'),
    natives: path.join(minecraft, 'natives'),
    libraries: path.join(root, 'libraries'),
    assets: path.join(root, 'assets'),
    indexes: path.join(root, 'assets', 'indexes'),
    objects: path.join(root, 'assets', 'objects'),
  };

  return {
    ...layout,
    versionFile: (id) => path.join(layout.versions, `${safeVersionId(id)}.json`),
    clientJar: (id) => path.join(layout.client, safeVersionId(id), 'client.jar'),
    nativesDir: (id) => path.join(layout.natives, safeVersionId(id)),
    loggingFile: (id) => resolveWithin(layout.logging, safeName(id, 'logging file id')),
    library: (libraryPath) => resolveWithin(layout.libraries, libraryPath),
    assetIndexFile: (id) => resolveWithin(layout.indexes, `${safeName(id, 'asset index id')}.json`),
    assetObjectFile: (hash) => {
      if (typeof hash !== 'string' || !/^[0-9a-f]{40}$/i.test(hash)) {
        throw new ValidationError(`Invalid asset hash: ${String(hash)}`, {
          code: 'INVALID_HASH',
          details: { hash: String(hash) },
        });
      }
      const lower = hash.toLowerCase();
      return path.join(layout.objects, lower.slice(0, 2), lower);
    },
  };
}

export function planVersion(version, context = {}) {
  if (!version || typeof version !== 'object' || typeof version.id !== 'string') {
    throw new ValidationError('planVersion() requires Minecraft version metadata', {
      code: 'INVALID_VERSION',
    });
  }

  const id = safeVersionId(version.id);
  const os = context.os ?? detectPlatform(context.arch ?? process.arch);
  if (os.name !== 'linux') {
    throw new ValidationError('planVersion() plans for Linux only', {
      code: 'UNSUPPORTED_PLATFORM',
      details: { os: os.name, supported: 'linux' },
    });
  }
  const ruleContext = { os, features: context.features ?? {} };
  const libraries = [];
  const natives = [];
  const seenLibraries = new Set();
  const seenNatives = new Set();

  for (const entry of version.libraries ?? []) {
    if (!entry || typeof entry !== 'object') {
      throw new CorruptDataError(`Version "${id}" contains an invalid library entry`, { details: { id } });
    }
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (name === '') {
      throw new CorruptDataError(`Version "${id}" contains a library without a name`, { details: { id } });
    }
    if (!evaluateRules(entry.rules, ruleContext)) continue;

    const downloads = entry.downloads && typeof entry.downloads === 'object' ? entry.downloads : {};
    const artifact = downloads.artifact && typeof downloads.artifact === 'object' ? downloads.artifact : null;
    const hasNatives = entry.natives && typeof entry.natives === 'object';

    if (artifact || !hasNatives) {
      const artifactPath =
        typeof artifact?.path === 'string' && artifact.path !== '' ? artifact.path : mavenPath(name);
      if (!seenLibraries.has(artifactPath)) {
        seenLibraries.add(artifactPath);
        libraries.push({
          name,
          path: artifactPath,
          url:
            typeof artifact?.url === 'string' && artifact.url !== ''
              ? artifact.url
              : `${LIBRARY_HOST}/${artifactPath}`,
          sha1: typeof artifact?.sha1 === 'string' && artifact.sha1 !== '' ? artifact.sha1.toLowerCase() : null,
          size: typeof artifact?.size === 'number' && artifact.size >= 0 ? artifact.size : null,
        });
      }
    }

    if (hasNatives) {
      const keyTemplate = entry.natives[os.name];
      if (typeof keyTemplate === 'string' && keyTemplate !== '') {
        const key = keyTemplate.split('${arch}').join(String(os.bits));
        const classifiers = downloads.classifiers && typeof downloads.classifiers === 'object' ? downloads.classifiers : null;
        const classifier = classifiers ? classifiers[key] : null;

        if (classifiers && (!classifier || typeof classifier !== 'object')) {
          throw new CorruptDataError(`Version "${id}" is missing native classifier "${key}" for ${name}`, {
            details: { id, library: name, classifier: key },
          });
        }

        const nativePath =
          classifier && typeof classifier.path === 'string' && classifier.path !== ''
            ? classifier.path
            : mavenPath(`${name}:${key}`);

        if (!seenNatives.has(nativePath)) {
          seenNatives.add(nativePath);
          natives.push({
            name,
            key,
            path: nativePath,
            url:
              classifier && typeof classifier.url === 'string' && classifier.url !== ''
                ? classifier.url
                : `${LIBRARY_HOST}/${nativePath}`,
            sha1:
              classifier && typeof classifier.sha1 === 'string' && classifier.sha1 !== ''
                ? classifier.sha1.toLowerCase()
                : null,
            size: classifier && typeof classifier.size === 'number' && classifier.size >= 0 ? classifier.size : null,
            exclude: Array.isArray(entry.extract?.exclude)
              ? entry.extract.exclude.filter((prefix) => typeof prefix === 'string')
              : [],
          });
        }
      }
    }
  }

  const client = requireDownload(version.downloads?.client, 'downloads.client', id);
  const assetIndex = version.assetIndex
    ? {
        ...requireDownload(version.assetIndex, 'assetIndex', id),
        id: safeName(version.assetIndex.id, 'asset index id'),
        totalSize:
          typeof version.assetIndex.totalSize === 'number' && version.assetIndex.totalSize >= 0
            ? version.assetIndex.totalSize
            : null,
      }
    : null;

  let logging = null;
  const loggingFile = version.logging?.client?.file;
  if (loggingFile) {
    const file = requireDownload(loggingFile, 'logging.client.file', id);
    logging = { ...file, id: safeName(file.id ?? loggingFile.id, 'logging file id') };
  }

  return {
    id,
    type: typeof version.type === 'string' ? version.type : null,
    mainClass: typeof version.mainClass === 'string' ? version.mainClass : null,
    javaVersion: version.javaVersion ?? null,
    os,
    client: { ...client, dest: null },
    libraries,
    natives,
    logging,
    assetIndex,
    assets: typeof version.assets === 'string' ? version.assets : null,
    arguments:
      version.arguments && typeof version.arguments === 'object' && !Array.isArray(version.arguments)
        ? version.arguments
        : null,
    minecraftArguments: typeof version.minecraftArguments === 'string' ? version.minecraftArguments : null,
    raw: version.raw ?? null,
  };
}

export function attachLayout(plan, layout) {
  plan.client.dest = layout.clientJar(plan.id);
  plan.libraries = plan.libraries.map((library) => ({ ...library, dest: layout.library(library.path) }));
  plan.natives = plan.natives.map((native) => ({
    ...native,
    jarDest: layout.library(native.path),
    destDir: layout.nativesDir(plan.id),
  }));
  plan.logging = plan.logging ? { ...plan.logging, dest: layout.loggingFile(plan.logging.id) } : null;
  plan.assetIndex = plan.assetIndex ? { ...plan.assetIndex, dest: layout.assetIndexFile(plan.assetIndex.id) } : null;
  return plan;
}

export function buildAssetTasks(assetIndex, layout, { host = ASSET_HOST } = {}) {
  if (!assetIndex || typeof assetIndex !== 'object' || !assetIndex.objects || typeof assetIndex.objects !== 'object') {
    throw new CorruptDataError('Asset index is missing its "objects" map', { details: { received: typeof assetIndex } });
  }

  const byHash = new Map();
  for (const [name, entry] of Object.entries(assetIndex.objects)) {
    if (!entry || typeof entry !== 'object') {
      throw new CorruptDataError(`Asset index entry is invalid: ${name}`, { details: { asset: name } });
    }
    const hash = typeof entry.hash === 'string' ? entry.hash.toLowerCase() : '';
    if (!/^[0-9a-f]{40}$/.test(hash)) {
      throw new CorruptDataError(`Asset index entry has an invalid hash: ${name}`, { details: { asset: name } });
    }
    const size = typeof entry.size === 'number' && entry.size >= 0 ? entry.size : null;
    if (byHash.has(hash)) continue;
    byHash.set(hash, { id: `asset:${hash}`, hash, size, dest: layout.assetObjectFile(hash) });
  }

  return [...byHash.values()].map((asset) => ({
    ...asset,
    url: `${host}/${asset.hash.slice(0, 2)}/${asset.hash}`,
    sha1: asset.hash,
  }));
}

export function normalizeInclude(include) {
  if (include === undefined || include === null) {
    return Object.freeze(Object.fromEntries(INSTALL_SECTIONS.map((section) => [section, true])));
  }
  if (!Array.isArray(include)) {
    throw new ValidationError('"include" must be an array of install sections', {
      code: 'INVALID_INCLUDE',
      details: { known: [...INSTALL_SECTIONS] },
    });
  }

  const selected = new Set(include);
  for (const section of selected) {
    if (!INSTALL_SECTIONS.includes(section)) {
      throw new ValidationError(`Unknown install section: ${String(section)}`, {
        code: 'INVALID_INCLUDE',
        details: { known: [...INSTALL_SECTIONS] },
      });
    }
  }
  return Object.freeze(
    Object.fromEntries(INSTALL_SECTIONS.map((section) => [section, selected.has(section)])),
  );
}

export function computeExpectedBytes(plan, include) {
  let total = 0;
  const add = (entry) => {
    if (entry && typeof entry.size === 'number') total += entry.size;
  };

  if (include.client) add(plan.client);
  if (include.libraries) for (const library of plan.libraries) add(library);
  if (include.natives) for (const native of plan.natives) add(native);
  if (include.logging) add(plan.logging);
  if (include.assets) {
    add(plan.assetIndex);
    if (plan.assetIndex?.totalSize) total += plan.assetIndex.totalSize;
  }

  return total;
}

function downloadTask(id, entry, dest, source, force = false) {
  return {
    id,
    url: entry.url,
    dest,
    sha1: entry.sha1 ?? null,
    size: entry.size ?? null,
    source,
    force,
  };
}

export function createInstaller(options = {}) {
  const config = options.config ?? null;
  const cacheDir = options.cacheDir ?? config?.paths?.cacheDir ?? null;
  if (typeof cacheDir !== 'string' || cacheDir === '') {
    throw new ValidationError('createInstaller() requires a cache directory', { code: 'INVALID_CACHE_DIR' });
  }

  const layout = options.layout ?? createLayout(cacheDir);
  const logger = options.logger ?? null;
  const minecraft = options.minecraft ?? null;
  const platform = detectPlatform();
  const assetHost = options.assetHost ?? ASSET_HOST;
  const downloader =
    options.downloader ??
    createDownloader({
      config,
      logger,
      validator: options.validator,
      concurrency: options.concurrency,
      retries: options.retries,
      progress: options.progress,
    });

  async function resolveVersion(input) {
    if (typeof input === 'string') {
      if (!minecraft || typeof minecraft.getVersion !== 'function') {
        throw new ValidationError('Installing by version id requires a Minecraft API client', {
          code: 'NO_MINECRAFT_API',
          details: { id: input },
        });
      }
      const result = await minecraft.getVersion(input);
      return result.version;
    }
    if (input && typeof input === 'object' && typeof input.id === 'string') return input;

    throw new ValidationError('Expected a Minecraft version id or version metadata object', {
      code: 'INVALID_VERSION',
      details: { received: typeof input },
    });
  }

  async function ensureVersionFile(version) {
    const file = layout.versionFile(version.id);
    try {
      const existing = await readJson(file);
      if (existing && typeof existing.id === 'string' && existing.id === version.id) return { file, wrote: false };
      logger?.warn('version metadata on disk does not match, rewriting', { file });
    } catch (err) {
      if (err?.code !== 'FILE_NOT_FOUND') {
        logger?.warn('version metadata on disk is unreadable, rewriting', { file, code: err?.code });
      }
    }
    await writeJson(file, version.raw ?? version);
    return { file, wrote: true };
  }

  function buildPlan(version, features = {}) {
    return attachLayout(planVersion(version, { os: platform, features }), layout);
  }

  async function plan(input, opts = {}) {
    const version = await resolveVersion(input);
    return buildPlan(version, opts.features ?? {});
  }

  async function extractNatives(installPlan, { force = false, signal = null } = {}) {
    const dir = layout.nativesDir(installPlan.id);
    const manifestFile = path.join(dir, NATIVES_MANIFEST);
    const sources = installPlan.natives.map((native) => `${native.key}:${native.sha1 ?? 'unknown'}`).sort();

    for (const native of installPlan.natives) {
      if (!(await pathExists(native.jarDest))) {
        throw new InstallError(`Native library jar is missing: ${native.path}`, {
          details: { stage: 'natives', path: native.path, expected: native.jarDest },
        });
      }
    }

    if (!force) {
      const manifest = await readJson(manifestFile, { optional: true });
      if (
        manifest &&
        Array.isArray(manifest.sources) &&
        manifest.sources.length === sources.length &&
        manifest.sources.every((value, index) => value === sources[index])
      ) {
        return { skipped: true, dir, files: typeof manifest.files === 'number' ? manifest.files : 0, bytes: 0 };
      }
    }

    await removePath(dir);
    await ensureDir(dir);

    let files = 0;
    let bytes = 0;
    for (const native of installPlan.natives) {
      const extracted = await extractZip(native.jarDest, dir, { exclude: native.exclude, signal });
      files += extracted.count;
      bytes += extracted.bytes;
    }

    await writeJson(manifestFile, { version: 1, versionId: installPlan.id, sources, files });
    logger?.info('natives extracted', { version: installPlan.id, files, bytes, dir });
    return { skipped: false, dir, files, bytes };
  }

  async function install(input, opts = {}) {
    const startedAt = Date.now();
    const include = normalizeInclude(opts.include);
    const force = opts.force === true;
    const signal = opts.signal ?? null;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const features = opts.features && typeof opts.features === 'object' ? { ...opts.features } : {};

    if (signal?.aborted) throw new CancelledError('Install cancelled', { details: { id: String(input) } });

    const version = await resolveVersion(input);
    const installPlan = buildPlan(version, features);
    await ensureVersionFile(version);

    const expectedBytes = computeExpectedBytes(installPlan, include);
    const counters = {
      files: { total: 0, downloaded: 0, cached: 0, failed: 0 },
      bytes: { network: 0, present: 0 },
      failures: [],
    };
    let stage = 'metadata';

    const tasks = { client: [], libraries: [], logging: [], assets: [] };
    if (include.client) {
      tasks.client.push(
        downloadTask(`client:${installPlan.id}`, installPlan.client, installPlan.client.dest, 'minecraft', force),
      );
    }
    const taskSource = (url) => inferSource(url) ?? 'minecraft';
    if (include.libraries) {
      for (const library of installPlan.libraries) {
        tasks.libraries.push(downloadTask(`library:${library.path}`, library, library.dest, taskSource(library.url), force));
      }
    }
    if (include.natives) {
      for (const native of installPlan.natives) {
        tasks.libraries.push(downloadTask(`native:${native.path}`, native, native.jarDest, taskSource(native.url), force));
      }
    }
    if (include.logging && installPlan.logging) {
      tasks.logging.push(
        downloadTask(`logging:${installPlan.logging.id}`, installPlan.logging, installPlan.logging.dest, 'minecraft', force),
      );
    }
    if (include.assets && installPlan.assetIndex) {
      tasks.assets.push(
        downloadTask(
          `asset-index:${installPlan.assetIndex.id}`,
          installPlan.assetIndex,
          installPlan.assetIndex.dest,
          'minecraft',
          force,
        ),
      );
    }

    const report = (snapshot) => {
      const total = expectedBytes > 0 ? expectedBytes : snapshot.bytes.total;
      const loaded =
        stage === 'done' && total > 0
          ? total
          : total > 0
            ? Math.min(snapshot.bytes.loaded, total)
            : snapshot.bytes.loaded;
      onProgress({
        stage,
        loaded,
        total,
        percent: percentOf(loaded, total),
        tasks: snapshot.tasks,
      });
    };

    const register = (list) => {
      for (const task of list) {
        downloader.progress.remove(task.id);
        downloader.progress.register(task.id, { total: task.size ?? null, url: task.url });
      }
    };
    for (const list of Object.values(tasks)) register(list);

    const unsubscribe = onProgress ? downloader.progress.subscribe(report) : null;
    const onAbort = () => downloader.cancelAll('Install cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      async function runStage(name, list) {
        if (signal?.aborted) throw new CancelledError('Install cancelled', { details: { stage: name } });
        if (list.length === 0) return [];
        stage = name;

        const outcomes = await downloader.run(list);
        const failures = [];
        for (const outcome of outcomes) {
          if (outcome.status !== 'ok') {
            failures.push({
              id: outcome.id,
              code: outcome.error?.code ?? null,
              message: outcome.error?.message ?? String(outcome.error),
            });
            counters.files.failed += 1;
            continue;
          }
          counters.files.total += 1;
          counters.bytes.present += outcome.result.bytes;
          if (outcome.result.from === 'cache') {
            counters.files.cached += 1;
          } else {
            counters.files.downloaded += 1;
            counters.bytes.network += outcome.result.bytes;
          }
        }
        counters.failures.push(...failures);

        if (failures.length > 0) {
          if (signal?.aborted || failures.some((failure) => failure.code === 'CANCELLED')) {
            throw new CancelledError('Install cancelled', { details: { stage: name, failures } });
          }
          logger?.error('install stage failed', { stage: name, failures });
          throw new InstallError(`Install failed during "${name}" stage`, {
            details: { stage: name, failures },
          });
        }

        return outcomes;
      }

      await runStage('client', tasks.client);
      await runStage('libraries', tasks.libraries);
      await runStage('logging', tasks.logging);

      if (include.assets && installPlan.assetIndex) {
        await runStage('assets', tasks.assets);
        const assetIndex = await readJson(installPlan.assetIndex.dest);
        const assetTasks = buildAssetTasks(assetIndex, layout, { host: assetHost }).map((asset) => ({
          ...asset,
          source: 'minecraft',
          force,
        }));
        register(assetTasks);
        await runStage('assets', assetTasks);
      }

      let natives = null;
      if (include.natives && installPlan.natives.length > 0) {
        stage = 'natives';
        natives = await extractNatives(installPlan, { force, signal });
      }

      stage = 'done';
      if (onProgress) report(downloader.progress.snapshot());
      const result = {
        id: installPlan.id,
        type: installPlan.type,
        javaVersion: installPlan.javaVersion,
        path: {
          version: layout.versionFile(installPlan.id),
          client: installPlan.client.dest,
          natives: layout.nativesDir(installPlan.id),
          logging: installPlan.logging?.dest ?? null,
          assetIndex: installPlan.assetIndex?.dest ?? null,
        },
        files: counters.files,
        bytes: counters.bytes,
        natives,
        durationMs: Date.now() - startedAt,
        plan: installPlan,
      };
      logger?.info('install complete', {
        version: result.id,
        files: result.files.total,
        downloaded: result.files.downloaded,
        cached: result.files.cached,
        durationMs: result.durationMs,
      });
      return result;
    } finally {
      unsubscribe?.();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function inspect(dest, size, sha1 = null, deep = false) {
    try {
      const stat = await fsp.stat(dest);
      if (!stat.isFile()) return { installed: false, reason: 'not-a-file', bytes: null };
      if (typeof size === 'number' && size > 0 && stat.size !== size) {
        return { installed: false, reason: 'size-mismatch', bytes: stat.size };
      }
      if (deep && sha1) {
        const hashes = await hashFile(dest, ['sha1']);
        if ((hashes.sha1 ?? '').toLowerCase() !== sha1.toLowerCase()) {
          return { installed: false, reason: 'checksum-mismatch', bytes: stat.size };
        }
      }
      return { installed: true, reason: null, bytes: stat.size };
    } catch (err) {
      if (err?.code === 'ENOENT') return { installed: false, reason: 'missing', bytes: null };
      throw err;
    }
  }

  async function inspectList(entries, destKey, { deep, limit = 50 } = {}) {
    let installed = 0;
    const missing = [];
    let missingCount = 0;

    for (const entry of entries) {
      const info = await inspect(entry[destKey], entry.size, deep ? entry.sha1 : null, deep);
      if (info.installed) {
        installed += 1;
      } else {
        missingCount += 1;
        if (missing.length < limit) missing.push(entry[destKey]);
      }
    }

    return { planned: entries.length, installed, missing, missingCount };
  }

  async function status(input, opts = {}) {
    const deep = opts.deep === true;
    const include = normalizeInclude(opts.include);
    const version = await resolveVersion(input);
    const installPlan = buildPlan(version, opts.features ?? {});
    const sections = {};

    if (include.client) {
      const info = await inspect(installPlan.client.dest, installPlan.client.size, deep ? installPlan.client.sha1 : null, deep);
      sections.client = {
        included: true,
        planned: 1,
        installed: info.installed ? 1 : 0,
        missing: info.installed ? [] : [installPlan.client.dest],
        reason: info.reason,
        ready: info.installed,
      };
    } else {
      sections.client = { included: false, planned: 0, installed: 0, missing: [], ready: null };
    }

    if (include.libraries) {
      const summary = await inspectList(installPlan.libraries, 'dest', { deep });
      sections.libraries = { included: true, ...summary, ready: summary.missingCount === 0 };
    } else {
      sections.libraries = { included: false, planned: 0, installed: 0, missing: [], missingCount: 0, ready: null };
    }

    if (include.logging) {
      if (installPlan.logging) {
        const info = await inspect(installPlan.logging.dest, installPlan.logging.size, deep ? installPlan.logging.sha1 : null, deep);
        sections.logging = {
          included: true,
          planned: 1,
          installed: info.installed ? 1 : 0,
          missing: info.installed ? [] : [installPlan.logging.dest],
          reason: info.reason,
          ready: info.installed,
        };
      } else {
        sections.logging = { included: true, planned: 0, installed: 0, missing: [], ready: true };
      }
    } else {
      sections.logging = { included: false, planned: 0, installed: 0, missing: [], ready: null };
    }

    if (include.assets && installPlan.assetIndex) {
      const indexInfo = await inspect(
        installPlan.assetIndex.dest,
        installPlan.assetIndex.size,
        deep ? installPlan.assetIndex.sha1 : null,
        deep,
      );
      let objects = { planned: 0, installed: 0, missing: [], missingCount: 0 };
      if (indexInfo.installed) {
        const assetIndex = await readJson(installPlan.assetIndex.dest);
        objects = await inspectList(buildAssetTasks(assetIndex, layout, { host: assetHost }), 'dest', { deep });
      }
      sections.assets = {
        included: true,
        index: indexInfo,
        objects,
        ready: indexInfo.installed && objects.missingCount === 0,
      };
    } else {
      sections.assets = { included: false, ready: null, objects: { planned: 0, installed: 0, missing: [], missingCount: 0 } };
    }

    if (include.natives) {
      const planned = installPlan.natives.length;
      if (planned === 0) {
        sections.natives = { included: true, planned: 0, extracted: true, reason: null, ready: true };
      } else {
        const sources = installPlan.natives.map((native) => `${native.key}:${native.sha1 ?? 'unknown'}`).sort();
        const manifest = await readJson(path.join(layout.nativesDir(installPlan.id), NATIVES_MANIFEST), {
          optional: true,
        });
        const extracted =
          !!manifest &&
          Array.isArray(manifest.sources) &&
          manifest.sources.length === sources.length &&
          manifest.sources.every((value, index) => value === sources[index]);
        sections.natives = {
          included: true,
          planned,
          extracted,
          reason: extracted ? null : manifest ? 'stale' : 'missing',
          ready: extracted,
        };
      }
    } else {
      sections.natives = { included: false, planned: 0, extracted: null, ready: null };
    }

    const included = Object.values(sections).filter((section) => section.included);
    return {
      id: installPlan.id,
      type: installPlan.type,
      javaVersion: installPlan.javaVersion,
      sections,
      ready: included.length === 0 || included.every((section) => section.ready === true),
    };
  }

  return {
    install,
    status,
    plan,
    layout,
    paths: layout,
    downloader,
    platform,
    sections: Object.freeze([...INSTALL_SECTIONS]),
  };
}
