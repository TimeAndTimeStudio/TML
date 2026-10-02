// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { AuthError } from '../core/errors.js';
import { httpClient } from '../net/http.js';

export const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
export const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

const DASHED_UUID = /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/i;
const UPSTREAM_MESSAGE_KEYS = Object.freeze(['error_description', 'error_details', 'errorMessage', 'error', 'message']);
const JWT_CLAIM_KEYS = Object.freeze(['aud', 'iss', 'nbf', 'exp', 'iat']);

// Read claims only — the token itself never reaches the logger.
function decodeJwtClaims(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length < 2 || parts[1] === '') return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const claims = {};
    for (const key of JWT_CLAIM_KEYS) {
      if (payload[key] !== undefined) claims[key] = payload[key];
    }
    return claims;
  } catch {
    return null;
  }
}

function readUpstreamMessage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  for (const key of UPSTREAM_MESSAGE_KEYS) {
    const value = data[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 300);
  }
  return null;
}

export function formatUuid(rawId) {
  const match = typeof rawId === 'string' ? DASHED_UUID.exec(rawId.replace(/-/g, '')) : null;
  if (match === null) return null;
  return `${match[1]}-${match[2]}-${match[3]}-${match[4]}-${match[5]}`;
}

// XUID อยู่ใน claim ของ Minecraft access token (JWT payload ตัวกลาง) —
// ใช้เป็น fallback เมื่อ DisplayClaims ของ Xbox/XSTS ไม่คืน field xid (ตอบกลับมาเฉพาะ uhs)
// อ่านเฉพาะบนเครื่อง ไม่ยิง network ไม่ verify signature (token มาจากแหล่งที่เชื่อถือได้อยู่แล้ว)
export function readMinecraftXuid(accessToken) {
  if (typeof accessToken !== 'string' || accessToken === '') return null;
  const parts = accessToken.split('.');
  if (parts.length !== 3 || typeof parts[1] !== 'string' || parts[1] === '') return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const xuid = claims?.xuid;
    return typeof xuid === 'string' && xuid !== '' ? xuid : null;
  } catch {
    return null;
  }
}

export function createMinecraftAuth(options = {}) {
  const http = options.http ?? httpClient;
  const logger = options.logger ?? null;

  async function loginWithXbox(uhs, xstsToken) {
    if (typeof uhs !== 'string' || uhs === '' || typeof xstsToken !== 'string' || xstsToken === '') {
      throw new AuthError('XSTS token is required for Minecraft Services login', {
        code: 'AUTH_MC_LOGIN_FAILED',
        status: 400,
        details: { stage: 'minecraft', reason: 'missing-token' },
      });
    }

    const res = await http.postJson(
      MC_LOGIN_URL,
      { identityToken: `XBL3.0 x=${uhs};${xstsToken}` },
      { source: 'microsoft', allowStatus: [401, 403] }
    );

    if (res.status < 200 || res.status >= 300) {
      const upstream = readUpstreamMessage(res.data);
      let body = null;
      try {
        body = res.data === null ? null : JSON.stringify(res.data).slice(0, 300);
      } catch {
        body = null;
      }
      logger?.warn('minecraft login refused', {
        status: res.status,
        upstream,
        body,
        xsts: decodeJwtClaims(xstsToken),
        now: Math.floor(Date.now() / 1000),
      });
      throw new AuthError(
        upstream
          ? `Minecraft Services rejected the Xbox identity token — ${upstream}`
          : `Minecraft Services rejected the Xbox identity token (upstream HTTP ${res.status})`,
        {
          code: 'AUTH_MC_LOGIN_FAILED',
          status: 401,
          details: { stage: 'minecraft', status: res.status, ...(upstream ? { upstream } : {}) },
        },
      );
    }

    const accessToken = typeof res.data?.access_token === 'string' ? res.data.access_token : null;
    if (accessToken === null) {
      throw new AuthError('Minecraft Services response is missing the access token', {
        code: 'AUTH_MC_LOGIN_FAILED',
        status: 502,
        details: { stage: 'minecraft', status: res.status },
      });
    }

    const expiresIn = Number.isFinite(res.data?.expires_in) ? res.data.expires_in : 86400;
    logger?.debug('minecraft access token issued', { expiresIn });
    return { accessToken, expiresIn };
  }

  async function fetchProfile(accessToken) {
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new AuthError('Minecraft access token is required to read the profile', {
        code: 'AUTH_PROFILE_FAILED',
        status: 400,
        details: { stage: 'profile', reason: 'missing-token' },
      });
    }

    const res = await http.getJson(MC_PROFILE_URL, {
      source: 'microsoft',
      allowStatus: [401, 403, 404],
      headers: { authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 403) {
      throw new AuthError('This Microsoft account does not own Minecraft', {
        code: 'AUTH_GAME_NOT_OWNED',
        status: 403,
        details: { stage: 'profile', status: res.status },
      });
    }
    if (res.status === 404) {
      throw new AuthError('This account has no Minecraft profile yet', {
        code: 'AUTH_NO_PROFILE',
        status: 404,
        details: { stage: 'profile', status: res.status },
      });
    }
    if (res.status < 200 || res.status >= 300) {
      throw new AuthError('Failed to read the Minecraft profile', {
        code: 'AUTH_PROFILE_FAILED',
        status: 502,
        details: { stage: 'profile', status: res.status },
      });
    }

    const uuid = formatUuid(res.data?.id);
    const username = typeof res.data?.name === 'string' && res.data.name !== '' ? res.data.name : null;
    if (uuid === null || username === null) {
      throw new AuthError('Minecraft profile response is missing id or name', {
        code: 'AUTH_PROFILE_FAILED',
        status: 502,
        details: { stage: 'profile', status: res.status },
      });
    }

    logger?.debug('minecraft profile loaded', { username });
    return { uuid, username };
  }

  return { loginWithXbox, fetchProfile };
}
