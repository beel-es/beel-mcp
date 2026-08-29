/**
 * Upstream BeeL OAuth — the Worker acts as a full OAuth AS towards MCP clients
 * (via workers-oauth-provider) and as a plain OAuth *client* towards BeeL.
 * This module owns that second leg: authorize URL, PKCE, code exchange, refresh.
 */

import * as Sentry from '@sentry/cloudflare';
import { ContentType, HttpHeader, basicAuthHeader } from '../shared/http.js';
import { BEEL_DEFAULTS, ENV_VAR, HTTP_DEFAULTS, OAUTH_PATH } from '../shared/defaults.js';
import { readEnv, readEnvUrl, type EnvRecord } from '../shared/env.js';
import { WORKER_ENV_VAR, WORKER_PATH, WORKER_TTL } from './constants.js';
import { base64url } from './encoding.js';

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
  /**
   * Whether a rejected client secret may be retried as a public client. Off by
   * default: see `WORKER_ENV_VAR.allowPublicFallback`.
   */
  allowPublicFallback: boolean;
}

/** Path the upstream authorization server redirects back to. */
export const CALLBACK_PATH = WORKER_PATH.callback;

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
    allowPublicFallback: readEnv(env, WORKER_ENV_VAR.allowPublicFallback) === 'true',
  };
}

/** The callback this server registers upstream. Derived from configuration only. */
export function callbackUrl(config: UpstreamConfig): string {
  return `${config.publicUrl}${CALLBACK_PATH}`;
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

/**
 * Stable markers, first thing in the message. An alert is built on these, not on
 * a sentence anyone may rewrite while editing the surrounding prose.
 */
export const OAUTH_MARKER = {
  missingSecret: 'OAUTH_CLIENT_SECRET_MISSING',
  rejectedSecret: 'OAUTH_CLIENT_SECRET_REJECTED',
} as const;

/**
 * Report a degradation to the error tracker as well as to the logs.
 *
 * Explicit rather than scraped from `console.error`, because in this project
 * `console.error` does not mean "this is an error": it means "this goes to
 * stderr", which is where telemetry must go to keep the JSON-RPC channel of the
 * stdio mode clean. Only what is passed here is reported.
 *
 * Reported on every occurrence, with no process-level memory. A Worker isolate
 * is not a process: it is created and discarded unpredictably, so "once per
 * process" makes the number of reports a function of isolate lifetime rather
 * than of how often the condition holds.
 */
function report(message: string): void {
  console.error(message);
  Sentry.captureMessage(message, 'error');
}

/**
 * Without `BEEL_OAUTH_CLIENT_SECRET` the bridge authenticates as a public client
 * and the authorization server issues no refresh token: the session dies with the
 * access token and the user has to walk through consent again.
 *
 * Reported as an error rather than a warning on purpose. It is a permanent
 * degradation that costs users — someone tired of reconnecting simply leaves,
 * without filing anything — so it belongs where errors are looked at.
 */
function reportMissingClientSecret(): void {
  report(
    `${OAUTH_MARKER.missingSecret}: ${ENV_VAR.oauthClientSecret} is not set. The bridge ` +
      'authenticates as a PUBLIC client and the authorization server issues no refresh ' +
      'token, so every session expires with its access token and forces a reconnect. ' +
      `Provision it with \`wrangler secret put ${ENV_VAR.oauthClientSecret}\`.`,
  );
}

/**
 * The secret is configured and the authorization server rejects it. Both causes
 * are ours: the secret does not match the registered one, or it is not reaching
 * the server intact. Either way nobody can connect, and that must be visible
 * rather than absorbed.
 */
function reportRejectedClientSecret(status: number, willRetryAsPublic: boolean): void {
  report(
    `${OAUTH_MARKER.rejectedSecret}: the authorization server answered ${status} ` +
      `invalid_client while ${ENV_VAR.oauthClientSecret} is set. ` +
      (willRetryAsPublic
        ? `Retrying as a PUBLIC client because ${WORKER_ENV_VAR.allowPublicFallback} is on, ` +
          'which costs the refresh token. '
        : 'The exchange fails. ') +
      'Check that the secret matches the one registered for this client.',
  );
}

/**
 * A token-endpoint failure, with the reason separated from the noise.
 *
 * `oauthError` carries the code from the RFC 6749 error body (`invalid_client`,
 * `invalid_grant`, …), which is the only part that tells an operator whether the
 * credential is wrong or the destination is down. The upstream body itself never
 * reaches the message: it may echo request parameters back.
 */
export class TokenEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly oauthError: string | undefined,
    readonly usedClientSecret: boolean,
    detail: string,
  ) {
    super(detail);
    this.name = 'TokenEndpointError';
  }
}

/** The OAuth error code from the body, when the body is the JSON the RFC mandates. */
function oauthErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Authentication for one attempt, as headers plus the body mutations it implies.
 *
 * Confidential clients use client_secret_basic — the secret in the header, never
 * in the body, which is the method BeeL registers for this client and the only
 * one it accepts. A public client sends its `client_id` in the body instead and
 * relies on PKCE (S256) for protection.
 */
function authenticateAttempt(
  config: UpstreamConfig,
  params: URLSearchParams,
  forcePublic: boolean,
): { headers: Record<string, string>; usedClientSecret: boolean } {
  const headers: Record<string, string> = { [HttpHeader.ContentType]: ContentType.Form };
  if (config.clientSecret && !forcePublic) {
    headers[HttpHeader.Authorization] = basicAuthHeader(config.clientId, config.clientSecret);
    return { headers, usedClientSecret: true };
  }
  if (!config.clientSecret) reportMissingClientSecret();
  params.set('client_id', config.clientId);
  return { headers, usedClientSecret: false };
}

/** Shape check on a 200: everything downstream treats these fields as given. */
function parseTokens(text: string, usedClientSecret: boolean): UpstreamTokens {
  const invalid = (detail: string): never => {
    throw new TokenEndpointError(200, undefined, usedClientSecret, `BeeL token endpoint ${detail}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid('returned a body that is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) return invalid('returned a non-object body');
  const body = parsed as Record<string, unknown>;
  if (typeof body.access_token !== 'string' || !body.access_token) {
    return invalid('returned no usable access_token');
  }
  for (const name of ['refresh_token', 'scope'] as const) {
    if (body[name] !== undefined && typeof body[name] !== 'string') {
      return invalid(`returned a non-string ${name}`);
    }
  }
  if (body.expires_in !== undefined && typeof body.expires_in !== 'number') {
    return invalid('returned a non-numeric expires_in');
  }
  // Every member has just been checked one by one; the cast only tells the
  // compiler what those checks established.
  return body as unknown as UpstreamTokens;
}

async function tokenRequest(
  config: UpstreamConfig,
  params: URLSearchParams,
  options: { forcePublic?: boolean } = {},
): Promise<UpstreamTokens> {
  const forcePublic = options.forcePublic ?? false;
  const { headers, usedClientSecret } = authenticateAttempt(config, params, forcePublic);
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers,
    body: params.toString(),
    // No outbound call may outlive the request that started it.
    signal: AbortSignal.timeout(HTTP_DEFAULTS.timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    const oauthError = oauthErrorCode(text);
    // `invalid_client` with a secret configured is always a misconfiguration on
    // this side. Retrying as a public client hides it and silently gives up the
    // refresh token, so it happens only when a deployment asks for it.
    if (usedClientSecret && oauthError === 'invalid_client') {
      reportRejectedClientSecret(response.status, config.allowPublicFallback);
      if (config.allowPublicFallback) return tokenRequest(config, params, { forcePublic: true });
    }
    throw new TokenEndpointError(
      response.status,
      oauthError,
      usedClientSecret,
      `BeeL token endpoint returned ${response.status}${oauthError ? ` (${oauthError})` : ''}`,
    );
  }
  return parseTokens(text, usedClientSecret);
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

export function refreshUpstream(
  config: UpstreamConfig,
  refreshToken: string,
): Promise<UpstreamTokens> {
  return tokenRequest(
    config,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
}

/**
 * Our access token's lifetime, derived from the upstream token's `expires_in`.
 *
 * Called with no argument for the initial grant, where the upstream lifetime is
 * not yet available to us: `completeAuthorization` accepts no per-grant TTL, so
 * the first token necessarily runs on the provider-wide default. From the first
 * refresh onwards the real `expires_in` governs, minus the skew that keeps ours
 * expiring first (see `WORKER_TTL.upstreamSkewSeconds`).
 */
export function workerAccessTokenTTL(expiresIn?: number): number {
  const upstream = expiresIn ?? WORKER_TTL.upstreamAssumedSeconds;
  return Math.max(WORKER_TTL.minimumAccessTokenSeconds, upstream - WORKER_TTL.upstreamSkewSeconds);
}
