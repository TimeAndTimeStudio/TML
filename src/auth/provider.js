// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { createMicrosoftAuth } from './microsoft.js';
import { AuthError } from '../core/errors.js';

export function createAuthProvider({
  clientId = null,
  source = null,
  logger = null,
  factory = createMicrosoftAuth,
} = {}) {
  let client = clientId ? factory({ clientId, logger }) : null;
  let currentSource = clientId ? source : null;

  function isConfigured() {
    return client !== null;
  }

  function requireClient() {
    if (!client) {
      throw new AuthError(
        'Microsoft sign-in has no client id — set TML_MSA_CLIENT_ID or clientId in config.json',
        { code: 'AUTH_CLIENT_NOT_CONFIGURED', status: 503, details: { stage: 'config' } },
      );
    }
    return client;
  }

  return {
    isConfigured,
    requireClient,
    get source() {
      return currentSource;
    },
  };
}
