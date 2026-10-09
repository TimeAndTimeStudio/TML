// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ValidationError } from '../core/errors.js';
import { ensureDirForFile, pathExists, readJson, removePath } from '../core/filesystem.js';

export const SESSION_FILE_NAME = 'auth-session.json';

const SESSION_MODE = 0o600;

function invalidStore(message, details) {
  return new ValidationError(message, { code: 'INVALID_TOKEN_STORE', details });
}

function isValidSession(data) {
  return (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    typeof data.username === 'string' &&
    data.username !== '' &&
    typeof data.uuid === 'string' &&
    data.uuid !== '' &&
    typeof data.accessToken === 'string' &&
    data.accessToken !== ''
  );
}

export function createTokenStore({ file, logger = null }) {
  if (typeof file !== 'string' || file === '') {
    throw invalidStore('createTokenStore() requires a session file path');
  }

  let cached = null;

  async function writeAtomic(session) {
    await ensureDirForFile(file);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', mode: SESSION_MODE });
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    await fsp.chmod(file, SESSION_MODE).catch(() => {});
  }

  function expired(session) {
    return Number.isFinite(session.expiresAt) && session.expiresAt <= Date.now();
  }

  async function read() {
    if (cached !== null) {
      // อายุหมดระหว่างที่ cache ค้าง → ลบ session ทันที (logout auto)
      if (expired(cached)) {
        await clear();
        return null;
      }
      return cached;
    }
    if (!(await pathExists(file))) return null;

    let data;
    try {
      data = await readJson(file);
    } catch (err) {
      logger?.warn('stored session is corrupt, signing out', { code: err?.code ?? null });
      await removePath(file).catch(() => {});
      return null;
    }

    if (!isValidSession(data)) {
      logger?.warn('stored session has an invalid shape, signing out', {});
      await removePath(file).catch(() => {});
      return null;
    }

    if (expired(data)) {
      logger?.debug('session expired, signing out', {});
      await removePath(file).catch(() => {});
      return null;
    }

    cached = Object.freeze({ ...data });
    return cached;
  }

  async function save(session) {
    if (!isValidSession(session)) {
      throw invalidStore('Session is missing username, uuid or accessToken', {
        fields: ['username', 'uuid', 'accessToken'],
      });
    }

    const stored = Object.freeze({
      type: 'msa',
      userType: typeof session.userType === 'string' && session.userType !== '' ? session.userType : 'msa',
      uuid: session.uuid,
      username: session.username,
      accessToken: session.accessToken,
      refreshToken: typeof session.refreshToken === 'string' ? session.refreshToken : null,
      expiresAt: Number.isFinite(session.expiresAt) ? session.expiresAt : null,
      xuid: typeof session.xuid === 'string' && session.xuid !== '' ? session.xuid : null,
      savedAt: Date.now(),
    });

    await writeAtomic(stored);
    cached = stored;
    logger?.debug('session stored', { username: stored.username, uuid: stored.uuid });
    return publicSession(stored);
  }

  async function clear() {
    cached = null;
    if (await pathExists(file)) {
      await removePath(file);
      logger?.debug('session cleared', {});
    }
  }

  function publicSession(session) {
    if (!session) return null;
    return {
      signedIn: true,
      username: session.username,
      uuid: session.uuid,
      xuid: session.xuid ?? null,
      userType: session.userType ?? 'msa',
      expiresAt: session.expiresAt ?? null,
    };
  }

  return { read, save, clear, publicSession, file: path.resolve(file) };
}
