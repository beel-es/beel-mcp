import { generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { exportJWK, type JWK, SignJWT } from 'jose';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

interface Grant {
  upstreamAccess: string;
  scopes: string[];
  expiresAt: number;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const randomString = (): string => randomBytes(32).toString('base64url');
const parseScopes = (scope?: string): string[] => (scope ? scope.split(/\s+/).filter(Boolean) : []);

/**
 * Issues the MCP server's OWN access tokens (signed JWTs) to clients and maps
 * them to the upstream BeeL tokens.
 *
 * MCP clients (Claude) validate the access token against the authorization server
 * they used — its `iss` must be this server and `aud` the resource — so we cannot
 * pass BeeL's token (different iss/aud) nor an opaque string through. We mint a
 * JWT signed with our own key (published at the JWKS endpoint) and keep the BeeL
 * token internally to call the API.
 *
 * Key and store are in-memory: tokens are invalidated on restart (the client
 * re-authenticates) and bound to a single instance. Run a single replica, or add
 * a shared key + store behind a load balancer.
 */
export class TokenIssuer {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly kid = randomUUID();
  private cachedJwk?: JWK;
  private readonly grants = new Map<string, Grant>();
  private readonly refreshMap = new Map<string, string>(); // our refresh -> upstream refresh

  constructor(
    private readonly issuer: string,
    private readonly audience: string[],
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.publicKey = publicKey;
  }

  /** Mint our own signed JWT for an upstream BeeL token set. */
  async issue(upstream: OAuthTokens, subject: string): Promise<OAuthTokens> {
    this.sweep();
    const expiresIn = upstream.expires_in ?? 3600;
    const scopes = parseScopes(upstream.scope);
    const accessToken = await new SignJWT({ scope: upstream.scope ?? scopes.join(' ') })
      .setProtectedHeader({ alg: 'RS256', kid: this.kid })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(`${expiresIn}s`)
      .sign(this.privateKey);

    this.grants.set(accessToken, {
      upstreamAccess: upstream.access_token,
      scopes,
      expiresAt: nowSec() + expiresIn,
    });

    let refreshToken: string | undefined;
    if (upstream.refresh_token) {
      refreshToken = randomString();
      this.refreshMap.set(refreshToken, upstream.refresh_token);
    }

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: upstream.scope,
      refresh_token: refreshToken,
    };
  }

  /** Resolve our token to AuthInfo carrying the upstream token for API calls. */
  resolve(accessToken: string, clientId: string): AuthInfo {
    const grant = this.grants.get(accessToken);
    if (!grant || grant.expiresAt < nowSec()) {
      this.grants.delete(accessToken);
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return { token: grant.upstreamAccess, clientId, scopes: grant.scopes, expiresAt: grant.expiresAt };
  }

  /** Translate our refresh token to the upstream one (undefined if unknown). */
  upstreamRefresh(refreshToken: string): string | undefined {
    return this.refreshMap.get(refreshToken);
  }

  /** JWKS document with our public signing key (for clients to verify our tokens). */
  async jwks(): Promise<{ keys: JWK[] }> {
    this.cachedJwk ??= { ...(await exportJWK(this.publicKey)), kid: this.kid, use: 'sig', alg: 'RS256' };
    return { keys: [this.cachedJwk] };
  }

  private sweep(): void {
    const now = nowSec();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt < now) this.grants.delete(token);
    }
  }
}
