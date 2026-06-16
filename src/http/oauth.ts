import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { KeyEnv, ResolvedConfig } from '../config.js';

/**
 * OAuth configuration for the BeeL authorization server. BeeL issues RS256 JWT
 * access tokens validatable offline via JWKS; the environment (production vs
 * sandbox) is carried in the `environment` claim (driven by the `sandbox` scope
 * at authorization time). All endpoints are overridable via env so the same code
 * can be pointed at a local issuer for testing.
 */
export interface OAuthConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint: string;
  /** Public URL of this MCP resource server (advertised in metadata). */
  resourceServerUrl: string;
  apiBaseUrl: string;
  /** Pre-registered OAuth client at BeeL (the MCP server proxies the flow with it). */
  clientId: string;
  clientSecret: string;
  /** redirect_uris the connector is allowed to use (e.g. Claude's callback). */
  redirectUris: string[];
}

/** All scopes BeeL exposes, advertised in the protected-resource metadata. */
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
    jwksUri: env.BEEL_OAUTH_JWKS_URL ?? `${issuer}/oauth2/jwks`,
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
 * OAuth proxy provider: the MCP server fronts BeeL's authorization server,
 * exposing /authorize, /token and /revoke on its own domain and forwarding them
 * upstream. MCP clients (Claude) expect the OAuth endpoints on the MCP server,
 * so a pure resource-server pointing at an external AS isn't enough — this proxies.
 * PKCE is validated upstream by BeeL, not locally.
 */
export function createProxyProvider(config: OAuthConfig): ProxyOAuthServerProvider {
  const provider = new ProxyOAuthServerProvider({
    endpoints: {
      authorizationUrl: `${config.issuer}/oauth2/authorize`,
      tokenUrl: `${config.issuer}/oauth2/token`,
      revocationUrl: `${config.issuer}/oauth2/revoke`,
    },
    verifyAccessToken: (token) => createBeelTokenVerifier(config).verifyAccessToken(token),
    getClient: async (clientId) => ({
      client_id: clientId,
      client_secret: config.clientSecret,
      redirect_uris: config.redirectUris,
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SUPPORTED_SCOPES.join(' '),
    }),
  });
  // BeeL holds the PKCE challenge and validates it at the token endpoint.
  provider.skipLocalPkceValidation = true;
  return provider;
}

/** Build the OAuth Authorization Server metadata clients use for discovery. */
export function buildOAuthMetadata(config: OAuthConfig): OAuthMetadata {
  return {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    jwks_uri: config.jwksUri,
    revocation_endpoint: config.revocationEndpoint,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    scopes_supported: SUPPORTED_SCOPES,
  };
}

function normaliseScopes(scope: unknown): string[] {
  if (Array.isArray(scope)) return scope.map(String);
  if (typeof scope === 'string') return scope.split(/\s+/).filter(Boolean);
  return [];
}

/**
 * A token verifier that validates BeeL's RS256 JWTs offline against the JWKS,
 * checking the issuer and expiry, and projects the claims into MCP's AuthInfo.
 */
export function createBeelTokenVerifier(config: OAuthConfig): OAuthTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUri));
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, jwks, { issuer: config.issuer }));
      } catch (err) {
        // jose throws generic errors (bad signature, unknown key, expired); map them
        // to InvalidTokenError so the bearer middleware answers 401, not 500.
        throw new InvalidTokenError(err instanceof Error ? err.message : 'Invalid access token');
      }
      const scopes = normaliseScopes(payload.scope);
      const environment = typeof payload.environment === 'string' ? payload.environment : 'PRODUCTION';
      return {
        token,
        clientId: String(payload.sub ?? payload.user_id ?? 'unknown'),
        scopes,
        expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
        extra: { environment, userId: payload.user_id ?? payload.sub },
      };
    },
  };
}

/**
 * Map a validated token to the per-request API credentials. The JWT is forwarded
 * verbatim as the bearer (the BeeL API accepts OAuth JWTs and API keys alike);
 * the environment comes from the token's `environment` claim, not a key prefix.
 */
export function configFromAuth(auth: AuthInfo, config: OAuthConfig): ResolvedConfig {
  const environment = (auth.extra?.environment as string | undefined) ?? 'PRODUCTION';
  const env: KeyEnv = environment === 'SANDBOX' ? 'test' : 'live';
  return {
    apiKey: auth.token,
    env,
    baseUrl: config.apiBaseUrl,
  };
}
