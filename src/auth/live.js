// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later
//
// LIVE FLOW — ระบบ sign-in ทางเลือกชั่วคราว (ไม่ต้องรอ Microsoft app review)
// ลบทั้งไฟล์นี้ได้เมื่อแอปผ่าน review — จุดอื่นที่เกี่ยวข้องทำเครื่องหมาย "// LIVE FLOW" ไว้ครบ
// ดู README: "ระบบเสริม: Live sign-in flow (ลบเมื่อแอปผ่าน review)" สำหรับรายการจุดที่ต้องลบ

import { AuthError, CancelledError, UpstreamError, ValidationError } from '../core/errors.js';
import { httpClient } from '../net/http.js';
import {
  XBOX_AUTHENTICATE_URL,
  XSTS_AUTHORIZE_URL,
  XBOX_RELYING_PARTY,
  MINECRAFT_RELYING_PARTY,
} from './xbox.js';
import { createMinecraftAuth, readMinecraftXuid } from './minecraft.js';

// Title ID แรกของ Minecraft (Nintendo Switch) — client สาธารณะของ Microsoft ที่
// prismarine-auth และ launcher/open-source หลายตัวใช้ production เพื่อดึง token ของ Minecraft Java
export const LIVE_TITLE_ID = '00000000441cc96b';
export const LIVE_DEVICE_CODE_URL = 'https://login.live.com/oauth20_connect.srf';
export const LIVE_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
export const LIVE_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
// login.live.com รับ grant_type แบบ plain "refresh_token" เท่านั้น —
// แบบ URN (urn:ietf:params:oauth:grant-type:refresh_token) ถูกตอบ 400 unsupported_grant_type (วัดจากของจริงแล้ว)
// แต่ device_code ใช้ URN ได้ — ทั้งสองค่านี้จึงต่างกันโดยตั้งใจ
export const LIVE_REFRESH_GRANT = 'refresh_token';
export const LIVE_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const LIVE_DEFAULT_EXPIRES_IN = 3600;
export const LIVE_POLL_INTERVAL = 5;
export const LIVE_SLOW_DOWN_INCREMENT_S = 5;
export const LIVE_EXPIRY_SKEW_MS = 60_000;

const FORM_HEADERS = Object.freeze({
  'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
});

const XERR_MESSAGES = Object.freeze({
  2148916233: 'This Microsoft account has no Xbox Live profile attached',
  2148916235: 'Xbox Live is not available in your country',
  2148916238: 'This is a child account; it must be added to a family before signing in',
});

function formBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  return params.toString();
}

function readUserClaims(payload) {
  const claims = payload?.DisplayClaims?.xui;
  const first = Array.isArray(claims) && claims.length > 0 ? claims[0] : null;
  const uhs = first && typeof first.uhs === 'string' ? first.uhs : null;
  const xuid = first && typeof first.xid === 'string' ? first.xid : null;
  return { uhs, xuid };
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
      { once: true },
    );
  });
}

function abortError(stage) {
  return new CancelledError('Authentication cancelled', { details: { stage } });
}

export function createLiveAuth(options = {}) {
  const http = options.http ?? httpClient;
  const logger = options.logger ?? null;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const titleId =
    typeof options.titleId === 'string' && options.titleId !== '' ? options.titleId : LIVE_TITLE_ID;
  const clientId = titleId;

  const minecraft = createMinecraftAuth({ http, logger });

  async function startDeviceLogin() {
    let res;
    try {
      res = await http.postJson(
        LIVE_DEVICE_CODE_URL,
        formBody({ client_id: clientId, scope: LIVE_SCOPE, response_type: 'device_code' }),
        { source: 'microsoft', headers: { ...FORM_HEADERS } },
      );
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      const upstreamStatus = err instanceof UpstreamError ? err.upstreamStatus ?? null : null;
      const upstream = err instanceof UpstreamError ? err.details?.upstream ?? null : null;
      throw new AuthError(
        upstream
          ? `Failed to start Microsoft device login — ${upstream}`
          : 'Failed to start Microsoft device login',
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

    const expiresIn =
      Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : 900;
    const interval =
      Number.isFinite(data.interval) && data.interval > 0 ? data.interval : LIVE_POLL_INTERVAL;
    const verificationUri =
      typeof data.verification_uri === 'string' && data.verification_uri !== ''
        ? data.verification_uri
        : 'https://www.microsoft.com/link';

    logger?.debug('live device login started', { expiresIn, interval });
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: null,
      interval,
      expiresAt: now() + expiresIn * 1000,
      expiresIn,
      message: `Open ${verificationUri} and enter this code ${userCode}`,
      flow: 'live',
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
        : LIVE_POLL_INTERVAL;

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
        `${LIVE_TOKEN_URL}?client_id=${encodeURIComponent(clientId)}`,
        formBody({
          client_id: clientId,
          device_code: start.deviceCode,
          grant_type: LIVE_DEVICE_GRANT,
        }),
        { source: 'microsoft', headers: { ...FORM_HEADERS }, allowStatus: [400] },
      );

      if (res.status === 400) {
        const error = typeof res.data?.error === 'string' ? res.data.error : null;

        if (error === 'authorization_pending') {
          onAttempt?.({ attempt, interval, status: 'pending' });
          await sleep(interval * 1000, { signal });
          continue;
        }
        if (error === 'slow_down') {
          interval += LIVE_SLOW_DOWN_INCREMENT_S;
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
        : LIVE_DEFAULT_EXPIRES_IN;
      logger?.debug('live device code approved', { expiresIn, attempts: attempt });
      return {
        accessToken,
        refreshToken: typeof res.data?.refresh_token === 'string' ? res.data.refresh_token : null,
        expiresAt: now() + expiresIn * 1000,
        expiresIn,
      };
    }
  }

  // RpsTicket ของ live flow ใช้ "t=" (AAD ใช้ "d=") — ดู src/auth/xbox.js สำหรับแบบ AAD
  async function authenticateXboxLive(msaAccessToken) {
    if (typeof msaAccessToken !== 'string' || msaAccessToken === '') {
      throw new AuthError('Microsoft access token is required for Xbox authentication', {
        code: 'AUTH_XBOX_FAILED',
        status: 400,
        details: { stage: 'xbox', reason: 'missing-token' },
      });
    }

    const res = await http.postJson(
      XBOX_AUTHENTICATE_URL,
      {
        Properties: {
          AuthMethod: 'RPS',
          SiteName: 'user.auth.xboxlive.com',
          RpsTicket: `t=${msaAccessToken}`,
        },
        RelyingParty: XBOX_RELYING_PARTY,
        TokenType: 'JWT',
      },
      { source: 'microsoft', allowStatus: [401, 403] },
    );

    if (res.status < 200 || res.status >= 300) {
      throw new AuthError('Xbox Live rejected the Microsoft access token', {
        code: 'AUTH_XBOX_FAILED',
        status: 403,
        details: { stage: 'xbox', status: res.status },
      });
    }

    const token = typeof res.data?.Token === 'string' ? res.data.Token : null;
    const { uhs, xuid } = readUserClaims(res.data);
    if (token === null || uhs === null) {
      throw new AuthError('Xbox Live response is missing the user token', {
        code: 'AUTH_XBOX_FAILED',
        status: 502,
        details: { stage: 'xbox', status: res.status },
      });
    }

    logger?.debug('live xbox user token issued', { xuid });
    return { userToken: token, uhs, xuid };
  }

  async function authorizeXstsLive(userToken) {
    if (typeof userToken !== 'string' || userToken === '') {
      throw new AuthError('Xbox user token is required for XSTS authorization', {
        code: 'AUTH_XSTS_FAILED',
        status: 400,
        details: { stage: 'xsts', reason: 'missing-token' },
      });
    }

    const res = await http.postJson(
      XSTS_AUTHORIZE_URL,
      {
        Properties: { SandboxId: 'RETAIL', UserTokens: [userToken] },
        RelyingParty: MINECRAFT_RELYING_PARTY,
        TokenType: 'JWT',
      },
      { source: 'microsoft', allowStatus: [401, 403] },
    );

    if (res.status < 200 || res.status >= 300) {
      const xErr = typeof res.data?.XErr === 'number' ? res.data.XErr : null;
      throw new AuthError(XERR_MESSAGES[xErr] ?? 'Xbox Security Token Service refused the request', {
        code: 'AUTH_XSTS_FAILED',
        status: 403,
        details: { stage: 'xsts', status: res.status, xErr },
      });
    }

    const token = typeof res.data?.Token === 'string' ? res.data.Token : null;
    const { uhs, xuid } = readUserClaims(res.data);
    if (token === null || uhs === null) {
      throw new AuthError('XSTS response is missing the security token', {
        code: 'AUTH_XSTS_FAILED',
        status: 502,
        details: { stage: 'xsts', status: res.status },
      });
    }

    logger?.debug('live xsts token issued', {});
    return { xstsToken: token, uhs, xuid };
  }

  async function exchangeLiveTokens(msa, { signal, onStage } = {}) {
    if (msa === null || typeof msa !== 'object' || typeof msa.accessToken !== 'string') {
      throw new ValidationError('"msa" must contain an access token', {
        code: 'INVALID_MSA_TOKENS',
        details: { stage: 'xbox' },
      });
    }

    if (signal?.aborted) throw abortError('xbox');
    onStage?.('xbox');
    const xbl = await authenticateXboxLive(msa.accessToken);

    if (signal?.aborted) throw abortError('xsts');
    onStage?.('xsts');
    const xsts = await authorizeXstsLive(xbl.userToken);

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
      flow: 'live',
    };

    logger?.debug('live session issued', {
      username: session.username,
      uuid: session.uuid,
      expiresAt: session.expiresAt,
    });
    return Object.freeze(session);
  }

  async function completeDeviceLogin(start, opts = {}) {
    const msa = await waitForDeviceToken(start, opts);
    return exchangeLiveTokens(msa, opts);
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
        LIVE_TOKEN_URL,
        formBody({
          scope: LIVE_SCOPE,
          client_id: clientId,
          grant_type: LIVE_REFRESH_GRANT,
          refresh_token: session.refreshToken,
        }),
        { source: 'microsoft', headers: { ...FORM_HEADERS }, allowStatus: [400] },
      );
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      if (err instanceof UpstreamError && err.upstreamStatus === 429) {
        // กด refresh ถี่เกินไป → Microsoft ตอบ 429 — ส่งต่อเป็น 429 ไม่ใช่ 502 จะได้แยกออกจากกรณีพังจริง
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
        upstream
          ? `Failed to refresh the Microsoft session — ${upstream}`
          : 'Failed to refresh the Microsoft session',
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
        details: {
          stage: 'refresh',
          error: typeof res.data?.error === 'string' ? res.data.error : 'invalid_grant',
        },
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

    logger?.debug('live session refreshed', {});
    return exchangeLiveTokens(
      {
        accessToken,
        refreshToken:
          typeof res.data?.refresh_token === 'string' ? res.data.refresh_token : session.refreshToken,
      },
      opts,
    );
  }

  function isExpired(session, { skewMs = LIVE_EXPIRY_SKEW_MS } = {}) {
    if (session === null || typeof session !== 'object') return true;
    if (!Number.isFinite(session.expiresAt)) return true;
    return session.expiresAt - skewMs <= now();
  }

  return {
    startDeviceLogin,
    waitForDeviceToken,
    exchangeLiveTokens,
    completeDeviceLogin,
    refreshSession,
    isExpired,
    source: 'live',
  };
}
