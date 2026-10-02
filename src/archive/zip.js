// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { CancelledError, ValidationError } from '../core/errors.js';
import { ensureDirForFile } from '../core/filesystem.js';
import { ZIP_LIMITS, crc32 } from './unzip.js';

export const ZIP_METHOD_STORE = 0;
export const ZIP_METHOD_DEFLATE = 8;

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const VERSION_NEEDED = 20;
const DOS_DATE = 0x21;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function invalidName(message, details) {
  return new ValidationError(message, { code: 'ZIP_INVALID_ENTRY_NAME', details });
}

export function validateZipEntryName(name, { dir = false, limits = ZIP_LIMITS } = {}) {
  if (typeof name !== 'string' || name === '') {
    throw invalidName('ZIP entry name must be a non-empty string', { name: typeof name === 'string' ? name : typeof name });
  }
  if (name.includes('\\')) {
    throw invalidName('ZIP entry names must use "/" separators', { name });
  }
  if (CONTROL_CHARS.test(name)) {
    throw invalidName('ZIP entry names must not contain control characters', { name });
  }
  if (name.startsWith('/')) {
    throw invalidName('ZIP entry names must be relative', { name });
  }
  if (/^[A-Za-z]:/.test(name)) {
    throw invalidName('ZIP entry names must not contain a drive prefix', { name });
  }

  const body = dir ? name.slice(0, -1) : name;
  if (dir && !name.endsWith('/')) {
    throw invalidName('Directory entries must end with "/"', { name });
  }
  if (!dir && name.endsWith('/')) {
    throw invalidName('File entries must not end with "/"', { name });
  }
  if (body === '') {
    throw invalidName('ZIP entry name resolves to nothing', { name });
  }
  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw invalidName('ZIP entry names must not contain empty, "." or ".." segments', { name });
    }
  }

  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes > limits.maxNameLength) {
    throw new ValidationError('ZIP entry name is too long', {
      code: 'ZIP_LIMIT_EXCEEDED',
      details: { limit: limits.maxNameLength, bytes },
    });
  }
  if (bytes > MAX_UINT16) {
    throw new ValidationError('ZIP entry name does not fit the archive format', {
      code: 'ZIP_LIMIT_EXCEEDED',
      details: { limit: MAX_UINT16, bytes },
    });
  }
  return name;
}

function resolveMethod(entry) {
  const value = entry?.method;
  if (value === undefined || value === null) return 'deflate';
  if (value === ZIP_METHOD_STORE || value === 'store') return 'store';
  if (value === ZIP_METHOD_DEFLATE || value === 'deflate') return 'deflate';
  throw new ValidationError('Unknown ZIP compression method', {
    code: 'ZIP_INVALID_METHOD',
    details: { method: typeof value === 'string' ? value : typeof value },
  });
}

async function normalizeEntry(entry, limits) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ValidationError('ZIP entries must be objects', { code: 'ZIP_INVALID_ENTRY' });
  }

  const dir = entry.dir === true;
  const name = validateZipEntryName(entry.name, { dir, limits });

  if (dir) {
    if (entry.data !== undefined || entry.file !== undefined) {
      throw new ValidationError('Directory entries must not carry data', { code: 'ZIP_INVALID_ENTRY', details: { name } });
    }
    return {
      name,
      dir: true,
      method: ZIP_METHOD_STORE,
      payload: Buffer.alloc(0),
      rawSize: 0,
      crc: 0,
      mode: entry.mode ?? 0o40755,
    };
  }

  const hasData = entry.data !== undefined;
  const hasFile = entry.file !== undefined;
  if (hasData && hasFile) {
    throw new ValidationError('ZIP entries must carry either "data" or "file", not both', {
      code: 'ZIP_INVALID_ENTRY',
      details: { name },
    });
  }
  if (!hasData && !hasFile) {
    throw new ValidationError('ZIP entries must carry "data" or "file"', {
      code: 'ZIP_INVALID_ENTRY',
      details: { name },
    });
  }

  let raw;
  if (hasFile) {
    if (typeof entry.file !== 'string' || entry.file === '') {
      throw new ValidationError('"file" must be a non-empty path', { code: 'ZIP_INVALID_ENTRY', details: { name } });
    }
    raw = await fsp.readFile(entry.file);
  } else if (Buffer.isBuffer(entry.data)) {
    raw = entry.data;
  } else if (typeof entry.data === 'string') {
    raw = Buffer.from(entry.data, 'utf8');
  } else {
    throw new ValidationError('"data" must be a Buffer or string', { code: 'ZIP_INVALID_ENTRY', details: { name } });
  }

  if (raw.length > limits.maxEntryBytes) {
    throw new ValidationError('ZIP entry is too large', {
      code: 'ZIP_LIMIT_EXCEEDED',
      details: { entry: name, limit: limits.maxEntryBytes, size: raw.length },
    });
  }
  if (raw.length > MAX_UINT32) {
    throw new ValidationError('ZIP entry does not fit the archive format', {
      code: 'ZIP_LIMIT_EXCEEDED',
      details: { entry: name, limit: MAX_UINT32, size: raw.length },
    });
  }

  const crc = crc32(raw);
  const requested = resolveMethod(entry);
  let method = ZIP_METHOD_STORE;
  let payload = raw;
  if (requested === 'deflate') {
    const deflated = zlib.deflateRawSync(raw);
    if (deflated.length < raw.length) {
      method = ZIP_METHOD_DEFLATE;
      payload = deflated;
    }
  }
  if (payload.length > MAX_UINT32) {
    throw new ValidationError('ZIP entry does not fit the archive format', {
      code: 'ZIP_LIMIT_EXCEEDED',
      details: { entry: name, limit: MAX_UINT32, size: payload.length },
    });
  }

  return {
    name,
    dir: false,
    method,
    payload,
    rawSize: raw.length,
    crc,
    mode: entry.mode ?? 0o100644,
  };
}

function buildLocalHeader(record, nameLength) {
  const header = Buffer.alloc(LOCAL_HEADER_SIZE);
  header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(record.method, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(record.crc, 14);
  header.writeUInt32LE(record.payload.length, 18);
  header.writeUInt32LE(record.rawSize, 22);
  header.writeUInt16LE(nameLength, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function buildCentralHeader(record, nameLength, offset) {
  const header = Buffer.alloc(CENTRAL_HEADER_SIZE);
  header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(VERSION_NEEDED, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(record.method, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(record.crc, 16);
  header.writeUInt32LE(record.payload.length, 20);
  header.writeUInt32LE(record.rawSize, 24);
  header.writeUInt16LE(nameLength, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(((record.mode & 0xffff) << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

function buildEocd(entryCount, centralSize, centralOffset) {
  const eocd = Buffer.alloc(EOCD_SIZE);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

export async function writeZipFile(entries, outFile, options = {}) {
  if (!Array.isArray(entries)) {
    throw new ValidationError('writeZipFile() requires an array of entries', { code: 'ZIP_INVALID_ENTRIES' });
  }
  if (typeof outFile !== 'string' || outFile === '') {
    throw new ValidationError('writeZipFile() requires an output path', { code: 'INVALID_ZIP_PATH' });
  }
  const limits = { ...ZIP_LIMITS, ...options.limits };
  const signal = options.signal ?? null;

  if (entries.length === 0) {
    throw new ValidationError('ZIP archive requires at least one entry', { code: 'ZIP_EMPTY_ARCHIVE' });
  }
  if (entries.length > limits.maxEntries) {
    throw new ValidationError('ZIP archive contains too many entries', {
      code: 'ZIP_LIMIT_EXCEEDED',
      details: { limit: limits.maxEntries, entries: entries.length },
    });
  }

  const records = [];
  const seen = new Set();
  for (const entry of entries) {
    const record = await normalizeEntry(entry, limits);
    if (seen.has(record.name)) {
      throw new ValidationError('ZIP archive contains a duplicate entry name', {
        code: 'ZIP_DUPLICATE_ENTRY',
        details: { name: record.name },
      });
    }
    seen.add(record.name);
    records.push(record);
  }

  if (signal?.aborted) {
    throw new CancelledError('ZIP creation cancelled', { details: { file: outFile } });
  }

  await ensureDirForFile(outFile);
  const tmpFile = `${outFile}.part`;
  let offset = 0;
  let handle = null;

  const write = async (buffer) => {
    await handle.write(buffer);
    offset += buffer.length;
  };

  try {
    handle = await fsp.open(tmpFile, 'w');
    const central = [];

    for (const record of records) {
      if (signal?.aborted) {
        throw new CancelledError('ZIP creation cancelled', { details: { file: outFile, entry: record.name } });
      }
      const nameBuffer = Buffer.from(record.name, 'utf8');
      const localOffset = offset;
      await write(buildLocalHeader(record, nameBuffer.length));
      await write(nameBuffer);
      if (record.payload.length > 0) await write(record.payload);

      central.push(buildCentralHeader(record, nameBuffer.length, localOffset), nameBuffer);
    }

    const centralBuffer = Buffer.concat(central);
    await write(centralBuffer);
    await write(buildEocd(records.length, centralBuffer.length, offset - centralBuffer.length));

    await handle.close();
    handle = null;
    await fsp.rename(tmpFile, outFile);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // best effort: the handle is already failing
      }
    }
    await fsp.rm(tmpFile, { force: true }).catch(() => {});
    throw err;
  }

  const stat = await fsp.stat(outFile);
  return Object.freeze({
    path: outFile,
    count: records.length,
    bytes: stat.size,
    entries: Object.freeze(
      records.map((record) =>
        Object.freeze({
          name: record.name,
          dir: record.dir,
          method: record.method,
          size: record.rawSize,
          compressedSize: record.payload.length,
        }),
      ),
    ),
  });
}
