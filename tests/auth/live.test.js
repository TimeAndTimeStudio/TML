// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later
//
// LIVE FLOW — ทดสอบระบบ sign-in ทางเลือก: ลบไฟล์นี้พร้อม src/auth/live.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLiveAuth,
  LIVE_TITLE_ID,
  LIVE_DEVICE_CODE_URL,
  LIVE_TOKEN_URL,
  LIVE_SCOPE,
  LIVE_REFRESH_GRANT,
  LIVE_DEVICE_GRANT,
} from '../../src/auth/live.js';
import { XBOX_AUTHENTICATE_URL, XSTS_AUTHORIZE_URL } from '../../src/auth/xbox.js';
import { MC_LOGIN_URL, MC_PROFILE_URL } from '../../src/auth/minecraft.js';
import { validateUrl } from '../../src/security/urls.js';
import { SourceNotAllowedError } from '../../src/core/errors.js';
import { createAuthProvider } from '../../src/auth/provider.js';

const NOW = 1_700_000_000_000;
const PROFILE_ID = '853c80ef3c3749ef90e8d18951201e12';
const POLL_URL = `${LIVE_TOKEN_URL}?client_id=${encodeURIComponent(LIVE_TITLE_ID)}`;

function createFakeHttp(routes) {
  const calls = [];
  const queue = routes.map((route) => ({ ...route, responses: [...route.responses] }));

  async function dispatch(method, url, body, opts) {
    calls.push({ method, url, body, opts });
    const route = queue.find((entry) => entry.method === method && entry.url === url);
    if (route === undefined) throw new Error(`Unexpected ${method} ${url}`);
    const next = route.responses.shift();
    if (next === undefined) throw new Error(`No more responses queued for ${method} ${url}`);
    if (next.throw) throw next.throw;
    return { status: next.status ?? 200, data: next.data ?? null };
  }

  return {
    calls,
    postJson: (url, body, opts = {}) => dispatch('POST', url, body, opts),
    getJson: (url, opts = {}) => dispatch('GET', url, null, opts),
  };
}

function createLive(routes, overrides = {}) {
  const sleeps = [];
  const http = createFakeHttp(routes);
  const live = createLiveAuth({
    http,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return { live, http, sleeps };
}

function deviceRoute(overrides = {}) {
  return {
    method: 'POST',
    url: LIVE_DEVICE_CODE_URL,
    responses: [
      {
        data: {
          device_code: 'dev-code-secret',
          user_code: 'USER-CODE',
          verification_uri: 'https://microsoft.com/link',
          interval: 5,
          expires_in: 900,
          ...overrides,
        },
      },
    ],
  };
}

function pollRoute(responses) {
  return { method: 'POST', url: POLL_URL, responses };
}

function refreshRoute(responses) {
  return { method: 'POST', url: LIVE_TOKEN_URL, responses };
}

function chainRoutes({ tokenResponses } = {}) {
  return [
    {
      method: 'POST',
      url: XBOX_AUTHENTICATE_URL,
      responses: [
        { data: { Token: 'xbl-live-1', DisplayClaims: { xui: [{ uhs: 'uhs-1', xid: '123456' }] } } },
      ],
    },
    {
      method: 'POST',
      url: XSTS_AUTHORIZE_URL,
      responses: [{ data: { Token: 'xsts-live-1', DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } } }],
    },
    {
      method: 'POST',
      url: MC_LOGIN_URL,
      responses: [{ data: { access_token: 'mc-at-live-1', expires_in: 86400, token_type: 'Bearer' } }],
    },
    {
      method: 'GET',
      url: MC_PROFILE_URL,
      responses: [{ data: { id: PROFILE_ID, name: 'Steve' } }],
    },
    ...(tokenResponses ? [{ method: 'POST', url: POLL_URL, responses: tokenResponses }] : []),
  ];
}

function approvedMsaTokens(overrides = {}) {
  return {
    data: {
      access_token: 'msa-at-live-1',
      refresh_token: 'msa-rt-live-1',
      expires_in: 3600,
      ...overrides,
    },
  };
}

test('the live endpoints are on the microsoft allowlist', () => {
  validateUrl(LIVE_DEVICE_CODE_URL, 'microsoft');
  validateUrl(LIVE_TOKEN_URL, 'microsoft');
});

test('startDeviceLogin requests a device code with the Switch title id', async () => {
  const { live, http } = createLive([deviceRoute()]);

  const start = await live.startDeviceLogin();
  assert.equal(start.deviceCode, 'dev-code-secret');
  assert.equal(start.userCode, 'USER-CODE');
  assert.equal(start.verificationUri, 'https://microsoft.com/link');
  assert.equal(start.interval, 5);
  assert.equal(start.expiresAt, NOW + 900_000);
  assert.equal(start.flow, 'live');
  assert.equal(live.source, 'live');

  const call = http.calls[0];
  assert.equal(call.url, LIVE_DEVICE_CODE_URL);
  const params = new URLSearchParams(call.body);
  assert.equal(params.get('client_id'), LIVE_TITLE_ID);
  assert.equal(params.get('scope'), LIVE_SCOPE);
  assert.equal(params.get('response_type'), 'device_code');
});

test('waitForDeviceToken handles pending, slow_down and approval', async () => {
  const { live, http, sleeps } = createLive([
    pollRoute([
      { status: 400, data: { error: 'authorization_pending' } },
      { status: 400, data: { error: 'slow_down' } },
      approvedMsaTokens(),
    ]),
  ]);

  const attempts = [];
  const tokens = await live.waitForDeviceToken(
    { deviceCode: 'dev-code-secret', interval: 5, expiresAt: NOW + 900_000 },
    { onAttempt: (info) => attempts.push(info) },
  );

  assert.equal(tokens.accessToken, 'msa-at-live-1');
  assert.equal(tokens.refreshToken, 'msa-rt-live-1');
  assert.deepEqual(sleeps, [5_000, 10_000], 'slow_down must add 5s to the interval');
  assert.deepEqual(attempts.map((a) => a.status), ['pending', 'slow_down']);

  const poll = http.calls[0];
  const params = new URLSearchParams(poll.body);
  assert.equal(poll.url, POLL_URL);
  assert.equal(params.get('client_id'), LIVE_TITLE_ID);
  assert.equal(params.get('device_code'), 'dev-code-secret');
  assert.equal(params.get('grant_type'), LIVE_DEVICE_GRANT);
});

test('waitForDeviceToken maps declined and expired device codes', async () => {
  const declined = createLive([
    pollRoute([{ status: 400, data: { error: 'authorization_declined' } }]),
  ]);
  await assert.rejects(
    declined.live.waitForDeviceToken({ deviceCode: 'd', interval: 5, expiresAt: NOW + 900_000 }),
    (err) => err.code === 'AUTH_DECLINED' && err.status === 400,
  );

  const expired = createLive([pollRoute([{ status: 400, data: { error: 'expired_token' } }])]);
  await assert.rejects(
    expired.live.waitForDeviceToken({ deviceCode: 'd', interval: 5, expiresAt: NOW + 900_000 }),
    (err) => err.code === 'AUTH_DEVICE_EXPIRED',
  );

  const stale = createLive([]);
  await assert.rejects(
    stale.live.waitForDeviceToken({ deviceCode: 'd', interval: 5, expiresAt: NOW - 1 }),
    (err) => err.code === 'AUTH_DEVICE_EXPIRED',
  );
});

test('exchangeLiveTokens sends the RpsTicket with the t= prefix and stores flow: live', async () => {
  const { live, http } = createLive(chainRoutes());

  const session = await live.exchangeLiveTokens({
    accessToken: 'msa-at-live-1',
    refreshToken: 'msa-rt-live-1',
  });

  assert.equal(session.username, 'Steve');
  assert.equal(session.uuid, '853c80ef-3c37-49ef-90e8-d18951201e12', 'profile id is formatted as a UUID');
  assert.equal(session.accessToken, 'mc-at-live-1');
  assert.equal(session.refreshToken, 'msa-rt-live-1');
  assert.equal(session.flow, 'live', 'the session must remember it came from the live flow');

  const xbox = http.calls.find((c) => c.url === XBOX_AUTHENTICATE_URL);
  assert.equal(
    xbox.body.Properties.RpsTicket,
    `t=msa-at-live-1`,
    'live flow uses the t= prefix (the AAD flow uses d=)',
  );
});

test('live session xuid falls back to the Minecraft access token claim', async () => {
  const routes = chainRoutes();
  const jwt = `.${Buffer.from(JSON.stringify({ xuid: '1122334455667788' })).toString('base64url')}.sig`;
  routes.find((r) => r.url === MC_LOGIN_URL).responses = [
    { data: { access_token: jwt, expires_in: 86400, token_type: 'Bearer' } },
  ];
  routes.find((r) => r.url === XSTS_AUTHORIZE_URL).responses = [
    { data: { Token: 'xsts-live-1', DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } } },
  ];
  routes.find((r) => r.url === XBOX_AUTHENTICATE_URL).responses = [
    { data: { Token: 'xbl-live-1', DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } } },
  ];

  const { live } = createLive(routes);
  const session = await live.exchangeLiveTokens({ accessToken: 'msa-at-live-1', refreshToken: 'rt' });
  assert.equal(session.xuid, '1122334455667788');
  assert.equal(session.flow, 'live');
});

test('an XSTS rejection surfaces the human-readable XErr message', async () => {
  const routes = chainRoutes();
  const xsts = routes.find((r) => r.url === XSTS_AUTHORIZE_URL);
  xsts.responses = [{ status: 403, data: { XErr: 2148916238 } }];

  const { live } = createLive(routes);
  await assert.rejects(
    live.exchangeLiveTokens({ accessToken: 'msa-at-live-1', refreshToken: 'rt' }),
    (err) =>
      err.code === 'AUTH_XSTS_FAILED' &&
      err.status === 403 &&
      /child account/.test(err.message) &&
      err.details.xErr === 2148916238,
  );
});

test('refreshSession requests new tokens with the refresh grant', async () => {
  const routes = chainRoutes();
  routes.push(
    refreshRoute([
      approvedMsaTokens({ access_token: 'msa-at-live-2', refresh_token: 'msa-rt-live-2' }),
    ]),
  );
  const { live, http } = createLive(routes);

  const session = await live.refreshSession({ refreshToken: 'msa-rt-live-1' });
  assert.equal(session.accessToken, 'mc-at-live-1');
  assert.equal(session.refreshToken, 'msa-rt-live-2', 'a rotated refresh token must be kept');
  assert.equal(session.flow, 'live');

  const refresh = http.calls.find((c) => c.url === LIVE_TOKEN_URL);
  const params = new URLSearchParams(refresh.body);
  // login.live.com ตอบ 400 unsupported_grant_type กับ URN — ต้องเป็นค่า plain เท่านั้น (pin ไว้กัน regression)
  assert.equal(LIVE_REFRESH_GRANT, 'refresh_token');
  assert.equal(params.get('grant_type'), LIVE_REFRESH_GRANT);
  assert.equal(params.get('refresh_token'), 'msa-rt-live-1');
  assert.equal(params.get('client_id'), LIVE_TITLE_ID);
  assert.equal(params.get('scope'), LIVE_SCOPE);
});

test('refreshSession rejects a missing or revoked refresh token', async () => {
  const missing = createLive([]);
  await assert.rejects(
    missing.live.refreshSession({ refreshToken: null }),
    (err) => err.code === 'AUTH_REFRESH_FAILED' && err.status === 401,
  );

  const revoked = createLive([refreshRoute([{ status: 400, data: { error: 'invalid_grant' } }])]);
  await assert.rejects(
    revoked.live.refreshSession({ refreshToken: 'msa-rt-live-1' }),
    (err) =>
      err.code === 'AUTH_REFRESH_FAILED' && err.status === 401 && err.details.error === 'invalid_grant',
  );
});

test('isExpired uses a 60s skew', () => {
  const { live } = createLive([]);
  assert.equal(live.isExpired(null), true);
  assert.equal(live.isExpired({ expiresAt: NOW + 120_000 }), false);
  assert.equal(live.isExpired({ expiresAt: NOW + 30_000 }), true);
});

test('the provider exposes the live client alongside the AAD one', () => {
  const provider = createAuthProvider({ clientId: null, source: null });
  assert.equal(provider.isConfigured(), false);
  assert.ok(provider.live, 'the live client must be available even without a client id');
  assert.equal(provider.live.source, 'live');
  assert.throws(
    () => provider.requireClient(),
    (err) => err.code === 'AUTH_CLIENT_NOT_CONFIGURED',
  );
});

test('security: the live flow never requests a URL outside the microsoft source', async () => {
  const routes = chainRoutes({ tokenResponses: [approvedMsaTokens()] });
  routes.unshift(deviceRoute());
  const { live, http } = createLive(routes);

  await live.startDeviceLogin();
  for (const call of http.calls) {
    assert.doesNotThrow(() => validateUrl(call.url, 'microsoft'), `not allowed: ${call.url}`);
  }
  assert.throws(() => validateUrl('https://evil.example.com/token', 'microsoft'), SourceNotAllowedError);
});
