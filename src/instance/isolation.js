// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import path from 'node:path';
import { resolveWithin } from '../core/filesystem.js';
import { validateInstanceId } from './validate.js';

export const GAME_DIR_NAME = 'minecraft';
export const META_FILE_NAME = 'instance.json';
export const OPTIONS_FILE_NAME = 'options.txt';
export const FABRIC_VERSION_FILE_NAME = 'fabric-version.json';
export const MODS_DIR_NAME = 'mods';
export const INSTANCE_SUBDIRS = Object.freeze([
  MODS_DIR_NAME,
  'config',
  'saves',
  'resourcepacks',
  'shaderpacks',
]);

export function resolveInstancePaths(instancesDir, id) {
  if (typeof instancesDir !== 'string' || instancesDir === '') {
    throw new TypeError('instancesDir must be a non-empty path');
  }
  validateInstanceId(id);
  const dir = resolveWithin(instancesDir, id);
  const gameDir = path.join(dir, GAME_DIR_NAME);
  return Object.freeze({
    dir,
    gameDir,
    metaFile: path.join(dir, META_FILE_NAME),
    fabricVersionFile: path.join(dir, FABRIC_VERSION_FILE_NAME),
    modsDir: path.join(gameDir, MODS_DIR_NAME),
    optionsFile: path.join(gameDir, OPTIONS_FILE_NAME),
    subdirs: Object.freeze(INSTANCE_SUBDIRS.map((name) => path.join(gameDir, name))),
  });
}

export function assertInsideInstance(instanceDir, target) {
  return resolveWithin(instanceDir, target);
}
