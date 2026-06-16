import type { Response } from 'express';
import { decodeJwt } from 'jose';
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { KeyEnv, ResolvedConfig } from '../config.js';
import { TokenIssuer } from './token-store.js';

/**
 * OAuth configuration. The MCP server fronts BeeL's authorization server as a
 * token-minting proxy (see BeelOAuthProvider). All endpoints are overridable via
 * env so the same code can target a local/test issuer.
 */
export interface OAuthConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  /** Public URL of this MCP server (it is the authorization server clients see). */
  resourceServerUrl: string;
  apiBaseUrl: string;
  /** Pre-registered OAuth client at BeeL used to drive the upstream flow. */
  clientId: string;
  /** Set only if the BeeL client is confidential; empty for a public (PKCE) client. */
  clientSecret: string;
  /** redirect_uris the connector is allowed to use (e.g. Claude's callback). */
  redirectUris: string[];
}

/** Scopes BeeL exposes, advertised in the authorization-server metadata. */
export const SUPPORTED_SCOPES = [
  'invoices:read',
  'invoices:write',
  'customers:read',
  'customers:write',
  'products:read',
  'products:write',
  'configuration:read',
  'configuration:write',
  'series:read',
  'series:write',
  'taxes:read',
  'nif:validate',
  'business_profiles:read',
  'business_profiles:write',
  'sandbox',
];

export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const issuer = (env.BEEL_OAUTH_ISSUER ?? 'https://app.beel.es').replace(/\/$/, '');
  return {
    issuer,
    authorizationEndpoint: env.BEEL_OAUTH_AUTHORIZE_URL ?? `${issuer}/oauth2/authorize`,
    tokenEndpoint: env.BEEL_OAUTH_TOKEN_URL ?? `${issuer}/oauth2/token`,
    revocationEndpoint: env.BEEL_OAUTH_REVOKE_URL ?? `${issuer}/oauth2/revoke`,
    resourceServerUrl: (env.MCP_PUBLIC_URL ?? 'https://mcp.beel.es').replace(/\/$/, ''),
    apiBaseUrl: env.BEEL_BASE_URL ?? 'https://app.beel.es/api',
    clientId: env.BEEL_OAUTH_CLIENT_ID ?? 'beel-mcp',
    clientSecret: env.BEEL_OAUTH_CLIENT_SECRET ?? '',
    redirectUris: (env.BEEL_OAUTH_REDIRECT_URIS ?? 'https://claude.ai/api/mcp/auth_callback')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
  };
}

/**
 * The pre-registered BeeL client as MCP client information. Public (PKCE, no
 * secret) by default — the cleanest "paste the URL and log in" UX; confidential
 * when BEEL_OAUTH_CLIENT_SECRET is set.
 */
function clientInformation(config: OAuthConfig, redirectUris?: string[]): OAuthClientInformationFull {
  const info: OAuthClientInformationFull = {
    client_id: config.clientId,
    redirect_uris: redirectUris?.length ? redirectUris : config.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: SUPPORTED_SCOPES.join(' '),
    token_endpoint_auth_method: config.clientSecret ? 'client_secret_basic' : 'none',
  };
  if (config.clientSecret) info.client_secret = config.clientSecret;
  return info;
}

/** Best-effort subject for our token: the user id from the BeeL token, else the client id. */
function subjectFrom(upstream: OAuthTokens, fallback: string): string {
  try {
    const claims = decodeJwt(upstream.access_token);
    const sub = claims.user_id ?? claims.sub;
    if (typeof sub === 'string' && sub) return sub;
  } catch {
    /* upstream token is not a JWT */
  }
  return fallback;
}

/**
 * The MCP server as an OAuth authorization-server facade in front of BeeL.
 *
 * - authorize: redirects to BeeL (inherited passthrough).
 * - token: exchanges the code with BeeL, then mints OUR OWN signed JWT (iss = this
 *   server, aud = the resource) for the client, keeping the BeeL token internally.
 * - register: returns the fixed pre-registered client (BeeL has no DCR), so clients
 *   self-register and the user enters no credentials.
 * - verifyAccessToken: resolves our token to the upstream BeeL token for API calls.
 */
export class BeelOAuthProvider extends ProxyOAuthServerProvider {
  constructor(
    private readonly config: OAuthConfig,
    private readonly issuer: TokenIssuer,
  ) {
    super({
      endpoints: {
        authorizationUrl: config.authorizationEndpoint,
        tokenUrl: config.tokenEndpoint,
        revocationUrl: config.revocationEndpoint,
      },
      // Never used: verifyAccessToken is overridden to use the token issuer.
      verifyAccessToken: () => Promise.reject(new Error('unused')),
      getClient: async () => clientInformation(config),
    });
    this.skipLocalPkceValidation = true; // BeeL validates PKCE at its token endpoint
  }

  override get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async () => clientInformation(this.config),
      registerClient: async (client: OAuthClientInformationFull) =>
        clientInformation(this.config, client.redirect_uris),
    };
  }

  override authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    return super.authorize(client, params, res);
  }

  override async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const upstream = await super.exchangeAuthorizationCode(
      client,
      authorizationCode,
      codeVerifier,
      redirectUri,
      resource,
    );
    return this.issuer.issue(upstream, subjectFrom(upstream, this.config.clientId));
  }

  override async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const upstreamRefresh = this.issuer.upstreamRefresh(refreshToken) ?? refreshToken;
    const upstream = await super.exchangeRefreshToken(client, upstreamRefresh, scopes, resource);
    return this.issuer.issue(upstream, subjectFrom(upstream, this.config.clientId));
  }

  override verifyAccessToken(token: string): Promise<AuthInfo> {
    return Promise.resolve(this.issuer.resolve(token, this.config.clientId));
  }

  /** JWKS document for clients to verify the tokens we issue. */
  jwks(): Promise<{ keys: unknown[] }> {
    return this.issuer.jwks();
  }
}

export function createOAuthProvider(config: OAuthConfig): BeelOAuthProvider {
  // Our tokens are addressed to this server: iss = the server, aud = the resource
  // (accept it with and without a trailing slash, since clients vary).
  const url = config.resourceServerUrl;
  return new BeelOAuthProvider(config, new TokenIssuer(url, [url, `${url}/`]));
}

/**
 * Per-request API credentials from the validated token. The upstream BeeL token
 * (carried in AuthInfo.token) is forwarded as the bearer to the API; the
 * environment is inferred from the granted `sandbox` scope.
 */
export function configFromAuth(auth: AuthInfo, config: OAuthConfig): ResolvedConfig {
  const env: KeyEnv = auth.scopes.includes('sandbox') ? 'test' : 'live';
  return { apiKey: auth.token, env, baseUrl: config.apiBaseUrl };
}
