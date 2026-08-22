/**
 * Upstream BeeL OAuth — the Worker acts as a full OAuth AS towards MCP clients
 * (via workers-oauth-provider) and as a plain OAuth *client* towards BeeL.
 * This module owns that second leg: authorize URL, PKCE, code exchange, refresh.
 */

import { ContentType, HttpHeader, basicAuthHeader } from '../shared/http.js';
import { BEEL_DEFAULTS, ENV_VAR, OAUTH_PATH } from '../shared/defaults.js';
import { readEnv, readEnvUrl, type EnvRecord } from '../shared/env.js';

export interface UpstreamConfig {
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
  /**
   * This server's own public origin, from configuration — never derived from the
   * incoming request.
   *
   * It is an identity, not a routing detail: the upstream authorization server
   * validates the redirect_uri built from it against what it has registered, and
   * the client-identity assertion is signed with it as issuer and bound to that
   * same redirect_uri. Taking it from the request URL would make all three vary
   * with whichever hostname the Worker happened to be reached through.
   */
  publicUrl: string;
}

/** Path the upstream authorization server redirects back to. */
export const CALLBACK_PATH = '/callback';

export interface UpstreamTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export function upstreamConfig(env: EnvRecord): UpstreamConfig {
  const issuer = readEnvUrl(env, ENV_VAR.oauthIssuer, BEEL_DEFAULTS.oauthIssuer);
  return {
    issuer,
    authorizeUrl: readEnv(env, ENV_VAR.oauthAuthorizeUrl) ?? `${issuer}${OAUTH_PATH.authorize}`,
    tokenUrl: readEnv(env, ENV_VAR.oauthTokenUrl) ?? `${issuer}${OAUTH_PATH.token}`,
    clientId: readEnv(env, ENV_VAR.oauthClientId) ?? BEEL_DEFAULTS.oauthClientId,
    clientSecret: readEnv(env, ENV_VAR.oauthClientSecret) ?? '',
    apiBaseUrl: readEnvUrl(env, ENV_VAR.apiBaseUrl, BEEL_DEFAULTS.apiBaseUrl),
    publicUrl: readEnvUrl(env, ENV_VAR.publicUrl, BEEL_DEFAULTS.publicUrl),
  };
}

/** The callback this server registers upstream. Derived from configuration only. */
export function callbackUrl(config: UpstreamConfig): string {
  return `${config.publicUrl}${CALLBACK_PATH}`;
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
  const headers: Record<string, string> = { [HttpHeader.ContentType]: ContentType.Form };
  if (config.clientSecret) {
    // Confidential client: client_secret_basic (secret in the header, not the
    // body) — the method BeeL registers for this client. Sending it in the body
    // (client_secret_post) is rejected with 401. With Basic, the client_id
    // travels ONLY in the header.
    headers[HttpHeader.Authorization] = basicAuthHeader(config.clientId, config.clientSecret);
  } else {
    // Public client (no secret): PKCE (S256) is the protection.
    params.set('client_id', config.clientId);
  }
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers,
    body: params.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    // The body may echo request parameters; surface the status and a short,
    // bounded excerpt only — never the full upstream response.
    throw new Error(`BeeL token endpoint returned ${response.status}: ${text.slice(0, 200)}`);
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
