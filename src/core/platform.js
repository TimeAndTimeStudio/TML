// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700

import { ConfigError } from './errors.js';

export const SUPPORTED_PLATFORM = 'win32';

export function isSupportedPlatform(platform) {
  return platform === SUPPORTED_PLATFORM;
}

export function assertSupportedPlatform(platform = process.platform) {
  if (!isSupportedPlatform(platform)) {
    throw new ConfigError(`TML runs on Windows (${SUPPORTED_PLATFORM}) only (detected: ${platform})`, {
      code: 'UNSUPPORTED_PLATFORM',
      details: { platform, supported: SUPPORTED_PLATFORM },
    });
  }
}
