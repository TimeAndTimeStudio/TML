// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CorruptDataError, ValidationError } from './errors.js';

export async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function ensureDirForFile(file) {
  await ensureDir(path.dirname(file));
  return file;
}

function wrapFsError(err, file) {
  if (err && typeof err === 'object' && err.code === 'ENOENT') {
    return new ValidationError(`File not found: ${file}`, {
      code: 'FILE_NOT_FOUND',
      cause: err,
      details: { file },
    });
  }
  return err;
}

export async function readJson(file, { optional = false } = {}) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (optional && err.code === 'ENOENT') return null;
    throw wrapFsError(err, file);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CorruptDataError(`Invalid JSON in file: ${file}`, {
      cause: err,
      details: { file },
    });
  }
}

export async function writeFileAtomic(file, data, { encoding = 'utf8' } = {}) {
  await ensureDirForFile(file);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, data, encoding);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw wrapFsError(err, file);
  }
  return file;
}

export async function writeJson(file, value, { pretty = true } = {}) {
  const text = pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value);
  return writeFileAtomic(file, text);
}

export async function removePath(target) {
  await fsp.rm(target, { recursive: true, force: true });
}

export function resolveWithin(base, target) {
  const baseResolved = path.resolve(base);
  const targetResolved = path.resolve(baseResolved, String(target));
  const relative = path.relative(baseResolved, targetResolved);

  const escapes = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapes) {
    throw new ValidationError(`Path escapes its base directory: ${target}`, {
      code: 'PATH_ESCAPE',
      details: { base: baseResolved, target: String(target) },
    });
  }
  return targetResolved;
}
