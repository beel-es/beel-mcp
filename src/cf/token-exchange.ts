/**
 * Keeping the upstream BeeL token alive across refreshes.
 *
 * The MCP client refreshes this server's token; that refresh is the only moment
 * anything can renew the BeeL token travelling in the grant's props. If the
 * renewal is impossible the grant is dead, and the client must be told so in the
 * one way it understands — `invalid_grant`, which makes it start consent again.
 * Anything else surfaces as a 500 and leaves a stale bearer in the props that
 * 401s every subsequent tool call.
 */

import { OAuthError } from '@cloudflare/workers-oauth-provider';
import type {
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from '@cloudflare/workers-oauth-provider';
import {
  TokenEndpointError,
  refreshUpstream,
  upstreamConfig,
  workerAccessTokenTTL,
} from './upstream.js';
import type { EnvRecord } from '../shared/env.js';

/** The session bearer and its scopes, as stored in the grant's encrypted props. */
export interface SessionProps extends Record<string, unknown> {
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
}

/** A grant with no refresh token can never be renewed; say so in OAuth terms. */
function deadGrant(description: string): never {
  throw new OAuthError('invalid_grant', { description });
}

/**
 * Built per request so the bindings reach it through a closure. The provider
 * calls it with no `env` of its own, and a module-level one would be whatever
 * the last request happened to set — or nothing at all on a cold isolate.
 */
export function createTokenExchangeCallback(
  env: EnvRecord,
): (options: TokenExchangeCallbackOptions) => Promise<TokenExchangeCallbackResult | undefined> {
  return async ({ grantType, props }) => {
    if (grantType !== 'refresh_token') return undefined;
    const session = props as SessionProps;
    if (!session.refreshToken) {
      deadGrant('the upstream session cannot be renewed; authorize again');
    }
    try {
      const tokens = await refreshUpstream(upstreamConfig(env), session.refreshToken);
      return {
        newProps: {
          ...session,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? session.refreshToken,
        },
        accessTokenTTL: workerAccessTokenTTL(tokens.expires_in),
      };
    } catch (error) {
      if (error instanceof TokenEndpointError) {
        deadGrant(`the upstream refresh failed (${error.oauthError ?? error.status})`);
      }
      throw error;
    }
  };
}
