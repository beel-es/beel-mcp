import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import type { OAuthClientInformationFull, OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
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
/**
 * The pre-registered BeeL client, as MCP client information. Public when no
 * client secret is configured (PKCE-only — the cleanest "paste URL and log in"
 * UX); confidential (client_secret_basic) when BEEL_OAUTH_CLIENT_SECRET is set.
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

export function createProxyProvider(config: OAuthConfig): ProxyOAuthServerProvider {
  const verifier = createBeelTokenVerifier(config);
  // Diagnostic fetch: log upstream OAuth calls (token/revoke) and their responses so
  // a failing token exchange at BeeL is visible in the logs.
  const loggingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input as Parameters<typeof fetch>[0], init);
    const url = String(input);
    if (url.includes('/oauth2/')) {
      const body = res.ok ? '' : await res.clone().text().catch(() => '');
      process.stderr.write(
        `[beel-mcp] upstream ${init?.method ?? 'GET'} ${url} -> ${res.status}${body ? ' ' + body.slice(0, 400) : ''}\n`,
      );
    }
    return res;
  };
  const provider = new ProxyOAuthServerProvider({
    endpoints: {
      authorizationUrl: `${config.issuer}/oauth2/authorize`,
      tokenUrl: `${config.issuer}/oauth2/token`,
      revocationUrl: `${config.issuer}/oauth2/revoke`,
    },
    verifyAccessToken: (token) => verifier.verifyAccessToken(token),
    getClient: async () => clientInformation(config),
    fetch: loggingFetch,
  });
  // BeeL holds the PKCE challenge and validates it at the token endpoint.
  provider.skipLocalPkceValidation = true;

  // DCR shim: BeeL has no dynamic registration, so /register returns our fixed
  // pre-registered client. This lets MCP clients (Claude) self-register, so the
  // user just pastes the URL and logs in — no client_id/secret to enter.
  Object.defineProperty(provider, 'clientsStore', {
    configurable: true,
    get() {
      return {
        getClient: async () => clientInformation(config),
        registerClient: async (client: { redirect_uris?: string[] }) =>
          clientInformation(config, client.redirect_uris),
      };
    },
  });

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
        // Diagnostic: log why a token was rejected and what it actually carried,
        // so issuer/kid/exp mismatches are obvious in the server logs.
        try {
          const header = decodeProtectedHeader(token);
          const claims = decodeJwt(token);
          process.stderr.write(
            `[beel-mcp] token verify FAILED: ${err instanceof Error ? err.message : String(err)} | ` +
              `token.iss=${claims.iss} token.kid=${header.kid} token.aud=${JSON.stringify(claims.aud)} ` +
              `token.exp=${claims.exp} | expected.iss=${config.issuer} jwks=${config.jwksUri}\n`,
          );
        } catch {
          /* token not decodable */
        }
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
