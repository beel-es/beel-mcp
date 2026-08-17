/**
 * Upstream BeeL OAuth — the Worker acts as a full OAuth AS towards MCP clients
 * (via workers-oauth-provider) and as a plain OAuth *client* towards BeeL.
 * This module owns that second leg: authorize URL, PKCE, code exchange, refresh.
 */

export interface UpstreamConfig {
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
}

export interface UpstreamTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export function upstreamConfig(env: Env): UpstreamConfig {
  const issuer = (env.BEEL_OAUTH_ISSUER ?? 'https://app.beel.es/api').replace(/\/$/, '');
  return {
    issuer,
    authorizeUrl: `${issuer}/oauth2/authorize`,
    tokenUrl: `${issuer}/oauth2/token`,
    clientId: env.BEEL_OAUTH_CLIENT_ID ?? 'beel-mcp',
    clientSecret: env.BEEL_OAUTH_CLIENT_SECRET ?? '',
    apiBaseUrl: env.BEEL_BASE_URL ?? 'https://app.beel.es/api',
  };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE pair for the upstream leg (BeeL requires S256 for public clients). */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

async function tokenRequest(config: UpstreamConfig, params: URLSearchParams): Promise<UpstreamTokens> {
  params.set('client_id', config.clientId);
  if (config.clientSecret) params.set('client_secret', config.clientSecret);
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`BeeL token endpoint ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as UpstreamTokens;
}

export function exchangeCode(
  config: UpstreamConfig,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<UpstreamTokens> {
  return tokenRequest(
    config,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  );
}

export function refreshUpstream(config: UpstreamConfig, refreshToken: string): Promise<UpstreamTokens> {
  return tokenRequest(
    config,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
}
