// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import {
  AuthError,
  CancelledError,
  UpstreamError,
  ValidationError,
} from '../core/errors.js';
import { httpClient } from '../net/http.js';
import { createXboxAuth } from './xbox.js';
import { createMinecraftAuth, readMinecraftXuid } from './minecraft.js';

export const MSA_SCOPE = 'XboxLive.signin offline_access';
export const DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
export const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
export const REFRESH_GRANT = 'urn:ietf:params:oauth:grant-type:refresh_token';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const DEFAULT_EXPIRES_IN = 3600;
export const DEFAULT_POLL_INTERVAL = 5;
export const SLOW_DOWN_INCREMENT_S = 5;
export const EXPIRY_SKEW_MS = 60_000;

const FORM_HEADERS = Object.freeze({ 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' });

function formBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  return params.toString();
}

function defaultSleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const cancel = (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(err);
    };
    if (signal?.aborted) {
      cancel(new CancelledError('Authentication cancelled', { details: { stage: 'device' } }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal?.addEventListener(
      'abort',
      () => cancel(new CancelledError('Authentication cancelled', { details: { stage: 'device' } })),
      { once: true }
    );
  });
}

function abortError(stage) {
  return new CancelledError('Authentication cancelled', { details: { stage } });
}

export function createMicrosoftAuth(options = {}) {
  const http = options.http ?? httpClient;
  const logger = options.logger ?? null;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const clientId = typeof options.clientId === 'string' ? options.clientId.trim() : options.clientId;
  const scope = options.scope ?? MSA_SCOPE;

  if (typeof clientId !== 'string' || clientId === '') {
    throw new ValidationError('"clientId" must be a non-empty string', { code: 'INVALID_AUTH_CONFIG' });
  }
  if (typeof scope !== 'string' || scope === '') {
    throw new ValidationError('"scope" must be a non-empty string', { code: 'INVALID_AUTH_CONFIG' });
  }

  const xbox = createXboxAuth({ http, logger });
  const minecraft = createMinecraftAuth({ http, logger });

  async function startDeviceLogin() {
    let res;
    try {
      res = await http.postJson(
        DEVICE_CODE_URL,
        formBody({ client_id: clientId, scope }),
        { source: 'microsoft', headers: { ...FORM_HEADERS } }
      );
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      const upstreamStatus = err instanceof UpstreamError ? err.upstreamStatus ?? null : null;
      const upstream = err instanceof UpstreamError ? err.details?.upstream ?? null : null;
      throw new AuthError(
        upstream ? `Failed to start Microsoft device login — ${upstream}` : 'Failed to start Microsoft device login',
        {
          code: 'AUTH_DEVICE_START_FAILED',
          status: 502,
          cause: err,
          details: { stage: 'device', status: upstreamStatus, ...(upstream ? { upstream } : {}) },
        },
      );
    }

    const data = res.data ?? {};
    const deviceCode = typeof data.device_code === 'string' ? data.device_code : null;
    const userCode = typeof data.user_code === 'string' ? data.user_code : null;
    if (deviceCode === null || userCode === null) {
      throw new AuthError('Microsoft device login response is missing required fields', {
        code: 'AUTH_DEVICE_START_FAILED',
        status: 502,
        details: { stage: 'device', status: res.status },
      });
    }

    const expiresIn = Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : 900;
    const interval =
      Number.isFinite(data.interval) && data.interval > 0 ? data.interval : DEFAULT_POLL_INTERVAL;
    const verificationUri =
      typeof data.verification_uri === 'string' && data.verification_uri !== ''
        ? data.verification_uri
        : null;

    logger?.debug('device login started', { expiresIn, interval });
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete:
        typeof data.verification_uri_complete === 'string' && data.verification_uri_complete !== ''
          ? data.verification_uri_complete
          : null,
      interval,
      expiresAt: now() + expiresIn * 1000,
      expiresIn,
      message:
        typeof data.message === 'string' && data.message !== ''
          ? data.message
          : `Open ${verificationUri ?? 'https://microsoft.com/link'} and enter the code ${userCode}`,
    };
  }

  async function waitForDeviceToken(start, { signal, onAttempt } = {}) {
    if (start === null || typeof start !== 'object' || typeof start.deviceCode !== 'string') {
      throw new ValidationError('"start" must come from startDeviceLogin()', {
        code: 'INVALID_DEVICE_LOGIN',
        details: { stage: 'device' },
      });
    }

    let interval =
      Number.isFinite(start.interval) && start.interval > 0
        ? start.interval
        : DEFAULT_POLL_INTERVAL;

    for (let attempt = 1; ; attempt += 1) {
      if (signal?.aborted) throw abortError('device');
      if (Number.isFinite(start.expiresAt) && now() >= start.expiresAt) {
        throw new AuthError('The device login code has expired', {
          code: 'AUTH_DEVICE_EXPIRED',
          status: 400,
          details: { stage: 'device' },
        });
      }

      const res = await http.postJson(
        TOKEN_URL,
        formBody({
          grant_type: DEVICE_GRANT,
          client_id: clientId,
          device_code: start.deviceCode,
        }),
        { source: 'microsoft', headers: { ...FORM_HEADERS }, allowStatus: [400] }
      );

      if (res.status === 400) {
        const error = typeof res.data?.error === 'string' ? res.data.error : null;

        if (error === 'authorization_pending') {
          onAttempt?.({ attempt, interval, status: 'pending' });
          await sleep(interval * 1000, { signal });
          continue;
        }
        if (error === 'slow_down') {
          interval += SLOW_DOWN_INCREMENT_S;
          onAttempt?.({ attempt, interval, status: 'slow_down' });
          await sleep(interval * 1000, { signal });
          continue;
        }
        if (error === 'expired_token') {
          throw new AuthError('The device login code has expired', {
            code: 'AUTH_DEVICE_EXPIRED',
            status: 400,
            details: { stage: 'device', error },
          });
        }
        if (error === 'authorization_declined') {
          throw new AuthError('The sign-in request was declined', {
            code: 'AUTH_DECLINED',
            status: 400,
            details: { stage: 'device', error },
          });
        }
        throw new AuthError('Microsoft token endpoint rejected the device login', {
          code: 'AUTH_FAILED',
          status: 502,
          details: { stage: 'device', error: error ?? 'unknown-error' },
        });
      }

      const accessToken = typeof res.data?.access_token === 'string' ? res.data.access_token : null;
      if (accessToken === null) {
        throw new AuthError('Microsoft token response is missing the access token', {
          code: 'AUTH_FAILED',
          status: 502,
          details: { stage: 'device', status: res.status },
        });
      }

      const expiresIn = Number.isFinite(res.data?.expires_in)
        ? res.data.expires_in
        : DEFAULT_EXPIRES_IN;
      logger?.debug('device code approved', { expiresIn, attempts: attempt });
      return {
        accessToken,
        refreshToken: typeof res.data?.refresh_token === 'string' ? res.data.refresh_token : null,
        expiresAt: now() + expiresIn * 1000,
        expiresIn,
      };
    }
  }

  async function exchangeMsaTokens(msa, { signal, onStage } = {}) {
    if (msa === null || typeof msa !== 'object' || typeof msa.accessToken !== 'string') {
      throw new ValidationError('"msa" must contain an access token', {
        code: 'INVALID_MSA_TOKENS',
        details: { stage: 'xbox' },
      });
    }

    if (signal?.aborted) throw abortError('xbox');
    onStage?.('xbox');
    const xbl = await xbox.authenticateXbox(msa.accessToken);

    if (signal?.aborted) throw abortError('xsts');
    onStage?.('xsts');
    const xsts = await xbox.authorizeXsts(xbl.userToken);

    if (signal?.aborted) throw abortError('minecraft');
    onStage?.('minecraft');
    const mc = await minecraft.loginWithXbox(xsts.uhs, xsts.xstsToken);

    if (signal?.aborted) throw abortError('profile');
    onStage?.('profile');
    const profile = await minecraft.fetchProfile(mc.accessToken);

    const session = {
      type: 'msa',
      userType: 'msa',
      uuid: profile.uuid,
      username: profile.username,
      accessToken: mc.accessToken,
      refreshToken: typeof msa.refreshToken === 'string' ? msa.refreshToken : null,
      expiresAt: now() + mc.expiresIn * 1000,
      xuid: xsts.xuid ?? xbl.xuid ?? readMinecraftXuid(mc.accessToken),
    };

    logger?.debug('session issued', {
      username: session.username,
      uuid: session.uuid,
      expiresAt: session.expiresAt,
    });
    return Object.freeze(session);
  }

  async function completeDeviceLogin(start, opts = {}) {
    const msa = await waitForDeviceToken(start, opts);
    return exchangeMsaTokens(msa, opts);
  }

  async function refreshSession(session, opts = {}) {
    if (session === null || typeof session !== 'object' || typeof session.refreshToken !== 'string') {
      throw new AuthError('No refresh token stored for this account, sign in again', {
        code: 'AUTH_REFRESH_FAILED',
        status: 401,
        details: { stage: 'refresh', reason: 'missing-refresh-token' },
      });
    }

    let res;
    try {
      res = await http.postJson(
        TOKEN_URL,
        formBody({
          grant_type: REFRESH_GRANT,
          client_id: clientId,
          refresh_token: session.refreshToken,
          scope,
        }),
        { source: 'microsoft', headers: { ...FORM_HEADERS }, allowStatus: [400] }
      );
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      if (err instanceof UpstreamError && err.upstreamStatus === 429) {
        // กด refresh ถี่เกินไป → upstream ตอบ 429 — ส่งต่อเป็น 429 ไม่ใช่ 502 จะได้แยกออกจากกรณีพังจริง
        throw new AuthError('Too many sign-in requests — wait a moment and try again', {
          code: 'AUTH_THROTTLED',
          status: 429,
          cause: err,
          details: { stage: 'refresh', status: 429 },
        });
      }
      const upstreamStatus = err instanceof UpstreamError ? err.upstreamStatus ?? null : null;
      const upstream = err instanceof UpstreamError ? err.details?.upstream ?? null : null;
      throw new AuthError(
        upstream ? `Failed to refresh the Microsoft session — ${upstream}` : 'Failed to refresh the Microsoft session',
        {
          code: 'AUTH_REFRESH_FAILED',
          status: 502,
          cause: err,
          details: { stage: 'refresh', status: upstreamStatus, ...(upstream ? { upstream } : {}) },
        },
      );
    }

    if (res.status === 400) {
      throw new AuthError('The stored refresh token is no longer valid, sign in again', {
        code: 'AUTH_REFRESH_FAILED',
        status: 401,
        details: { stage: 'refresh', error: typeof res.data?.error === 'string' ? res.data.error : 'invalid_grant' },
      });
    }

    const accessToken = typeof res.data?.access_token === 'string' ? res.data.access_token : null;
    if (accessToken === null) {
      throw new AuthError('Microsoft refresh response is missing the access token', {
        code: 'AUTH_REFRESH_FAILED',
        status: 502,
        details: { stage: 'refresh', status: res.status },
      });
    }

    logger?.debug('microsoft tokens refreshed', {});
    return exchangeMsaTokens(
      {
        accessToken,
        refreshToken:
          typeof res.data?.refresh_token === 'string' ? res.data.refresh_token : session.refreshToken,
      },
      opts
    );
  }

  function isExpired(session, { skewMs = EXPIRY_SKEW_MS } = {}) {
    if (session === null || typeof session !== 'object') return true;
    if (!Number.isFinite(session.expiresAt)) return true;
    return session.expiresAt - skewMs <= now();
  }

  return {
    startDeviceLogin,
    waitForDeviceToken,
    exchangeMsaTokens,
    completeDeviceLogin,
    refreshSession,
    isExpired,
  };
}
