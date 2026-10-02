// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import crypto from 'node:crypto';
import fs from 'node:fs';
import { ChecksumMismatchError, ValidationError } from '../core/errors.js';

export const HASH_ALGORITHMS = Object.freeze(['sha1', 'sha512']);

const HEX_LENGTHS = Object.freeze({ sha1: 40, sha512: 128 });
const HEX_PATTERNS = Object.freeze({
  sha1: /^[0-9a-f]{40}$/i,
  sha512: /^[0-9a-f]{128}$/i,
});

export function isHashAlgorithm(algorithm) {
  return typeof algorithm === 'string' && Object.hasOwn(HEX_LENGTHS, algorithm.toLowerCase());
}

export function normalizeAlgorithm(algorithm) {
  const normalized = typeof algorithm === 'string' ? algorithm.trim().toLowerCase() : algorithm;
  if (!isHashAlgorithm(normalized)) {
    throw new ValidationError(`Unsupported hash algorithm: ${String(algorithm)}`, {
      code: 'UNSUPPORTED_HASH_ALGORITHM',
      details: { algorithm: String(algorithm), supported: [...HASH_ALGORITHMS] },
    });
  }
  return normalized;
}

export function normalizeHash(value, algorithm = 'sha1') {
  const algo = normalizeAlgorithm(algorithm);
  if (typeof value !== 'string' || !HEX_PATTERNS[algo].test(value.trim())) {
    throw new ValidationError(`Invalid ${algo} hash`, {
      code: 'INVALID_HASH',
      details: { algorithm: algo, expectedLength: HEX_LENGTHS[algo] },
    });
  }
  return value.trim().toLowerCase();
}

function toAlgorithmList(algorithms) {
  const list = Array.isArray(algorithms) ? algorithms : [algorithms];
  if (list.length === 0) {
    throw new ValidationError('At least one hash algorithm is required', {
      code: 'UNSUPPORTED_HASH_ALGORITHM',
      details: { supported: [...HASH_ALGORITHMS] },
    });
  }
  return [...new Set(list.map((entry) => normalizeAlgorithm(entry)))];
}

export function createHasher(algorithms = HASH_ALGORITHMS) {
  const list = toAlgorithmList(algorithms);
  const hashes = new Map(list.map((algo) => [algo, crypto.createHash(algo)]));
  let finalized = false;

  return {
    algorithms: [...list],
    update(chunk) {
      if (finalized) {
        throw new ValidationError('Hasher was already finalized', { code: 'HASHER_FINALIZED' });
      }
      for (const hash of hashes.values()) hash.update(chunk);
    },
    digest() {
      if (finalized) {
        throw new ValidationError('Hasher was already finalized', { code: 'HASHER_FINALIZED' });
      }
      finalized = true;
      const out = {};
      for (const [algo, hash] of hashes) out[algo] = hash.digest('hex');
      return out;
    },
  };
}

export function hashBuffer(data, algorithms = ['sha1']) {
  const list = toAlgorithmList(algorithms);
  const hasher = createHasher(list);
  hasher.update(data);
  return hasher.digest();
}

export function hashFile(file, algorithms = ['sha1']) {
  const list = toAlgorithmList(algorithms);
  const hasher = createHasher(list);

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hasher.update(chunk));
    stream.on('end', () => {
      try {
        resolve(hasher.digest());
      } catch (err) {
        reject(err);
      }
    });
  });
}

function pickExpected(expected) {
  if (expected === null || expected === undefined) return {};
  if (typeof expected !== 'object' || Array.isArray(expected)) {
    throw new ValidationError('Hash expectation must be an object', { code: 'INVALID_HASH' });
  }

  const wanted = {};
  for (const algo of HASH_ALGORITHMS) {
    const value = expected[algo];
    if (value === undefined || value === null || value === '') continue;
    wanted[algo] = normalizeHash(value, algo);
  }
  return wanted;
}

export function verifyHashes(hashes, expected = {}, { file } = {}) {
  const wanted = pickExpected(expected);
  const mismatches = [];

  for (const [algo, want] of Object.entries(wanted)) {
    const actual = typeof hashes?.[algo] === 'string' ? hashes[algo].toLowerCase() : null;
    if (actual !== want) mismatches.push({ algorithm: algo, expected: want, actual });
  }

  if (mismatches.length > 0) {
    throw new ChecksumMismatchError(`Checksum mismatch${file ? ` for ${file}` : ''}`, {
      details: { file, mismatches },
    });
  }

  return { ok: true, checked: Object.keys(wanted), hashes: wanted };
}

export function verifyBuffer(data, expected = {}, { file } = {}) {
  const wanted = pickExpected(expected);
  const hashes = Object.keys(wanted).length > 0 ? hashBuffer(data, Object.keys(wanted)) : {};
  verifyHashes(hashes, wanted, { file });
  return { ok: true, checked: Object.keys(wanted), hashes };
}

export async function verifyFile(file, expected = {}, options = {}) {
  const wanted = pickExpected(expected);
  const hashes = Object.keys(wanted).length > 0 ? await hashFile(file, Object.keys(wanted)) : {};
  verifyHashes(hashes, wanted, { file, ...options });
  return { ok: true, checked: Object.keys(wanted), hashes };
}
