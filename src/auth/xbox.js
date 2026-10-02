// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { AuthError } from '../core/errors.js';
import { httpClient } from '../net/http.js';

export const XBOX_AUTHENTICATE_URL = 'https://user.auth.xboxlive.com/user/authenticate';
export const XSTS_AUTHORIZE_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
export const XBOX_RELYING_PARTY = 'http://auth.xboxlive.com';
export const MINECRAFT_RELYING_PARTY = 'rp://api.minecraftservices.com/';

const XERR_MESSAGES = Object.freeze({
  2148916233: 'This Microsoft account has no Xbox Live profile attached',
  2148916235: 'Xbox Live is not available in your country',
  2148916238: 'This is a child account; it must be added to a family before signing in',
});

function readUserClaims(payload) {
  const claims = payload?.DisplayClaims?.xui;
  const first = Array.isArray(claims) && claims.length > 0 ? claims[0] : null;
  const uhs = first && typeof first.uhs === 'string' ? first.uhs : null;
  const xuid = first && typeof first.xid === 'string' ? first.xid : null;
  return { uhs, xuid };
}

export function createXboxAuth(options = {}) {
  const http = options.http ?? httpClient;
  const logger = options.logger ?? null;

  async function authenticateXbox(msaAccessToken) {
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
          RpsTicket: `d=${msaAccessToken}`,
        },
        RelyingParty: XBOX_RELYING_PARTY,
        TokenType: 'JWT',
      },
      { source: 'microsoft', allowStatus: [401, 403] }
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

    logger?.debug('xbox user token issued', { xuid });
    return { userToken: token, uhs, xuid };
  }

  async function authorizeXsts(userToken) {
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
      { source: 'microsoft', allowStatus: [401, 403] }
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

    logger?.debug('xsts token issued', {});
    return { xstsToken: token, uhs, xuid };
  }

  return { authenticateXbox, authorizeXsts };
}
