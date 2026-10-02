// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AuthError, NotFoundError, ValidationError } from '../core/errors.js';
import { httpClient } from '../net/http.js';

// Minecraft Services API — เปลี่ยน skin ด้วย access token ของ Minecraft (ตัวเดียวกับที่ใช้เล่น)
export const SKIN_UPLOAD_URL = 'https://api.minecraftservices.com/minecraft/profile/skins';
export const SKIN_RESET_URL = 'https://api.minecraftservices.com/minecraft/profile/skins/active';
// profile ของบัญชี → skin ที่ใช้อยู่ตอนนี้ (url บน textures.minecraft.net)
export const SKIN_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
export const SKIN_VARIANTS = Object.freeze(['classic', 'slim']);
export const SKIN_DEFAULT_VARIANT = 'classic';
// skin PNG จริง ๆ ใหญ่ไม่กี่สิบ KB — จำกัดไว้กัน abuse (base64 ยังไม่ชน JSON body limit 1MB ของ server)
export const SKIN_MAX_BYTES = 512 * 1024;
// skin ของ Java Edition ต้องเป็น 64x64 (modern) หรือ 64x32 (legacy เท่านั้น)
export const SKIN_ALLOWED_SIZES = Object.freeze([
  [64, 64],
  [64, 32],
]);
// ชื่อไฟล์ใน cache/assets/skins/<xx>/<hash> เป็น hex 40 ตัว (sha1) หรือ 64 ตัว (จาก texture url)
// ไฟล์ที่ TML เองเก็บตอนอัปโหลดอยู่คนละที่: cache/assets/skins/uploaded/<xx>/<hash> (เกมไม่เขียนตรงนี้)
export const SKIN_TEXTURE_HASH_PATTERN = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
export const SKIN_TEXTURE_MAX_BYTES = 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR = Buffer.from('IHDR', 'ascii');

function invalidSkin(message, details = {}) {
  return new ValidationError(message, { code: 'INVALID_SKIN', details: { field: 'data', ...details } });
}

// อ่านขนาดจาก PNG IHDR (offset คงที่ตามมาตรฐาน PNG — ไม่ต้องถอด image ทั้งไฟล์)
export function readPngSize(data) {
  if (!Buffer.isBuffer(data) || data.length < 24) return null;
  if (!data.subarray(12, 16).equals(PNG_IHDR)) return null;
  try {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  } catch {
    return null;
  }
}

export function validateSkinImage(data) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw invalidSkin('A skin image is required (PNG file)');
  }
  if (data.length > SKIN_MAX_BYTES) {
    throw invalidSkin(`Skin image must be ${SKIN_MAX_BYTES} bytes or smaller`, {
      maxBytes: SKIN_MAX_BYTES,
      bytes: data.length,
    });
  }
  if (data.length < PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw invalidSkin('Skin image must be a PNG file');
  }
  const size = readPngSize(data);
  if (size === null) {
    throw invalidSkin('Skin image is not a valid PNG (missing IHDR header)');
  }
  const allowed = SKIN_ALLOWED_SIZES.some(([w, h]) => w === size.width && h === size.height);
  if (!allowed) {
    throw invalidSkin(
      `Skin must be 64x64 or 64x32 pixels (got ${size.width}x${size.height})`,
      { width: size.width, height: size.height },
    );
  }
  return data;
}

// multipart/form-data ประกอบเองด้วย Buffer (ไม่มี npm dependency — เฉพาะ Boundary สุ่มด้วย crypto)
export function buildSkinMultipart({ variant, data, filename = 'skin.png' }) {
  const boundary = `----tmlskin${crypto.randomBytes(12).toString('hex')}`;
  // filename ใส่ได้เฉพาะชื่อไฟล์โล่ง ๆ ไม่มี quotes/CRLF (กัน header injection)
  const safeName = String(filename).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 100) || 'skin.png';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `content-disposition: form-data; name="variant"\r\n\r\n` +
      `${variant}\r\n` +
      `--${boundary}\r\n` +
      `content-disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      `content-type: image/png\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, data, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function readUpstreamMessage(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) return null;
  try {
    const data = JSON.parse(body.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    for (const key of ['errorMessage', 'error_description', 'error', 'message']) {
      const value = data[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 300);
    }
  } catch {
    /* ไม่ใช่ JSON — ไม่มีอะไรให้อ่าน */
  }
  return null;
}

function parseJsonBody(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) return null;
  try {
    const data = JSON.parse(body.toString('utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

// แปลสถานะผิดของ Minecraft Services เป็นข้อความที่ผู้ใช้อ่านรู้เรื่อง
function skinHttpError(res, stage) {
  const upstream = readUpstreamMessage(res.body);
  const status = res.status;
  const base = { stage, status: status >= 500 ? 502 : status, details: { stage, status } };
  if (upstream) base.details.upstream = upstream;

  if (status === 401) {
    return new AuthError('Your Minecraft session has expired — refresh and try again', {
      ...base,
      status: 401,
      code: 'AUTH_TOKEN_EXPIRED',
    });
  }
  if (status === 403) {
    return new AuthError(
      upstream
        ? `Minecraft refused the skin change — ${upstream}`
        : 'This account cannot change skins right now (own Minecraft for Java Edition is required)',
      { ...base, status: 403, code: 'SKIN_REFUSED' },
    );
  }
  if (status === 429) {
    return new AuthError('Too many requests — wait a moment and try again', {
      ...base,
      status: 429,
      code: 'SKIN_THROTTLED',
    });
  }
  if (status === 400) {
    return new AuthError(upstream ? `Minecraft rejected the skin — ${upstream}` : 'Minecraft rejected the skin image', {
      ...base,
      status: 400,
      code: 'SKIN_REJECTED',
    });
  }
  return new AuthError(upstream ? `Skin change failed — ${upstream}` : 'Skin change failed', {
    ...base,
    status: 502,
    code: 'SKIN_FAILED',
  });
}

// อ่านไฟล์สกินจาก cache ถ้าเป็น PNG ที่ขนาดพอใช้ — คืน null ถ้าไฟล์เสีย/ไม่ใช่รูป
async function readTextureFile(file) {
  try {
    const data = await fsp.readFile(file);
    if (data.length === 0 || data.length > SKIN_TEXTURE_MAX_BYTES) return null;
    if (!data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
    return data;
  } catch {
    return null;
  }
}

// หาไฟล์ใหม่สุดใน cache/assets/skins/<xx>/<hash> (ที่เกมเขียนไว้ระหว่างเล่น)
async function newestTextureFile(dir) {
  let prefixes;
  try {
    prefixes = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest = null;
  for (const prefix of prefixes) {
    if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
    let files;
    try {
      files = await fsp.readdir(path.join(dir, prefix.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !/^[a-f0-9]{40}$/.test(file.name)) continue;
      const full = path.join(dir, prefix.name, file.name);
      try {
        const stat = await fsp.stat(full);
        if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs: stat.mtimeMs };
      } catch {
        /* ข้ามไฟล์ที่อ่าน stat ไม่ได้ */
      }
    }
  }
  return newest?.file ?? null;
}

export function createSkinService({ config = null, http = httpClient, logger = null, dir = null } = {}) {
  // cache ของสกิน = ที่เดียวกับที่เกมเก็บ (tml-data/cache/assets/skins/<xx>/<hash>)
  const skinCacheDir =
    dir ?? (config?.paths?.cacheDir ? path.join(config.paths.cacheDir, 'assets', 'skins') : null);
  function requireToken(token) {
    if (typeof token !== 'string' || token === '') {
      throw new AuthError('Sign in with a Microsoft account to change your skin', {
        code: 'AUTH_NO_SESSION',
        status: 401,
        details: { stage: 'config' },
      });
    }
    return token;
  }

  async function call(method, url, { token, body = null, headers = {} }) {
    const res = await http.request(url, {
      method,
      body,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...headers,
      },
      source: 'microsoft',
    });
    return res;
  }

  // ไฟล์ที่อัปโหลดผ่าน TML เก็บไว้ใต้ uploaded/ — แยกจากไฟล์ที่เกมเขียนเองเพื่อลบทิ้งได้ภายหลัง
  function uploadedFileFor(hash) {
    return path.join(skinCacheDir, 'uploaded', hash.slice(0, 2), hash);
  }

  async function storeUploaded(hash, data) {
    if (!skinCacheDir || !SKIN_TEXTURE_HASH_PATTERN.test(hash)) return;
    const file = uploadedFileFor(hash);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, data);
  }

  async function removeUploaded(hash) {
    if (!skinCacheDir) return;
    await fsp.rm(uploadedFileFor(hash), { force: true });
  }

  // เก็บเฉพาะรูปอัปโหลดล่าสุด (keepHash) — รูปอื่นที่เราเคยเก็บไว้กลายเป็น stale แล้ว
  async function pruneUploaded(keepHash = null) {
    if (!skinCacheDir) return;
    const root = path.join(skinCacheDir, 'uploaded');
    let prefixes;
    try {
      prefixes = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const prefix of prefixes) {
      if (!prefix.isDirectory()) continue;
      const dirPath = path.join(root, prefix.name);
      let names;
      try {
        names = await fsp.readdir(dirPath);
      } catch {
        continue;
      }
      for (const name of names) {
        if (keepHash !== null && name === keepHash) continue;
        await fsp.rm(path.join(dirPath, name), { force: true });
      }
    }
  }

  async function upload({ token, data, variant = SKIN_DEFAULT_VARIANT, filename = 'skin.png' }) {
    requireToken(token);
    if (typeof variant !== 'string' || !SKIN_VARIANTS.includes(variant)) {
      throw new ValidationError(`Skin variant must be one of: ${SKIN_VARIANTS.join(', ')}`, {
        code: 'INVALID_SKIN_VARIANT',
        details: { field: 'variant', known: [...SKIN_VARIANTS] },
      });
    }
    validateSkinImage(data);

    const { body, contentType } = buildSkinMultipart({ variant, data, filename });
    const res = await call('POST', SKIN_UPLOAD_URL, {
      token,
      body,
      headers: { 'content-type': contentType },
    });

    if (res.status < 200 || res.status >= 300) throw skinHttpError(res, 'upload');
    logger?.debug('skin uploaded', { variant, bytes: data.length });

    // เก็บรูปที่เพิ่งอัปโหลดลง cache ทันที → ปิดเปิดแอปใหม่ preview ยังเห็นรูป โดยไม่ต้องรอเกมโหลด
    // ต่อไปถ้าเกมเขียนรูปชุดนี้ลง cache ของตัวเอง texture() จะลบไฟล์ฝั่งเรา แล้วใช้ของเกมแทน
    let hash = null;
    if (skinCacheDir) {
      try {
        const profile = await active({ token });
        const entries = Array.isArray(profile?.skins) ? profile.skins : [];
        const activeEntry = entries.find((entry) => entry.state === 'ACTIVE') ?? entries[0] ?? null;
        const candidate = activeEntry?.url ? String(activeEntry.url).split('/').pop() : '';
        if (SKIN_TEXTURE_HASH_PATTERN.test(candidate)) {
          hash = candidate;
          await storeUploaded(hash, data);
          await pruneUploaded(hash); // เก็บเฉพาะรอบล่าสุด รูปอัปโหลดก่อนหน้าทิ้งไป
          logger?.debug('uploaded skin cached locally', { hash });
        }
      } catch (err) {
        logger?.warn('uploaded skin not cached locally', { err: err instanceof Error ? err.message : String(err) });
      }
    }
    return { changed: true, variant, hash, profile: parseJsonBody(res.body) };
  }

  async function reset({ token }) {
    requireToken(token);
    const res = await call('DELETE', SKIN_RESET_URL, { token });
    if (res.status < 200 || res.status >= 300) throw skinHttpError(res, 'reset');
    logger?.debug('skin reset to default', {});
    return { changed: true };
  }

  // อ่าน skin ที่ใช้อยู่ตอนนี้จาก Minecraft profile (ไม่มีในรายการ = ยังไม่เคยเปลี่ยน → default)
  async function active({ token }) {
    requireToken(token);
    const res = await call('GET', SKIN_PROFILE_URL, { token });
    if (res.status === 404) return { username: null, skins: [] };
    if (res.status < 200 || res.status >= 300) throw skinHttpError(res, 'profile');
    const profile = parseJsonBody(res.body) ?? {};
    const skins = Array.isArray(profile.skins)
      ? profile.skins
          .filter((entry) => entry && typeof entry.url === 'string' && entry.url !== '')
          .map((entry) => ({
            // API คืนเป็น http:// — บังคับเป็น https กัน browser บล็อก mixed content / CSP
            url: entry.url.replace(/^http:\/\//i, 'https://'),
            alias: typeof entry.alias === 'string' ? entry.alias : null,
            state: typeof entry.state === 'string' ? entry.state : null,
          }))
      : [];
    logger?.debug('active skin read', { count: skins.length });
    return { username: typeof profile.name === 'string' ? profile.name : null, skins };
  }

  // อ่านรูปสกินจาก cache บนเครื่องเท่านั้น — ไม่มีการยิงออกไปโหลดจาก textures.minecraft.net เลย
  // ลำดับ: ไฟล์ที่เกมเขียน → ไฟล์ที่ TML เก็บตอนอัปโหลด (ถ้าเกมมีรูปชุดเดียวกันแล้ว ลบฝั่งเราทิ้ง) → ไฟล์ใหม่สุดของเกม
  async function texture({ hash = null } = {}) {
    const wanted = hash === null || hash === undefined || hash === '' ? null : String(hash);
    if (wanted !== null && !SKIN_TEXTURE_HASH_PATTERN.test(wanted)) {
      throw new ValidationError('A skin hash must be 40 or 64 lowercase hex characters', {
        code: 'INVALID_SKIN_HASH',
        details: { field: 'hash' },
      });
    }
    if (!skinCacheDir) {
      throw new NotFoundError('Skin cache is not available on this machine', {
        code: 'SKIN_NOT_CACHED',
        details: { hash: wanted },
      });
    }

    if (wanted) {
      await pruneUploaded(wanted);

      const exact = path.join(skinCacheDir, wanted.slice(0, 2), wanted);
      const exactData = await readTextureFile(exact);
      if (exactData) {
        // แคชของเกมมีไฟล์ชุดนี้แล้ว → ลบที่อัปโหลดไว้ ใช้ของเกม
        await removeUploaded(wanted);
        logger?.debug('skin read from local cache', { hash: wanted, matched: 'exact' });
        return { hash: wanted, data: exactData, source: 'exact' };
      }

      const uploadedData = await readTextureFile(uploadedFileFor(wanted));
      if (uploadedData) {
        // เกมโหลดรูปชุดนี้ลง cache แล้ว (ไฟล์ใหม่สุดของเกมเนื้อหาเดียวกัน)
        // → ลบไฟล์ที่เราอัปโหลดไว้ แล้วใช้แคชของเกมแทน
        const gameFile = await newestTextureFile(skinCacheDir);
        const gameData = gameFile ? await readTextureFile(gameFile) : null;
        if (gameData && gameData.equals(uploadedData)) {
          await removeUploaded(wanted);
          logger?.debug('skin read from local cache', { hash: wanted, matched: 'game-newest' });
          return { hash: path.basename(gameFile), data: gameData, source: 'newest' };
        }
        // แคชของเกมยังไม่ใช่รูปชุดนี้ → ใช้รูปที่เพิ่งอัปโหลดไปก่อน
        logger?.debug('skin read from uploaded cache', { hash: wanted });
        return { hash: wanted, data: uploadedData, source: 'uploaded' };
      }
    }

    // ชื่อไฟล์ใน cache ไม่ตรงกับ hash ใน profile (Mojang เก็บคนละ id แต่รูปเดียวกัน) → เอาไฟล์ใหม่สุดใน cache
    const fallback = await newestTextureFile(skinCacheDir);
    if (fallback) {
      const data = await readTextureFile(fallback);
      if (data) {
        logger?.debug('skin read from local cache', { file: path.basename(fallback), matched: 'newest' });
        return { hash: path.basename(fallback), data, source: 'newest' };
      }
    }

    throw new NotFoundError(
      'This skin is not cached on this machine yet — upload it in the skin window or launch the game once',
      { code: 'SKIN_NOT_CACHED', details: { hash: wanted } },
    );
  }

  return { upload, reset, active, texture, source: 'minecraft' };
}
