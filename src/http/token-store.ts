import { randomBytes } from 'node:crypto';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

interface Grant {
  upstreamAccess: string;
  scopes: string[];
  expiresAt: number;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const opaqueToken = (): string => randomBytes(32).toString('base64url');
const parseScopes = (scope?: string): string[] => (scope ? scope.split(/\s+/).filter(Boolean) : []);

/**
 * Maps the MCP server's own opaque tokens to the upstream BeeL tokens.
 *
 * The server issues opaque tokens to clients (Claude) so there is no issuer or
 * audience for the client to reject — access tokens are opaque to clients by
 * spec — and forwards the stored BeeL token to the API on each call.
 *
 * In-memory: tokens are lost on restart (the client re-authenticates) and bound
 * to a single instance. Behind a load balancer, route by `mcp-session-id` or add
 * a shared store.
 */
export class TokenStore {
  private readonly access = new Map<string, Grant>();
  private readonly refresh = new Map<string, string>(); // our refresh -> upstream refresh

  /** Wrap an upstream BeeL token set in our own opaque tokens. */
  issue(upstream: OAuthTokens): OAuthTokens {
    this.sweep();
    const accessToken = opaqueToken();
    this.access.set(accessToken, {
      upstreamAccess: upstream.access_token,
      scopes: parseScopes(upstream.scope),
      expiresAt: nowSec() + (upstream.expires_in ?? 3600),
    });

    let refreshToken: string | undefined;
    if (upstream.refresh_token) {
      refreshToken = opaqueToken();
      this.refresh.set(refreshToken, upstream.refresh_token);
    }

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: upstream.expires_in,
      scope: upstream.scope,
      refresh_token: refreshToken,
    };
  }

  /** Resolve our access token to AuthInfo carrying the upstream token for API calls. */
  resolve(accessToken: string, clientId: string): AuthInfo {
    const grant = this.access.get(accessToken);
    if (!grant || grant.expiresAt < nowSec()) {
      this.access.delete(accessToken);
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return { token: grant.upstreamAccess, clientId, scopes: grant.scopes, expiresAt: grant.expiresAt };
  }

  /** Translate our refresh token to the upstream one (undefined if unknown). */
  upstreamRefresh(refreshToken: string): string | undefined {
    return this.refresh.get(refreshToken);
  }

  private sweep(): void {
    const now = nowSec();
    for (const [token, grant] of this.access) {
      if (grant.expiresAt < now) this.access.delete(token);
    }
  }
}
