// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMicrosoftAuth,
  MSA_SCOPE,
  DEVICE_CODE_URL,
  TOKEN_URL,
} from '../../src/auth/microsoft.js';
import {
  XBOX_AUTHENTICATE_URL,
  XSTS_AUTHORIZE_URL,
} from '../../src/auth/xbox.js';
import { MC_LOGIN_URL, MC_PROFILE_URL, readMinecraftXuid } from '../../src/auth/minecraft.js';
import { validateUrl } from '../../src/security/urls.js';
import { SourceNotAllowedError, UpstreamError } from '../../src/core/errors.js';

const NOW = 1_700_000_000_000;
const PROFILE_ID = '853c80ef3c3749ef90e8d18951201e12';
const TEST_CLIENT_ID = '11111111-2222-3333-4444-555555555555';

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

function deviceRoute(overrides = {}) {
  return {
    method: 'POST',
    url: DEVICE_CODE_URL,
    responses: [
      {
        data: {
          device_code: 'dev-code-secret',
          user_code: 'USER-CODE',
          verification_uri: 'https://microsoft.com/link',
          interval: 5,
          expires_in: 900,
          message: 'Open the page',
          ...overrides,
        },
      },
    ],
  };
}

function tokenRoute(responses) {
  return { method: 'POST', url: TOKEN_URL, responses };
}

function approvedMsaTokens(overrides = {}) {
  return {
    data: {
      access_token: 'msa-at-secret-1',
      refresh_token: 'msa-rt-secret-1',
      expires_in: 3600,
      ...overrides,
    },
  };
}

function chainRoutes({ profile, tokenResponses, repeat = 1 } = {}) {
  const xboxRoute = {
    method: 'POST',
    url: XBOX_AUTHENTICATE_URL,
    responses: Array.from({ length: repeat }, () => ({
      data: { Token: 'xbl-1', DisplayClaims: { xui: [{ uhs: 'uhs-1', xid: '123456' }] } },
    })),
  };
  const xstsRoute = {
    method: 'POST',
    url: XSTS_AUTHORIZE_URL,
    responses: Array.from({ length: repeat }, () => ({
      data: { Token: 'xsts-1', DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } },
    })),
  };
  const mcLoginRoute = {
    method: 'POST',
    url: MC_LOGIN_URL,
    responses: Array.from({ length: repeat }, () => ({
      data: { access_token: 'mc-at-secret-1', expires_in: 86400, token_type: 'Bearer' },
    })),
  };
  const profileRoute = {
    method: 'GET',
    url: MC_PROFILE_URL,
    responses: Array.from({ length: repeat }, () => profile ?? { data: { id: PROFILE_ID, name: 'Steve' } }),
  };

  return [
    deviceRoute(),
    tokenRoute(
      tokenResponses ?? [
        { status: 400, data: { error: 'authorization_pending' } },
        { status: 400, data: { error: 'slow_down' } },
        approvedMsaTokens(),
      ]
    ),
    xboxRoute,
    xstsRoute,
    mcLoginRoute,
    profileRoute,
  ];
}

function createAuth(routes, overrides = {}) {
  const sleeps = [];
  const http = createFakeHttp(routes);
  const auth = createMicrosoftAuth({
    http,
    clientId: TEST_CLIENT_ID,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return { auth, http, sleeps };
}

test('startDeviceLogin posts a form-encoded device code request', async () => {
  const { auth, http } = createAuth([deviceRoute()]);

  const start = await auth.startDeviceLogin();

  assert.equal(start.deviceCode, 'dev-code-secret');
  assert.equal(start.userCode, 'USER-CODE');
  assert.equal(start.verificationUri, 'https://microsoft.com/link');
  assert.equal(start.verificationUriComplete, null);
  assert.equal(start.interval, 5);
  assert.equal(start.expiresAt, NOW + 900_000);
  assert.equal(start.message, 'Open the page');

  assert.equal(http.calls.length, 1);
  const call = http.calls[0];
  assert.equal(call.url, DEVICE_CODE_URL);
  assert.equal(call.opts.source, 'microsoft');
  assert.match(call.opts.headers['content-type'], /application\/x-www-form-urlencoded/);

  const params = new URLSearchParams(call.body);
  assert.equal(params.get('client_id'), TEST_CLIENT_ID);
  assert.equal(params.get('scope'), MSA_SCOPE);
});

test('completeDeviceLogin runs Microsoft → Xbox → XSTS → Minecraft → Profile', async () => {
  const stages = [];
  const attempts = [];
  const { auth, sleeps } = createAuth(chainRoutes());

  const start = await auth.startDeviceLogin();
  const session = await auth.completeDeviceLogin(start, {
    onStage: (stage) => stages.push(stage),
    onAttempt: (attempt) => attempts.push(attempt.status),
  });

  assert.deepEqual(stages, ['xbox', 'xsts', 'minecraft', 'profile']);
  assert.deepEqual(attempts, ['pending', 'slow_down']);
  assert.deepEqual(sleeps, [5_000, 10_000]);

  assert.equal(session.type, 'msa');
  assert.equal(session.userType, 'msa');
  assert.equal(session.username, 'Steve');
  assert.equal(session.uuid, '853c80ef-3c37-49ef-90e8-d18951201e12');
  assert.equal(session.accessToken, 'mc-at-secret-1');
  assert.equal(session.refreshToken, 'msa-rt-secret-1');
  assert.equal(session.expiresAt, NOW + 86_400_000);
  assert.equal(session.xuid, '123456');
  assert.ok(Object.isFrozen(session));
});

test('readMinecraftXuid extracts the xuid claim from a Minecraft access token', () => {
  const jwt = `.${Buffer.from(JSON.stringify({ xuid: '2535449510431409' })).toString('base64url')}.sig`;
  assert.equal(readMinecraftXuid(jwt), '2535449510431409');
  assert.equal(readMinecraftXuid(`.${Buffer.from(JSON.stringify({ sub: 'no-xuid' })).toString('base64url')}.sig`), null);
  assert.equal(readMinecraftXuid('not-a-jwt'), null);
  assert.equal(readMinecraftXuid('a.b'), null);
  assert.equal(readMinecraftXuid(''), null);
  assert.equal(readMinecraftXuid(null), null);
  assert.equal(readMinecraftXuid(`.%%%not-base64%%%.sig`), null, 'a corrupt payload must not throw');
});

test('session xuid falls back to the Minecraft access token when Xbox claims omit xid', async () => {
  const routes = chainRoutes();
  const jwt = `.${Buffer.from(JSON.stringify({ xuid: '9988776655443322' })).toString('base64url')}.sig`;
  routes.find((r) => r.url === XBOX_AUTHENTICATE_URL).responses = [
    { data: { Token: 'xbl-1', DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } } },
  ];
  routes.find((r) => r.url === XSTS_AUTHORIZE_URL).responses = [
    { data: { Token: 'xsts-1', DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } } },
  ];
  routes.find((r) => r.url === MC_LOGIN_URL).responses = [
    { data: { access_token: jwt, expires_in: 86400, token_type: 'Bearer' } },
  ];

  const { auth } = createAuth(routes);
  const start = await auth.startDeviceLogin();
  const session = await auth.completeDeviceLogin(start);

  assert.equal(
    session.xuid,
    '9988776655443322',
    'DisplayClaims ตอบกลับมาเฉพาะ uhs → อ่าน xuid จาก claim ของ MC access token แทน',
  );
});

test('declined, expired and stalled device codes map to auth errors', async () => {
  const declined = createAuth([
    deviceRoute(),
    tokenRoute([{ status: 400, data: { error: 'authorization_declined' } }]),
  ]);
  await assert.rejects(declined.auth.startDeviceLogin().then((s) => declined.auth.waitForDeviceToken(s)), {
    code: 'AUTH_DECLINED',
    status: 400,
  });

  const expired = createAuth([
    deviceRoute(),
    tokenRoute([{ status: 400, data: { error: 'expired_token' } }]),
  ]);
  await assert.rejects(expired.auth.startDeviceLogin().then((s) => expired.auth.waitForDeviceToken(s)), {
    code: 'AUTH_DEVICE_EXPIRED',
    status: 400,
  });

  const unknown = createAuth([
    deviceRoute(),
    tokenRoute([{ status: 400, data: { error: 'bad_verification_code' } }]),
  ]);
  await assert.rejects(unknown.auth.startDeviceLogin().then((s) => unknown.auth.waitForDeviceToken(s)), {
    code: 'AUTH_FAILED',
    status: 502,
  });

  const { auth } = createAuth([]);
  await assert.rejects(
    auth.waitForDeviceToken({ deviceCode: 'x', interval: 5, expiresAt: NOW - 1 }),
    { code: 'AUTH_DEVICE_EXPIRED', status: 400 }
  );
});

test('XSTS refusal surfaces AUTH_XSTS_FAILED with the XErr code', async () => {
  const routes = chainRoutes();
  routes[3].responses = [{ status: 401, data: { XErr: 2999999999 } }];
  const { auth } = createAuth(routes);

  const start = await auth.startDeviceLogin();
  await assert.rejects(auth.completeDeviceLogin(start), (err) => {
    assert.equal(err.code, 'AUTH_XSTS_FAILED');
    assert.equal(err.status, 403);
    assert.equal(err.details.stage, 'xsts');
    assert.equal(err.details.xErr, 2999999999);
    return true;
  });

  const noXbox = chainRoutes();
  noXbox[3].responses = [{ status: 401, data: { XErr: 2148916233 } }];
  const { auth: authNoXbox } = createAuth(noXbox);
  const startB = await authNoXbox.startDeviceLogin();
  await assert.rejects(authNoXbox.completeDeviceLogin(startB), (err) => {
    assert.equal(err.code, 'AUTH_XSTS_FAILED');
    assert.match(err.message, /no Xbox Live profile/);
    return true;
  });
});

test('Minecraft login refusal surfaces the upstream reason', async () => {
  const refused = chainRoutes();
  refused[4].responses = [{ status: 403, data: { error: 'invalid_grant', error_description: 'Invalid app registration' } }];
  const { auth } = createAuth(refused);

  const start = await auth.startDeviceLogin();
  await assert.rejects(auth.completeDeviceLogin(start), (err) => {
    assert.equal(err.code, 'AUTH_MC_LOGIN_FAILED');
    assert.equal(err.status, 401);
    assert.equal(err.details.stage, 'minecraft');
    assert.equal(err.details.status, 403);
    assert.equal(err.details.upstream, 'Invalid app registration');
    assert.match(err.message, /Invalid app registration$/);
    return true;
  });

  const named = chainRoutes();
  named[4].responses = [{ status: 401, data: { errorMessage: 'Identity token expired' } }];
  const { auth: authNamed } = createAuth(named);
  const startNamed = await authNamed.startDeviceLogin();
  await assert.rejects(authNamed.completeDeviceLogin(startNamed), (err) => {
    assert.equal(err.details.upstream, 'Identity token expired');
    assert.match(err.message, /Identity token expired$/);
    return true;
  });

  const bare = chainRoutes();
  bare[4].responses = [{ status: 401, data: null }];
  const { auth: authBare } = createAuth(bare);
  const startB = await authBare.startDeviceLogin();
  await assert.rejects(authBare.completeDeviceLogin(startB), (err) => {
    assert.equal(err.code, 'AUTH_MC_LOGIN_FAILED');
    assert.equal(err.message, 'Minecraft Services rejected the Xbox identity token (upstream HTTP 401)');
    assert.equal('upstream' in err.details, false, 'no upstream detail when the body carries no reason');
    return true;
  });
});

test('MC login refusal logs the upstream body and the XSTS claims', async () => {
  const claims = { aud: 'rp://api.minecraftservices.com/', nbf: 1_699_999_900, exp: 1_700_003_600, iat: 1_699_999_900 };
  const xstsJwt = ['eyJhbGciOiJQUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

  const records = [];
  const spyLogger = {
    debug: (message, meta) => records.push({ level: 'debug', message, meta }),
    info: (message, meta) => records.push({ level: 'info', message, meta }),
    warn: (message, meta) => records.push({ level: 'warn', message, meta }),
    error: (message, meta) => records.push({ level: 'error', message, meta }),
  };

  const routes = chainRoutes();
  routes[3].responses = [{ data: { Token: xstsJwt, DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } } }];
  routes[4].responses = [{ status: 401, data: { error: { code: 'invalid_identity_token' } } }];
  const { auth } = createAuth(routes, { logger: spyLogger });

  const start = await auth.startDeviceLogin();
  await assert.rejects(auth.completeDeviceLogin(start), (err) => {
    assert.equal(err.code, 'AUTH_MC_LOGIN_FAILED');
    assert.equal(err.message, 'Minecraft Services rejected the Xbox identity token (upstream HTTP 401)');
    return true;
  });

  const refusal = records.find((rec) => rec.message === 'minecraft login refused');
  assert.ok(refusal, 'the refusal must be logged for diagnosis');
  assert.equal(refusal.level, 'warn');
  assert.equal(refusal.meta.status, 401);
  assert.equal(refusal.meta.upstream, null, 'a nested error object has no readable reason');
  assert.match(refusal.meta.body, /invalid_identity_token/);
  assert.deepEqual(refusal.meta.xsts, { aud: claims.aud, nbf: claims.nbf, exp: claims.exp, iat: claims.iat });
  assert.equal(typeof refusal.meta.now, 'number');

  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes(xstsJwt), 'the logger must never see the raw token');
  assert.ok(!serialized.includes(xstsJwt.split('.')[1]), 'the logger must never see the token payload');
});

test('profile failures distinguish unowned accounts from missing profiles', async () => {
  const notOwned = chainRoutes({ profile: { status: 403 } });
  const { auth: authNotOwned } = createAuth(notOwned);
  const startA = await authNotOwned.startDeviceLogin();
  await assert.rejects(authNotOwned.completeDeviceLogin(startA), {
    code: 'AUTH_GAME_NOT_OWNED',
    status: 403,
  });

  const noProfile = chainRoutes({ profile: { status: 404 } });
  const { auth: authNoProfile } = createAuth(noProfile);
  const startB = await authNoProfile.startDeviceLogin();
  await assert.rejects(authNoProfile.completeDeviceLogin(startB), {
    code: 'AUTH_NO_PROFILE',
    status: 404,
  });
});

test('refreshSession re-runs the chain and rotates tokens', async () => {
  const routes = chainRoutes({
    tokenResponses: [{ data: { access_token: 'msa-at-2', refresh_token: 'msa-rt-2', expires_in: 3600 } }],
  });
  const { auth, http } = createAuth(routes);

  const session = await auth.refreshSession({ refreshToken: 'msa-rt-1' });

  assert.equal(session.accessToken, 'mc-at-secret-1');
  assert.equal(session.refreshToken, 'msa-rt-2');
  assert.equal(session.username, 'Steve');

  const refreshCall = http.calls.find((call) => call.url === TOKEN_URL);
  const params = new URLSearchParams(refreshCall.body);
  assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:refresh_token');
  assert.equal(params.get('refresh_token'), 'msa-rt-1');
  assert.equal(refreshCall.opts.source, 'microsoft');
});

test('refreshSession keeps the previous refresh token when the endpoint omits a new one', async () => {
  const routes = chainRoutes({
    tokenResponses: [{ data: { access_token: 'msa-at-2', expires_in: 3600 } }],
  });
  const { auth } = createAuth(routes);

  const session = await auth.refreshSession({ refreshToken: 'msa-rt-1' });
  assert.equal(session.refreshToken, 'msa-rt-1');
});

test('refresh failures require a stored refresh token and reject invalid grants', async () => {
  const { auth } = createAuth([]);
  await assert.rejects(auth.refreshSession({}), {
    code: 'AUTH_REFRESH_FAILED',
    status: 401,
    details: { stage: 'refresh', reason: 'missing-refresh-token' },
  });

  const invalid = createAuth([
    tokenRoute([{ status: 400, data: { error: 'invalid_grant' } }]),
  ]);
  await assert.rejects(invalid.auth.refreshSession({ refreshToken: 'stale' }), (err) => {
    assert.equal(err.code, 'AUTH_REFRESH_FAILED');
    assert.equal(err.status, 401);
    assert.equal(err.details.error, 'invalid_grant');
    return true;
  });
});

test('isExpired honors the expiry skew window', () => {
  const { auth } = createAuth([]);
  assert.equal(auth.isExpired({ expiresAt: NOW + 3_600_000 }), false);
  assert.equal(auth.isExpired({ expiresAt: NOW + 30_000 }), true);
  assert.equal(auth.isExpired({ expiresAt: NOW + 600_000 }), false);
  assert.equal(auth.isExpired({}), true);
  assert.equal(auth.isExpired({ expiresAt: NOW + 30_000 }, { skewMs: 10_000 }), false);
});

test('authentication can be cancelled at every stage', async () => {
  const { auth } = createAuth(chainRoutes());
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    auth.completeDeviceLogin(
      { deviceCode: 'x', interval: 5, expiresAt: NOW + 60_000 },
      { signal: controller.signal }
    ),
    (err) => {
      assert.equal(err.code, 'CANCELLED');
      assert.equal(err.details.stage, 'device');
      return true;
    }
  );

  const { auth: auth2 } = createAuth([]);
  await assert.rejects(
    auth2.exchangeMsaTokens({ accessToken: 'msa-at' }, { signal: controller.signal }),
    (err) => {
      assert.equal(err.code, 'CANCELLED');
      assert.equal(err.details.stage, 'xbox');
      return true;
    }
  );
});

test('every endpoint passes the official source allowlist', () => {
  for (const url of [DEVICE_CODE_URL, TOKEN_URL, XBOX_AUTHENTICATE_URL, XSTS_AUTHORIZE_URL]) {
    assert.equal(validateUrl(url, { source: 'microsoft' }).href, url);
  }
  for (const url of [MC_LOGIN_URL, MC_PROFILE_URL]) {
    assert.equal(validateUrl(url, { source: 'microsoft' }).href, url);
  }
  assert.throws(() => validateUrl('https://evil.example.com/token', { source: 'microsoft' }), SourceNotAllowedError);
});

test('xbox and minecraft requests carry the exact payloads', async () => {
  const { auth, http } = createAuth(chainRoutes());
  const start = await auth.startDeviceLogin();
  await auth.completeDeviceLogin(start);

  const xbox = http.calls.find((call) => call.url === XBOX_AUTHENTICATE_URL);
  const xboxBody = typeof xbox.body === 'string' ? JSON.parse(xbox.body) : xbox.body;
  assert.equal(xbox.opts.source, 'microsoft');
  assert.equal(xboxBody.Properties.AuthMethod, 'RPS');
  assert.equal(xboxBody.Properties.SiteName, 'user.auth.xboxlive.com');
  assert.equal(xboxBody.Properties.RpsTicket, 'd=msa-at-secret-1');
  assert.equal(xboxBody.RelyingParty, 'http://auth.xboxlive.com');
  assert.equal(xboxBody.TokenType, 'JWT');

  const xsts = http.calls.find((call) => call.url === XSTS_AUTHORIZE_URL);
  const xstsBody = typeof xsts.body === 'string' ? JSON.parse(xsts.body) : xsts.body;
  assert.equal(xsts.opts.source, 'microsoft');
  assert.equal(xstsBody.Properties.SandboxId, 'RETAIL');
  assert.deepEqual(xstsBody.Properties.UserTokens, ['xbl-1']);
  assert.equal(xstsBody.RelyingParty, 'rp://api.minecraftservices.com/');

  const mcLogin = http.calls.find((call) => call.url === MC_LOGIN_URL);
  const mcBody = typeof mcLogin.body === 'string' ? JSON.parse(mcLogin.body) : mcLogin.body;
  assert.equal(mcLogin.opts.source, 'microsoft');
  assert.deepEqual(mcBody, { identityToken: 'XBL3.0 x=uhs-1;xsts-1' });

  const profile = http.calls.find((call) => call.url === MC_PROFILE_URL);
  assert.equal(profile.opts.source, 'microsoft');
  assert.equal(profile.opts.headers.authorization, 'Bearer mc-at-secret-1');
});

test('logger never receives tokens, codes or passwords', async () => {
  const records = [];
  const spyLogger = {
    debug: (message, meta) => records.push({ message, meta }),
    info: (message, meta) => records.push({ message, meta }),
    warn: (message, meta) => records.push({ message, meta }),
    error: (message, meta) => records.push({ message, meta }),
  };

  const { auth } = createAuth(
    chainRoutes({
      repeat: 2,
      tokenResponses: [
        { status: 400, data: { error: 'authorization_pending' } },
        { status: 400, data: { error: 'slow_down' } },
        approvedMsaTokens(),
        approvedMsaTokens({ access_token: 'msa-at-secret-2' }),
      ],
    }),
    { logger: spyLogger }
  );
  const start = await auth.startDeviceLogin();
  const session = await auth.completeDeviceLogin(start);
  await auth.refreshSession(session);

  assert.ok(records.length > 0);
  const serialized = JSON.stringify(records);
  for (const secret of [
    'msa-at-secret-1',
    'msa-at-secret-2',
    'msa-rt-secret-1',
    'mc-at-secret-1',
    'xbl-1',
    'xsts-1',
    'dev-code-secret',
    'USER-CODE',
  ]) {
    assert.ok(!serialized.includes(secret), `logger leaked: ${secret}`);
  }
});

test('validation rejects bad options and inputs', async () => {
  assert.throws(() => createMicrosoftAuth(), { code: 'INVALID_AUTH_CONFIG' });
  assert.throws(() => createMicrosoftAuth({ clientId: '' }), { code: 'INVALID_AUTH_CONFIG' });
  assert.throws(() => createMicrosoftAuth({ scope: '' }), { code: 'INVALID_AUTH_CONFIG' });

  const { auth } = createAuth([]);
  await assert.rejects(auth.waitForDeviceToken(null), { code: 'INVALID_DEVICE_LOGIN' });
  await assert.rejects(auth.exchangeMsaTokens({}), { code: 'INVALID_MSA_TOKENS' });
});

test('device start failures surface as AUTH_DEVICE_START_FAILED', async () => {
  const networkDown = createAuth([
    { method: 'POST', url: DEVICE_CODE_URL, responses: [{ throw: new Error('ECONNRESET') }] },
  ]);
  await assert.rejects(networkDown.auth.startDeviceLogin(), (err) => {
    assert.equal(err.code, 'AUTH_DEVICE_START_FAILED');
    assert.equal(err.status, 502);
    assert.equal(err.message, 'Failed to start Microsoft device login');
    return true;
  });

  const missingFields = createAuth([
    { method: 'POST', url: DEVICE_CODE_URL, responses: [{ data: { expires_in: 900 } }] },
  ]);
  await assert.rejects(missingFields.auth.startDeviceLogin(), {
    code: 'AUTH_DEVICE_START_FAILED',
    status: 502,
  });
});

test('device start failures include the upstream AADSTS description', async () => {
  const description =
    'AADSTS7000218: The request body must contain client_secret... Consider enabling "Allow public client flows".';
  const { auth } = createAuth([
    {
      method: 'POST',
      url: DEVICE_CODE_URL,
      responses: [
        {
          throw: new UpstreamError('Upstream responded with HTTP 400', {
            upstreamStatus: 400,
            details: { status: 400, host: 'login.microsoftonline.com', upstream: description },
          }),
        },
      ],
    },
  ]);

  await assert.rejects(auth.startDeviceLogin(), (err) => {
    assert.equal(err.code, 'AUTH_DEVICE_START_FAILED');
    assert.equal(err.status, 502);
    assert.equal(err.message, `Failed to start Microsoft device login — ${description}`);
    assert.equal(err.details.status, 400);
    assert.equal(err.details.upstream, description);
    return true;
  });
});

test('live: requests a real device code from Microsoft', {
  skip: !process.env.TML_LIVE || !process.env.TML_MSA_CLIENT_ID,
}, async () => {
  const auth = createMicrosoftAuth({ clientId: process.env.TML_MSA_CLIENT_ID });
  const start = await auth.startDeviceLogin();

  assert.equal(typeof start.deviceCode, 'string');
  assert.equal(typeof start.userCode, 'string');
  assert.ok(start.verificationUri === null || start.verificationUri.startsWith('https://'));
  assert.ok(start.interval >= 1);
  assert.ok(start.expiresAt > Date.now());
});
