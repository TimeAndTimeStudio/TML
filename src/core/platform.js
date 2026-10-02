// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { ConfigError } from './errors.js';

export const SUPPORTED_PLATFORM = 'linux';

export function isSupportedPlatform(platform) {
  return platform === SUPPORTED_PLATFORM;
}

export function assertLinuxPlatform(platform = process.platform) {
  if (!isSupportedPlatform(platform)) {
    throw new ConfigError(`TML runs on ${SUPPORTED_PLATFORM} only (detected: ${platform})`, {
      code: 'UNSUPPORTED_PLATFORM',
      details: { platform, supported: SUPPORTED_PLATFORM },
    });
  }
}
