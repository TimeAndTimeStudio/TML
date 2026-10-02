// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { ValidationError } from '../core/errors.js';
import { safeVersionId } from '../minecraft/versions.js';

export const SUPPORTED_LOADER = 'fabric';
export const SUPPORTED_LOADERS = Object.freeze(['fabric']);
export const DEFAULT_JAVA = 'minecraft-bundled';
export const JAVA_CHOICES = Object.freeze(['minecraft-bundled']);
export const DEFAULT_MEMORY = Object.freeze({ min: '512M', max: '4096M' });
export const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MEMORY_RE = /^[1-9][0-9]{0,8}[KMGT]$/i;
export const NAME_MAX = 80;
export const MAX_EXTRA_ARGS = 64;
export const MAX_ARG_LENGTH = 512;

const MEMORY_UNITS = Object.freeze({ K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 });

function invalid(code, message, details) {
  return new ValidationError(message, { code, details });
}

function validatePlaySeconds(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid('INVALID_PLAY_SECONDS', 'playSeconds must be a non-negative integer', {
      playSeconds: typeof value === 'number' ? value : typeof value,
    });
  }
  return value;
}

function validateLastPlayedAt(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw invalid('INVALID_LAST_PLAYED_AT', 'lastPlayedAt must be a date string or null', {
      lastPlayedAt: typeof value === 'string' ? 'invalid' : typeof value,
    });
  }
  return value;
}

export function validateInstanceId(id) {
  if (typeof id !== 'string' || !INSTANCE_ID_RE.test(id)) {
    throw invalid('INVALID_INSTANCE_ID', 'Instance id must be a lowercase path-safe segment', {
      id: typeof id === 'string' ? id : typeof id,
    });
  }
  return id;
}

export function hasControlChars(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function validateInstanceName(name) {
  if (typeof name !== 'string') {
    throw invalid('INVALID_INSTANCE_NAME', 'Instance name must be a string', {
      name: typeof name,
    });
  }
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > NAME_MAX || hasControlChars(trimmed)) {
    throw invalid(
      'INVALID_INSTANCE_NAME',
      `Instance name must be 1-${NAME_MAX} characters without control characters`,
      { name: trimmed.slice(0, 40) }
    );
  }
  return trimmed;
}

export function parseMemory(value) {
  if (typeof value !== 'string' || !MEMORY_RE.test(value)) {
    throw invalid('INVALID_MEMORY', 'Memory must look like "512M" or "4G"', {
      memory: typeof value === 'string' ? value : typeof value,
    });
  }
  const unit = value.slice(-1).toUpperCase();
  return Number.parseInt(value.slice(0, -1), 10) * MEMORY_UNITS[unit];
}

function validateMemoryValue(key, value) {
  if (typeof value !== 'string' || !MEMORY_RE.test(value)) {
    throw invalid('INVALID_MEMORY', `"memory.${key}" must look like "512M" or "4G"`, {
      key,
      value: typeof value === 'string' ? value : typeof value,
    });
  }
  return value.toUpperCase();
}

function validateMemoryPair(memory) {
  if (memory === null || typeof memory !== 'object' || Array.isArray(memory)) {
    throw invalid('INVALID_MEMORY', '"memory" must be an object with min and max', {
      memory: typeof memory,
    });
  }
  const min = validateMemoryValue('min', memory.min);
  const max = validateMemoryValue('max', memory.max);
  if (parseMemory(min) > parseMemory(max)) {
    throw invalid('INVALID_MEMORY', '"memory.min" must not exceed "memory.max"', { min, max });
  }
  return Object.freeze({ min, max });
}

function validateJava(java) {
  if (typeof java !== 'string' || !JAVA_CHOICES.includes(java)) {
    throw invalid('INVALID_JAVA', `Unsupported java selection: ${String(java)}`, {
      java: typeof java === 'string' ? java : typeof java,
    });
  }
  return java;
}

function validateExtraArgs(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw invalid('INVALID_EXTRA_ARGS', `"${field}" must be an array of strings`, {
      field,
      received: typeof value,
    });
  }
  if (value.length > MAX_EXTRA_ARGS) {
    throw invalid('INVALID_EXTRA_ARGS', `"${field}" accepts at most ${MAX_EXTRA_ARGS} entries`, {
      field,
      count: value.length,
    });
  }
  return value.map((arg, index) => {
    if (
      typeof arg !== 'string' ||
      arg.trim() === '' ||
      arg.length > MAX_ARG_LENGTH ||
      hasControlChars(arg)
    ) {
      throw invalid(
        'INVALID_EXTRA_ARGS',
        `"${field}[${index}]" must be a non-empty string of at most ${MAX_ARG_LENGTH} characters`,
        { field, index }
      );
    }
    return arg;
  });
}

export function validateInstanceMeta(meta) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw invalid('INVALID_INSTANCE_META', 'Instance metadata must be an object', {
      received: typeof meta,
    });
  }

  const id = validateInstanceId(meta.id);
  const name = validateInstanceName(meta.name);
  const minecraftVersion = safeVersionId(meta.minecraftVersion);

  if (meta.loader !== SUPPORTED_LOADER) {
    throw invalid(
      'INVALID_LOADER',
      `Unsupported loader: ${String(meta.loader)} - this launcher supports Fabric only`,
      { loader: typeof meta.loader === 'string' ? meta.loader : typeof meta.loader }
    );
  }
  const fabricLoaderVersion = safeVersionId(meta.fabricLoaderVersion);

  return Object.freeze({
    id,
    name,
    minecraftVersion,
    loader: SUPPORTED_LOADER,
    fabricLoaderVersion,
    java: validateJava(meta.java ?? DEFAULT_JAVA),
    memory: validateMemoryPair(meta.memory ?? DEFAULT_MEMORY),
    extraJvmArgs: Object.freeze(validateExtraArgs(meta.extraJvmArgs, 'extraJvmArgs')),
    extraGameArgs: Object.freeze(validateExtraArgs(meta.extraGameArgs, 'extraGameArgs')),
    playSeconds: validatePlaySeconds(meta.playSeconds),
    lastPlayedAt: validateLastPlayedAt(meta.lastPlayedAt),
  });
}
