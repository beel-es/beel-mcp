import type { Response } from 'express';
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { KeyEnv, ResolvedConfig } from '../config.js';
import { TokenStore } from './token-store.js';

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

/**
 * The MCP server as an OAuth authorization-server facade in front of BeeL.
 *
 * - authorize: redirects to BeeL (inherited passthrough).
 * - token: exchanges the code with BeeL, then issues OUR OWN opaque token to the
 *   client (so there is no upstream iss/aud for the client to reject) while
 *   keeping the BeeL token internally to call the API.
 * - register: returns the fixed pre-registered client (BeeL has no DCR), so
 *   clients self-register and the user enters no credentials.
 * - verifyAccessToken: resolves our opaque token to the upstream BeeL token.
 */
class BeelOAuthProvider extends ProxyOAuthServerProvider {
  constructor(
    private readonly config: OAuthConfig,
    private readonly store: TokenStore,
  ) {
    super({
      endpoints: {
        authorizationUrl: config.authorizationEndpoint,
        tokenUrl: config.tokenEndpoint,
        revocationUrl: config.revocationEndpoint,
      },
      // Never used: verifyAccessToken is overridden to use the token store.
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
    return this.store.issue(upstream);
  }

  override async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const upstreamRefresh = this.store.upstreamRefresh(refreshToken) ?? refreshToken;
    const upstream = await super.exchangeRefreshToken(client, upstreamRefresh, scopes, resource);
    return this.store.issue(upstream);
  }

  override verifyAccessToken(token: string): Promise<AuthInfo> {
    return Promise.resolve(this.store.resolve(token, this.config.clientId));
  }
}

export function createOAuthProvider(config: OAuthConfig): ProxyOAuthServerProvider {
  return new BeelOAuthProvider(config, new TokenStore());
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
