// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { CancelledError, CorruptDataError, ValidationError } from '../core/errors.js';
import { ensureDirForFile, resolveWithin } from '../core/filesystem.js';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT_BYTES = 0xffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export const ZIP_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxNameLength: 4096,
});

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

export function crc32(data) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function corrupt(message, details) {
  throw new CorruptDataError(message, { details });
}

function rejectZip64(message) {
  corrupt(message, { format: 'zip64' });
}

function assertSupportedLimits(name, value, limit, message) {
  if (value > limit) {
    throw new ValidationError(message, {
      code: 'ZIP_LIMIT_EXCEEDED',
      details: { entry: name, limit },
    });
  }
}

async function readAt(handle, position, length) {
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) {
      corrupt('ZIP file ended unexpectedly', { position: position + read, length });
    }
    read += bytesRead;
  }
  return buffer;
}

async function findEndOfCentralDirectory(handle, size) {
  if (size < EOCD_SIZE) corrupt('File is too small to be a ZIP archive', { size });

  const tailLength = Math.min(size, EOCD_SIZE + MAX_COMMENT_BYTES);
  const tail = await readAt(handle, size - tailLength, tailLength);

  for (let index = tail.length - EOCD_SIZE; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + EOCD_SIZE + commentLength !== tail.length) continue;
    return { position: size - tailLength + index, tail, offset: index };
  }

  corrupt('ZIP end of central directory record not found');
  return null;
}

function parseCentralDirectory(buffer, { maxEntries, maxNameLength }) {
  const entries = [];
  let position = 0;

  while (position + CENTRAL_HEADER_SIZE <= buffer.length) {
    if (buffer.readUInt32LE(position) !== CENTRAL_HEADER_SIGNATURE) {
      corrupt('Invalid ZIP central directory entry', { position });
    }

    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const checksum = buffer.readUInt32LE(position + 16);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const uncompressedSize = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const externalAttributes = buffer.readUInt32LE(position + 38);
    const localHeaderOffset = buffer.readUInt32LE(position + 42);
    const nameStart = position + CENTRAL_HEADER_SIZE;

    if (nameStart + nameLength + extraLength + commentLength > buffer.length) {
      corrupt('ZIP central directory entry is truncated', { position });
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      rejectZip64('ZIP64 archives are not supported');
    }
    if ((flags & 0x1) !== 0) {
      throw new ValidationError('Encrypted ZIP entries are not supported', {
        code: 'ZIP_ENCRYPTED_ENTRY',
        details: { entry: 'unknown' },
      });
    }

    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    if (name.length > maxNameLength) {
      throw new ValidationError('ZIP entry name is too long', {
        code: 'ZIP_LIMIT_EXCEEDED',
        details: { limit: maxNameLength },
      });
    }

    entries.push({
      name,
      normalized: name.split('\\').join('/'),
      method,
      flags,
      checksum,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      externalAttributes,
      mode: (externalAttributes >>> 16) & 0xffff,
      isDirectory: name.endsWith('/') || name.endsWith('\\'),
    });

    if (entries.length > maxEntries) {
      throw new ValidationError('ZIP archive contains too many entries', {
        code: 'ZIP_LIMIT_EXCEEDED',
        details: { limit: maxEntries },
      });
    }

    position = nameStart + nameLength + extraLength + commentLength;
  }

  if (entries.length === 0) corrupt('ZIP archive contains no entries');
  return entries;
}

export async function listZipEntries(file, options = {}) {
  const limits = { ...ZIP_LIMITS, ...options.limits };
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    const { tail, offset } = await findEndOfCentralDirectory(handle, stat.size);
    const entryCount = tail.readUInt16LE(offset + 10);
    const directorySize = tail.readUInt32LE(offset + 12);
    const directoryOffset = tail.readUInt32LE(offset + 16);

    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      rejectZip64('ZIP64 archives are not supported');
    }
    if (entryCount > limits.maxEntries) {
      throw new ValidationError('ZIP archive contains too many entries', {
        code: 'ZIP_LIMIT_EXCEEDED',
        details: { limit: limits.maxEntries },
      });
    }

    const directory = await readAt(handle, directoryOffset, directorySize);
    return parseCentralDirectory(directory, limits);
  } finally {
    await handle.close();
  }
}

async function readEntryData(handle, entry, limits) {
  assertSupportedLimits(entry.name, entry.uncompressedSize, limits.maxEntryBytes, 'ZIP entry is too large');

  const header = await readAt(handle, entry.localHeaderOffset, LOCAL_HEADER_SIZE);
  if (header.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
    corrupt('Invalid ZIP local file header', { entry: entry.name });
  }

  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataOffset = entry.localHeaderOffset + LOCAL_HEADER_SIZE + nameLength + extraLength;
  const payload = await readAt(handle, dataOffset, entry.compressedSize);

  let data;
  if (entry.method === METHOD_STORE) {
    data = payload;
  } else if (entry.method === METHOD_DEFLATE) {
    try {
      data = zlib.inflateRawSync(payload, { maxOutputLength: Math.max(entry.uncompressedSize, 1) });
    } catch (err) {
      corrupt(`Cannot inflate ZIP entry: ${entry.name}`, { entry: entry.name, cause: err.code });
    }
  } else {
    throw new ValidationError(`Unsupported ZIP compression method: ${entry.method}`, {
      code: 'ZIP_UNSUPPORTED_METHOD',
      details: { entry: entry.name, method: entry.method },
    });
  }

  if (data.length !== entry.uncompressedSize) {
    corrupt(`ZIP entry size mismatch: ${entry.name}`, {
      entry: entry.name,
      expected: entry.uncompressedSize,
      actual: data.length,
    });
  }

  const actual = crc32(data);
  if (actual !== entry.checksum) {
    corrupt(`ZIP entry checksum mismatch: ${entry.name}`, {
      entry: entry.name,
      expected: entry.checksum,
      actual,
    });
  }

  return data;
}

export async function readZipEntry(file, entry, options = {}) {
  const limits = { ...ZIP_LIMITS, ...options.limits };
  const handle = await fsp.open(file, 'r');
  try {
    return await readEntryData(handle, entry, limits);
  } finally {
    await handle.close();
  }
}

function matchesPrefixes(name, prefixes) {
  for (const prefix of prefixes) {
    if (prefix && name.startsWith(prefix)) return true;
  }
  return false;
}

export async function extractZip(file, destDir, options = {}) {
  const limits = { ...ZIP_LIMITS, ...options.limits };
  const exclude = options.exclude ?? [];
  const include = options.include ?? null;
  const signal = options.signal ?? null;
  const onEntry = typeof options.onEntry === 'function' ? options.onEntry : null;

  const entries = await listZipEntries(file, { limits });
  const handle = await fsp.open(file, 'r');
  const extracted = [];
  let totalBytes = 0;

  try {
    for (const entry of entries) {
      if (signal?.aborted) {
        throw new CancelledError('Extraction cancelled', { details: { file } });
      }
      if (entry.isDirectory) continue;

      const name = entry.normalized ?? entry.name;
      if (matchesPrefixes(name, exclude)) continue;
      if (Array.isArray(include) && include.length > 0 && !matchesPrefixes(name, include)) continue;

      const target = resolveWithin(destDir, name);
      const data = await readEntryData(handle, entry, limits);

      totalBytes += data.length;
      if (totalBytes > limits.maxTotalBytes) {
        throw new ValidationError('ZIP archive expands beyond the allowed size', {
          code: 'ZIP_LIMIT_EXCEEDED',
          details: { limit: limits.maxTotalBytes },
        });
      }

      await ensureDirForFile(target);
      await fsp.writeFile(target, data, { mode: nativeFileMode(target) });
      extracted.push({ name, target, bytes: data.length });
      onEntry?.({ name, target, bytes: data.length });
    }
  } finally {
    await handle.close();
  }

  return { files: extracted, count: extracted.length, bytes: totalBytes, destDir };
}

function nativeFileMode(target) {
  const lower = target.toLowerCase();
  if (lower.endsWith('.so') || lower.endsWith('.dll') || lower.endsWith('.dylib') || lower.endsWith('.jnilib')) {
    return 0o755;
  }
  return 0o644;
}
