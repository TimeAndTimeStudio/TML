// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ValidationError } from '../core/errors.js';
import { ensureDir, pathExists, readJson, resolveWithin, writeJson } from '../core/filesystem.js';
import { validateUrl } from '../security/urls.js';
import { downloadToFile } from '../download/downloader.js';
import { hashFile } from '../download/hash.js';
import { createModrinthApi } from '../modrinth/api.js';
import { forgetInstalledMod, readModRegistry, recordInstalledMods } from './registry.js';

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

// การเช็คแบบขนาน — รันงานหลายตัวพร้อมกัน (hash + ดึงข้อมูลจาก Modrinth) ตามจำนวน CPU สูงสุดของเครื่อง
const CHECK_CONCURRENCY = Math.max(
  1,
  typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
);
// cache ผล listVersions สั้น ๆ ให้การเช็คซ้ำ (auto-check, recheck หลังอัปเดต) ไม่ต้องยิง network ใหม่
const VERSIONS_CACHE_TTL_MS = 3 * 60 * 1000;

async function mapConcurrent(items, limit, worker) {
  if (items.length === 0) return;
  const queue = [...items];
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// Modrinth rate limit (429) → รอแล้วลองใหม่หนึ่งครั้ง (request ที่เหลือในรอบยังคงขนานต่อ)
async function listVersionsWithRetry(api, projectId, filters) {
  try {
    return await api.listVersions(projectId, filters);
  } catch (err) {
    if (err?.upstreamStatus !== 429) throw err;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref?.();
    });
    return api.listVersions(projectId, filters);
  }
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
  // cache รายการเวอร์ชีล่าสุดต่อ (project, minecraft, loader) — อยู่นานแค่ VERSIONS_CACHE_TTL_MS
  const versionsCache = new Map();

  function dirOf(instanceId, kind = 'mods') {
    const normalized = normalizePackKind(kind);
    if (normalized === 'mods') return manager.paths(instanceId).modsDir;
    return path.join(manager.paths(instanceId).gameDir, normalized);
  }

  // ไฟล์ที่ถูกลบจากการอัปเดตถูกย้ายไป .removed/ (แทนการลบจริง) เพื่อให้กู้คืนได้ภายหลัง
  const REMOVED_DIR = '.removed';
  const REMOVED_INDEX = 'removed.json';

  function removedDirOf(instanceId, kind) {
    return path.join(manager.paths(instanceId).dir, REMOVED_DIR, kind);
  }

  function removedIndexFile(instanceId) {
    return path.join(manager.paths(instanceId).dir, REMOVED_DIR, REMOVED_INDEX);
  }

  async function readRemovedIndex(instanceId) {
    const entries = await readJson(removedIndexFile(instanceId), { optional: true });
    return Array.isArray(entries) ? entries : [];
  }

  async function writeRemovedIndex(instanceId, entries) {
    await ensureDir(path.join(manager.paths(instanceId).dir, REMOVED_DIR));
    await writeJson(removedIndexFile(instanceId), entries);
  }

  function optionalLabel(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : null;
  }

  function isSameRemovedEntry(entry, packKind, filename) {
    return entry?.kind === packKind && entry?.filename === filename;
  }

  // serialize trash/restore ต่อ instance — ย้ายไฟล์ + อัปเดต removed.json หลายรายการพร้อมกันไม่ชนกัน
  const removedLocks = new Map();

  function withRemovedLock(instanceId, task) {
    const previous = removedLocks.get(instanceId) ?? Promise.resolve();
    const run = previous.then(task, task);
    removedLocks.set(
      instanceId,
      run.then(
        () => {},
        () => {}
      )
    );
    return run;
  }

  // cache ข้อมูลเวอร์ชี Modrinth สั้น ๆ ใช้ตอนคำนวณ supported ของไฟล์ที่ลบ (listRemoved?minecraftVersion=)
  const REMOVED_VERSION_CACHE_TTL_MS = 3 * 60 * 1000;
  const removedVersionCache = new Map();

  async function versionGameVersions(versionId) {
    const cached = removedVersionCache.get(versionId);
    if (cached && Date.now() - cached.at < REMOVED_VERSION_CACHE_TTL_MS) return cached.gameVersions;
    try {
      const version = await modrinthApi.getVersion(versionId);
      const gameVersions = Array.isArray(version?.gameVersions) ? version.gameVersions : [];
      removedVersionCache.set(versionId, { at: Date.now(), gameVersions });
      return gameVersions;
    } catch {
      return null; // ไม่รู้สถานะ → ถือว่าไม่รองรับ (ไม่ auto-restore) ไม่ cache เพื่อให้ครั้งหน้าลองใหม่
    }
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
    await recordInstalledMods(
      manager.paths(instanceId).dir,
      version,
      results.map((result, index) => ({ ...result, url: files[index]?.url ?? null })),
      { kind: packKind },
    );
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

  // ติดตั้งหลายเวอร์ชีในคำสั่งเดียว — ขนานเต็มจำนวน CPU (CHECK_CONCURRENCY) ผิดพลาดต่อรายการไม่ขัดจังหวะตัวอื่น
  async function installMany(instanceId, versionIds, { force = false, kind = 'mods' } = {}) {
    const packKind = normalizePackKind(kind);
    await manager.get(instanceId);
    const results = [];
    await mapConcurrent(versionIds, CHECK_CONCURRENCY, async (versionId) => {
      try {
        const result = await install(instanceId, versionId, { force, kind: packKind });
        results.push({
          versionId,
          ok: true,
          projectId: result.projectId,
          versionNumber: result.versionNumber,
          installed: result.installed,
          skipped: result.skipped,
          files: result.files.map((file) => ({
            filename: file.filename,
            bytes: file.bytes,
            sha1: file.sha1 ?? null,
            sha512: file.sha512 ?? null,
          })),
        });
      } catch (err) {
        results.push({ versionId, ok: false, error: err?.message ?? String(err) });
      }
    });
    return { instanceId, kind: packKind, count: results.length, results };
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
    installMany,
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
      await forgetInstalledMod(manager.paths(instanceId).dir, filename);
      logger?.info('pack file removed', { instanceId, kind: packKind, filename });
      return { instanceId, kind: packKind, filename, removed: true };
    },

    // ย้ายไฟล์ไป .removed/<kind>/ แทนการลบ + จดจำไว้ใน removed.json เพื่อกู้คืนได้ (ใช้ตอนอัปเดตแล้วเจอบทไม่เข้าเป้า)
    async trash(instanceId, modId, { kind = 'mods', reason = null, targetVersion = null } = {}) {
      const packKind = normalizePackKind(kind);
      await manager.get(instanceId);
      const filename = safeModFilename(modId);
      return withRemovedLock(instanceId, async () => {
        const source = resolveWithin(dirOf(instanceId, packKind), filename);
        if (!(await pathExists(source))) {
          throw new ValidationError(`Mod not found in instance: ${filename}`, {
            code: packKind === 'mods' ? 'MOD_NOT_FOUND' : 'PACK_FILE_NOT_FOUND',
            status: 404,
            details: { instanceId, filename, kind: packKind },
          });
        }
        const stats = await fsp.stat(source);
        const bucket = removedDirOf(instanceId, packKind);
        await ensureDir(bucket);
        const dest = resolveWithin(bucket, filename);
        await fsp.rm(dest, { force: true }); // มีไฟล์ค้างชื่อเดียวกัน → ทับด้วยของที่เพิ่งลบ (ล่าสุดชนะ)
        await fsp.rename(source, dest);
        const record = {
          kind: packKind,
          filename,
          size: stats.size,
          reason: optionalLabel(reason),
          targetVersion: optionalLabel(targetVersion),
          removedAt: new Date().toISOString(),
        };
        const entries = (await readRemovedIndex(instanceId)).filter(
          (entry) => !isSameRemovedEntry(entry, packKind, filename),
        );
        entries.push(record);
        await writeRemovedIndex(instanceId, entries);
        logger?.info('pack file trashed', { instanceId, kind: packKind, filename });
        return { instanceId, kind: packKind, filename, removed: true, remembered: true };
      });
    },

    async restore(instanceId, modId, { kind = 'mods' } = {}) {
      const packKind = normalizePackKind(kind);
      await manager.get(instanceId);
      const filename = safeModFilename(modId);
      return withRemovedLock(instanceId, async () => {
        const source = resolveWithin(removedDirOf(instanceId, packKind), filename);
        if (!(await pathExists(source))) {
          throw new ValidationError(`Removed file not found: ${filename}`, {
            code: 'REMOVED_FILE_NOT_FOUND',
            status: 404,
            details: { instanceId, filename, kind: packKind },
          });
        }
        const targetDir = dirOf(instanceId, packKind);
        await ensureDir(targetDir);
        const dest = resolveWithin(targetDir, filename);
        if (await pathExists(dest)) {
          throw new ValidationError(`A file named ${filename} already exists in ${packKind}`, {
            code: 'RESTORE_CONFLICT',
            status: 409,
            details: { instanceId, filename, kind: packKind },
          });
        }
        await fsp.rename(source, dest);
        const entries = (await readRemovedIndex(instanceId)).filter(
          (entry) => !isSameRemovedEntry(entry, packKind, filename),
        );
        await writeRemovedIndex(instanceId, entries);
        logger?.info('pack file restored', { instanceId, kind: packKind, filename });
        return { instanceId, kind: packKind, filename, restored: true };
      });
    },

    // minecraftVersion = เวอร์ชั่นเป้าหมายที่กำลังพิจารณา → คำนวณ supported ต่อรายการ
    // (ไฟล์ที่รู้จักผ่าน registry และเวอร์ชี Modrinth รองรับ MC นี้ → ผู้เรียกอาจ auto-restore)
    async listRemoved(instanceId, { minecraftVersion = null } = {}) {
      await manager.get(instanceId);
      const entries = await readRemovedIndex(instanceId);
      const registry = minecraftVersion
        ? ((await readModRegistry(manager.paths(instanceId).dir).catch(() => ({}))) ?? {})
        : null;
      const listed = [];
      for (const entry of entries) {
        if (!entry || typeof entry.filename !== 'string') continue;
        const item = {
          kind: PACK_KINDS.includes(entry.kind) ? entry.kind : 'mods',
          filename: entry.filename,
          size: typeof entry.size === 'number' ? entry.size : null,
          reason: entry.reason ?? null,
          targetVersion: entry.targetVersion ?? null,
          removedAt: entry.removedAt ?? null,
        };
        if (registry) {
          const versionId = registry[entry.filename]?.versionId ?? null;
          if (!versionId) {
            item.supported = false;
          } else {
            const gameVersions = await versionGameVersions(versionId);
            item.supported = Array.isArray(gameVersions) && gameVersions.includes(minecraftVersion);
          }
        }
        listed.push(item);
      }
      return listed;
    },

    // เช็คไฟล์ใน instance กับ Modrinth:
    //  - ไฟล์ที่ยังไม่รู้จัก (ไม่มีใน registry) → hash sha1 ถาม Modrinth แบบ batch ถ้าตรง → เพิ่มเข้า registry
    //  - ไฟล์ที่รู้จักแล้ว → เทียบกับเวอร์ชันล่าสุดที่เข้ากับ instance นี้ (MC + loader)
    // onProgress({ phase, current, total, message }) — phases: scan → hash → lookup → compare → done
    async check(instanceId, { kind = 'mods', adopt = true, onProgress = null, minecraftVersion = null } = {}) {
      const report = (phase, current, total, message) => {
        if (typeof onProgress !== 'function') return;
        try {
          onProgress({ phase, current, total, message });
        } catch {
          // ผู้ฟัง progress พังไม่กระทบการเช็ค
        }
      };

      const packKind = normalizePackKind(kind);
      const meta = await manager.get(instanceId);
      // minecraftVersion จาก caller = preview ความเข้ากันได้กับเวอร์ชีที่ "ยังไม่บันทึก" (เช็คตอนเปลี่ยน MC version ก่อน SAVE)
      const gameVersion =
        typeof minecraftVersion === 'string' && minecraftVersion !== '' ? minecraftVersion : meta.minecraftVersion;
      const files = await list(instanceId, { kind: packKind });
      const instanceDir = manager.paths(instanceId).dir;
      let registry = (await readModRegistry(instanceDir).catch(() => ({}))) ?? {};
      const adopted = [];
      report('scan', 0, Math.max(files.length, 1), files.length === 0 ? 'Folder is empty' : `Found ${files.length} file${files.length === 1 ? '' : 's'}`);

      if (adopt && typeof modrinthApi.getVersionFiles === 'function') {
        const unknown = files.filter((file) => !registry[file.filename]?.projectId);
        const byHash = new Map();
        let hashed = 0;
        // hash แบบขนาน — หลายไฟล์พร้อมกันแทนการรอทีละไฟล์
        await mapConcurrent(unknown, CHECK_CONCURRENCY, async (file) => {
          report('hash', hashed, Math.max(unknown.length, 1), `Hashing ${unknown.length} unverified file${unknown.length === 1 ? '' : 's'}…`);
          try {
            const hashes = await hashFile(file.path, ['sha1']);
            byHash.set(String(hashes.sha1).toLowerCase(), file);
          } catch {
            // อ่าน/-hash ไม่ได้ → ปล่อยเป็น unmatched
          }
          hashed += 1;
        });
        if (byHash.size > 0) {
          try {
            report('lookup', 0, 1, 'Verifying hashes against Modrinth…');
            const found = await modrinthApi.getVersionFiles([...byHash.keys()]);
            report('lookup', 1, 1, 'Hash lookup complete');
            const byVersion = new Map();
            for (const [hash, version] of Object.entries(found)) {
              const file = byHash.get(hash);
              if (!file || !version) continue;
              const matchedFile =
                (version.files ?? []).find((entry) => String(entry.sha1 ?? '').toLowerCase() === hash)
                ?? (version.files ?? []).find((entry) => entry.filename === file.filename)
                ?? null;
              if (!byVersion.has(version)) byVersion.set(version, []);
              byVersion.get(version).push({
                filename: file.filename,
                url: matchedFile?.url ?? null,
                sha1: hash,
                sha512: matchedFile?.sha512 ?? null,
                size: file.size,
              });
              adopted.push(file.filename);
            }
            for (const [version, records] of byVersion) {
              registry = await recordInstalledMods(instanceDir, version, records, { kind: packKind });
            }
            if (adopted.length > 0) {
              logger?.info('files matched on Modrinth and recorded', {
                instanceId,
                kind: packKind,
                files: adopted,
              });
            }
          } catch (err) {
            logger?.warn('Modrinth file hash lookup failed', { instanceId, kind: packKind, err: err?.message });
          }
        }
      }

      // เทียบกับเวอร์ชีล่าสุด — packs (resourcepacks/shaderpacks) ไม่กรองทั้ง loader และ gameVersions
      // (Modrinth ไม่ได้ tag resource pack ตาม MC ที่ใช้งานได้จริง — tag ขาด ≠ ใช้ไม่ได้ ห้ามโชว์ NOT COMPATIBLE)
      const canListVersions = typeof modrinthApi.listVersions === 'function';
      const versionLists = new Map();
      if (canListVersions) {
        // ดึงรายการเวอร์ชีของทุก project แบบขนาน (เดิม loop await ทีละ project ทีละ request → ช้ามากเมื่อมีหลาย mods)
        const filterOptions =
          packKind === 'mods' ? { gameVersions: [gameVersion], loaders: [meta.loader] } : {};
        const projectIds = [
          ...new Set(
            files
              .map((file) => registry[file.filename]?.projectId)
              .filter((projectId) => typeof projectId === 'string' && projectId !== ''),
          ),
        ];
        let fetched = 0;
        await mapConcurrent(projectIds, CHECK_CONCURRENCY, async (projectId) => {
          const cacheKey = `${projectId}|${gameVersion}|${packKind === 'mods' ? meta.loader : ''}`;
          const cached = versionsCache.get(cacheKey);
          let versions = null;
          if (cached && Date.now() - cached.at < VERSIONS_CACHE_TTL_MS) {
            versions = cached.versions;
          } else {
            try {
              versions = await listVersionsWithRetry(modrinthApi, projectId, filterOptions);
            } catch (err) {
              logger?.warn('update check failed for project', {
                instanceId,
                kind: packKind,
                projectId,
                err: err?.message,
              });
            }
            if (Array.isArray(versions)) {
              versionsCache.set(cacheKey, { at: Date.now(), versions });
            }
          }
          versionLists.set(projectId, versions);
          fetched += 1;
          report('compare', fetched, Math.max(projectIds.length, 1), `Compared ${fetched}/${projectIds.length} projects against latest versions…`);
        });
        if (projectIds.length === 0 && files.length > 0) {
          report('compare', Math.max(files.length, 1), Math.max(files.length, 1), 'Comparison complete');
        }
      }
      const results = [];
      for (const file of files) {
        const entry = registry[file.filename];
        const base = { filename: file.filename, size: file.size };
        if (!entry?.projectId || !entry?.versionId) {
          results.push({
            ...base,
            status: 'unmatched',
            projectId: null,
            versionId: null,
            versionNumber: null,
            latest: null,
            updateAvailable: false,
          });
          continue;
        }
        if (!canListVersions) {
          results.push({
            ...base,
            status: 'unavailable',
            projectId: entry.projectId,
            versionId: entry.versionId,
            versionNumber: entry.versionNumber,
            latest: null,
            updateAvailable: false,
          });
          continue;
        }
        const versions = versionLists.get(entry.projectId);
        if (!Array.isArray(versions)) {
          // ดึงรายการเวอร์ชีไม่สำเร็จ (network/429 หมด retries) — เช็คไม่ได้ ≠ ไม่รองรับ
          results.push({
            ...base,
            status: 'unavailable',
            projectId: entry.projectId,
            versionId: entry.versionId,
            versionNumber: entry.versionNumber,
            latest: null,
            updateAvailable: false,
          });
          continue;
        }
        if (versions.length === 0) {
          // ดึงสำเร็จแต่ไม่มีเวอร์ชีไหนตรง filter (MC version/loader ของ instance) → ไม่พร้อมไปต่อ
          results.push({
            ...base,
            status: 'incompatible',
            projectId: entry.projectId,
            versionId: entry.versionId,
            versionNumber: entry.versionNumber,
            latest: null,
            updateAvailable: false,
          });
          continue;
        }
        // เลือกเวอร์ชีใหม่สุด — mods เทียบ tag กับ MC เป้าหมายก่อน (tag ตรง = ปลอดภัยกว่า);
        // packs (resourcepacks/shaderpacks) ไม่สนเวอร์ชั่นเลย → ใหม่สุดรวมเสมอ
        const preferred =
          packKind === 'mods'
            ? versions.find(
                (version) => Array.isArray(version.gameVersions) && version.gameVersions.includes(gameVersion),
              )
            : null;
        const latest = preferred ?? versions[0];
        const updateAvailable = latest.id !== entry.versionId;
        results.push({
          ...base,
          status: 'checked',
          projectId: entry.projectId,
          versionId: entry.versionId,
          versionNumber: entry.versionNumber,
          latest: { versionId: latest.id, versionNumber: latest.versionNumber },
          updateAvailable,
        });
      }

      const updates = results
        .filter((result) => result.updateAvailable)
        .map((result) => ({
          filename: result.filename,
          projectId: result.projectId,
          from: result.versionNumber,
          to: result.latest.versionNumber,
          versionId: result.latest.versionId,
        }));

      report('done', Math.max(files.length, 1), Math.max(files.length, 1), 'Check complete');

      return {
        instanceId,
        kind: packKind,
        checked: files.length,
        adopted,
        unmatched: results.filter((result) => result.status === 'unmatched').length,
        incompatible: results.filter((result) => result.status === 'incompatible').length,
        unavailable: results.filter((result) => result.status === 'unavailable').length,
        updateCount: updates.length,
        updates,
        files: results,
      };
    },
  };
}
