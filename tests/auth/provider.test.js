// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthProvider } from '../../src/auth/provider.js';

const GUID = '11111111-2222-3333-4444-555555555555';

function fakeFactory({ clientId }) {
  return { clientId, isExpired: () => false };
}

test('a provider without a client id refuses sign-in operations', () => {
  const provider = createAuthProvider({ factory: fakeFactory });

  assert.equal(provider.isConfigured(), false);
  assert.equal(provider.source, null);
  assert.throws(() => provider.requireClient(), { code: 'AUTH_CLIENT_NOT_CONFIGURED', status: 503 });
});

test('a client id provided at boot keeps its source', () => {
  const provider = createAuthProvider({ clientId: GUID, source: 'env', factory: fakeFactory });

  assert.equal(provider.isConfigured(), true);
  assert.equal(provider.source, 'env');
  assert.equal(provider.requireClient().clientId, GUID);
});
