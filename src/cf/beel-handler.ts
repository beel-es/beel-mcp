import type { Env } from './env.js';
import { Hono, type Context } from 'hono';
import { decodeJwt } from 'jose';
import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import {
  TokenEndpointError,
  callbackUrl,
  exchangeCode,
  pkcePair,
  randomToken,
  upstreamConfig,
  type UpstreamConfig,
  type UpstreamTokens,
} from './upstream.js';
import {
  IDENTITY_ASSERTION,
  createIdentityAssertion,
  parseKnownClients,
  resolveClientIdentity,
} from './client-identity.js';
import { WORKER_PATH, WORKER_TTL } from './constants.js';
import { loadSpec } from '../spec/load.js';
import { buildManifest } from '../spec/manifest.js';
import {
  fallbackGrantableScopes,
  intersectScopes,
  keyEnvFromScopes,
  requiredScopes,
} from '../policy/scopes.js';
import {
  CACHE_TTL_MS,
  ENV_VAR,
  HTTP_DEFAULTS,
  OAUTH_PATH,
  SERVER_NAME,
} from '../shared/defaults.js';
import { readEnv } from '../shared/env.js';
import { PDF_PROXY_PATH } from '../mcpapp/contract.js';
import { pdfProxyHandler } from './pdf-proxy.js';

/**
 * Unprotected routes of the Worker: the /authorize + /callback pair that bridges
 * the MCP client's OAuth request to BeeL's upstream authorization server, plus a
 * health check. No consent screen: the connector UX is "paste URL and log in" —
 * BeeL's own login/consent page is the consent.
 *
 * CSRF/state: the MCP client's parsed AuthRequest and our upstream PKCE verifier
 * are stored in KV under a single-use random state token.
 */

interface PendingAuth {
  oauthReqInfo: AuthRequest;
  codeVerifier: string;
}

/** KV key of a pending authorization. One entry per issued state token. */
const pendingAuthKey = (state: string): string => `pending-auth:${state}`;

/**
 * Grantable scopes, per issuer.
 *
 * Keyed rather than held in a single slot because the issuer is configuration: a
 * deployment pointed at a different authorization server has a different scope
 * catalogue, and an unkeyed cache would serve it whichever one was asked first.
 */
const scopesCache = new Map<string, { scopes: string[]; fetchedAt: number }>();

/**
 * Scopes the consent screen should request by default = the intersection of
 *   (a) what the exposed tools actually need — least privilege, never asks for a
 *       scope no tool uses; derived from the tool manifest, and
 *   (b) what the backend lets this client consent to — `scopes_supported` in its
 *       AS discovery; excludes privileged scopes the authorize endpoint would
 *       reject with invalid_scope.
 * Both sides are single sources of truth (the spec's per-op security, and the
 * backend catalog); the Worker hardcodes neither. Fallback only for old backends.
 */
async function defaultScopes(issuer: string): Promise<string[]> {
  const cached = scopesCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS.scopeDiscovery) return cached.scopes;

  const needed = requiredScopes(buildManifest(loadSpec()));
  const grantable = await grantableScopes(issuer);
  if (!grantable) {
    // Discovery unavailable: the request proceeds with the static subset, so tools
    // outside it will answer 403 until discovery recovers. Logged so that state is
    // visible instead of looking like a backend permission problem.
    console.error(JSON.stringify({ evt: 'SCOPE_DISCOVERY_FALLBACK', issuer }));
  }
  const scopes = intersectScopes(needed, grantable ?? fallbackGrantableScopes());
  // Cached only when discovery actually answered, so a transient outage cannot
  // pin a degraded result for the full TTL.
  if (grantable) scopesCache.set(issuer, { scopes, fetchedAt: Date.now() });
  return scopes;
}

/** `scopes_supported` from the AS metadata, or `null` when discovery did not answer. */
async function grantableScopes(issuer: string): Promise<string[] | null> {
  try {
    // The metadata changes on a backend deploy, not per connection: serving it
    // from the edge keeps a login from waiting on a second round trip. `cf` is
    // a Workers extension of RequestInit, typed locally so the Node build of
    // this module (used by the test runner) needs no ambient Workers types.
    const init: RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } } = {
      signal: AbortSignal.timeout(HTTP_DEFAULTS.timeoutMs),
      cf: { cacheTtl: WORKER_TTL.discoveryCacheSeconds, cacheEverything: true },
    };
    const response = await fetch(`${issuer}${OAUTH_PATH.discovery}`, init);
    if (!response.ok) return null;
    const metadata = (await response.json()) as { scopes_supported?: unknown };
    const supported = metadata.scopes_supported;
    if (!Array.isArray(supported) || supported.length === 0) return null;
    return supported.filter((scope): scope is string => typeof scope === 'string');
  } catch {
    return null;
  }
}

/**
 * Dedicated HMAC secret for the identity assertion. It has no fallback: signing
 * with the OAuth client secret instead would spend one credential on two jobs,
 * and rotating either would silently break the other. Absent, no assertion is
 * minted and every client renders as unverified — unsigned means unverified,
 * which is the safe degradation.
 */
function identityHmacSecret(env: Env): string | undefined {
  return readEnv(env, ENV_VAR.identityHmacKey);
}

const app = new Hono<{ Bindings: Env }>();

app.get(WORKER_PATH.health, (c) =>
  c.json({ status: 'ok', name: SERVER_NAME, runtime: 'cloudflare' }),
);

// The PDF relay for the viewer: inline + CORS, restricted to an allowlist.
app.get(PDF_PROXY_PATH, pdfProxyHandler);

/**
 * Build the upstream authorization URL for a pending request.
 *
 * Split out from the route so the URL is a value produced from configuration and
 * the parsed request, rather than something assembled in the middle of a handler
 * that is also writing to KV and minting a signature.
 */
function buildUpstreamAuthorizeUrl(
  upstream: UpstreamConfig,
  params: {
    scopes: string[];
    state: string;
    codeChallenge: string;
    redirectUri: string;
    identityAssertion?: string;
  },
): URL {
  const url = new URL(upstream.authorizeUrl);
  const query: Record<string, string> = {
    response_type: 'code',
    client_id: upstream.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scopes.join(' '),
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  };
  if (params.identityAssertion) {
    query[IDENTITY_ASSERTION.PARAM] = params.identityAssertion;
  }
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

/**
 * The end client's identity, signed for the consent screen.
 *
 * The display claims are what the user sees: a self-asserted name from DCR, a
 * provable origin, and whether that origin is a well-known MCP host. The binding
 * claims are what the backend checks — this server's own client_id and callback —
 * so a valid assertion cannot be transplanted onto a different request.
 *
 * Returns `undefined` when no signing key is provisioned.
 */
async function signClientIdentity(
  c: Context<{ Bindings: Env }>,
  upstream: UpstreamConfig,
  request: AuthRequest,
  redirectUri: string,
): Promise<string | undefined> {
  const hmacSecret = identityHmacSecret(c.env);
  if (!hmacSecret) return undefined;

  const identity = await resolveClientIdentity(
    c.env.OAUTH_PROVIDER,
    request.clientId,
    // The callback THIS request will return to — not merely one the client
    // registered. See resolveClientIdentity for why the difference matters.
    request.redirectUri,
    parseKnownClients(readEnv(c.env, ENV_VAR.verifiedClients)),
  );
  return createIdentityAssertion(identity, hmacSecret, upstream.issuer, {
    issuer: upstream.publicUrl,
    clientId: upstream.clientId,
    redirectUri,
  });
}

app.get(WORKER_PATH.authorize, async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) return c.text('Invalid authorization request', 400);

  const upstream = upstreamConfig(c.env);
  const redirectUri = callbackUrl(upstream);

  // Single-use state, holding the client's parsed request and our PKCE verifier
  // until the callback redeems it. The TTL has to cover a full interactive login.
  const { verifier, challenge } = await pkcePair();
  const state = randomToken();
  const pending: PendingAuth = { oauthReqInfo, codeVerifier: verifier };
  await c.env.OAUTH_KV.put(pendingAuthKey(state), JSON.stringify(pending), {
    expirationTtl: WORKER_TTL.pendingAuthSeconds,
  });

  const scopes = oauthReqInfo.scope.length
    ? oauthReqInfo.scope
    : await defaultScopes(upstream.issuer);

  const url = buildUpstreamAuthorizeUrl(upstream, {
    scopes,
    state,
    codeChallenge: challenge,
    redirectUri,
    identityAssertion: await signClientIdentity(c, upstream, oauthReqInfo, redirectUri),
  });

  return c.redirect(url.href, 302);
});

/**
 * Error codes an authorization server may return on this redirect (RFC 6749
 * §4.1.2.1). Anything else is echoed as `unrecognized_error`: the value arrives
 * in a query string anyone can craft, so reflecting it verbatim would let a
 * caller choose what this page says.
 */
const AUTHORIZATION_ERROR_CODES = new Set([
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
]);

function safeErrorCode(raw: string): string {
  return AUTHORIZATION_ERROR_CODES.has(raw) ? raw : 'unrecognized_error';
}

/** The stored pending authorization, or `null` when the value is not one. */
function parsePending(raw: string): PendingAuth | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PendingAuth>;
    if (!parsed || typeof parsed.codeVerifier !== 'string' || !parsed.oauthReqInfo) return null;
    return { oauthReqInfo: parsed.oauthReqInfo, codeVerifier: parsed.codeVerifier };
  } catch {
    return null;
  }
}

/**
 * The scopes the session actually holds, and where that answer came from.
 *
 * The token response is authoritative when it states a `scope`. When it does not,
 * the granted set is still in the access token itself, and that is the next place
 * to look — falling straight through to what was REQUESTED would record scopes
 * the user may have declined, which decides whether the session is flagged as a
 * test one and therefore which environment every later call runs against.
 */
function resolveScopes(
  tokens: UpstreamTokens,
  requested: string[],
): { scopes: string[]; source: 'token' | 'jwt' | 'request' } {
  if (tokens.scope) return { scopes: splitScopes(tokens.scope), source: 'token' };
  const fromJwt = scopeClaim(tokens.access_token);
  if (fromJwt.length) return { scopes: fromJwt, source: 'jwt' };
  return { scopes: requested, source: 'request' };
}

function splitScopes(value: string): string[] {
  return value.split(' ').filter(Boolean);
}

/** The `scope` claim of the access token, as a string or an array of strings. */
function scopeClaim(token: string): string[] {
  try {
    const claim = decodeJwt(token).scope;
    if (typeof claim === 'string') return splitScopes(claim);
    if (Array.isArray(claim)) return claim.filter((s): s is string => typeof s === 'string');
    return [];
  } catch {
    return [];
  }
}

/**
 * One line per connection, naming the environment the granted token belongs to.
 * Scopes are not secret — they travel in the consent URL — and nothing else in
 * the token does; the bearer never leaves the Worker.
 */
function logCallback(scopes: string[], source: string): void {
  console.error(
    JSON.stringify({
      evt: 'oauth_callback',
      env: keyEnvFromScopes(scopes),
      scope_source: source,
      scopes,
    }),
  );
}

app.get(WORKER_PATH.callback, async (c) => {
  const state = c.req.query('state');
  if (!state) return c.text('Missing state', 400);

  const key = pendingAuthKey(state);
  const raw = await c.env.OAUTH_KV.get(key);
  if (!raw) return c.text('Unknown or expired authorization state. Retry the connection.', 400);
  // Burned before the code is spent, so this link redeems exactly once. A second
  // hit — a refresh, a prefetch, a click on history — would otherwise reach the
  // token endpoint with a code the server has already consumed and surface its
  // rejection as an unexplained failure.
  await c.env.OAUTH_KV.delete(key);

  const pending = parsePending(raw);
  if (!pending) return c.text('Malformed authorization state. Retry the connection.', 400);

  const upstreamError = c.req.query('error');
  const code = c.req.query('code');
  if (upstreamError || !code) {
    const reason = upstreamError ? safeErrorCode(upstreamError) : 'missing_code';
    return c.text(`BeeL authorization failed: ${reason}`, 400);
  }

  return completeCallback(c, pending, code);
});

async function completeCallback(
  c: Context<{ Bindings: Env }>,
  pending: PendingAuth,
  code: string,
): Promise<Response> {
  const upstream = upstreamConfig(c.env);
  let tokens: UpstreamTokens;
  try {
    // The same value the authorize step sent: OAuth requires the redirect_uri in
    // the token exchange to match it exactly, so both must come from the one
    // place that decides this server's public identity.
    tokens = await exchangeCode(upstream, code, callbackUrl(upstream), pending.codeVerifier);
  } catch (error) {
    if (error instanceof TokenEndpointError) {
      return c.text(
        'This sign-in link has already been used or has expired. ' +
          'Start the connection again from your MCP client.',
        400,
      );
    }
    throw error;
  }

  const { scopes, source } = resolveScopes(tokens, pending.oauthReqInfo.scope);
  logCallback(scopes, source);

  // The grant is keyed by the person behind it. Without a subject every session
  // would collapse onto one identity, so an unreadable token fails the callback
  // rather than inventing one.
  const userId = subjectFromJwt(tokens.access_token);
  if (!userId) return c.text('BeeL returned a token with no identity in it.', 502);

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.oauthReqInfo,
    userId,
    metadata: { connectedAt: new Date().toISOString() },
    scope: scopes,
    props: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scopes,
    },
  });
  return finalRedirect(redirectTo);
}

/** Spanish is the product language of the consent flow this page sits inside. */
const INTERSTITIAL_COPY = {
  lang: 'es',
  title: 'Conectando…',
  manualLink: 'Continuar',
} as const;

/**
 * The final hop to the MCP client's callback CANNOT be a 302. It would sit inside
 * the redirect chain of the consent POST, which starts on BeeL's domain, and CSP
 * `form-action` governs that WHOLE chain — blocking any host outside it. So the
 * submit ends here with a 200 and the jump happens through `location.replace`: a
 * fresh navigation, which form-action does not govern. `<noscript>` falls back to
 * a manual link.
 */
function finalRedirect(target: string): Response {
  // Only a web destination is navigable from a page. Anything else — `javascript:`
  // above all — would execute here instead of taking the user somewhere.
  let scheme: string;
  try {
    scheme = new URL(target).protocol;
  } catch {
    return new Response('The client supplied an unusable redirect target.', { status: 502 });
  }
  if (scheme !== 'https:' && scheme !== 'http:') {
    return new Response('The client supplied an unusable redirect target.', { status: 502 });
  }

  // JSON.stringify does not escape "<", so a target containing "</script>" would
  // break out of the script element. The URL serializer should already
  // percent-encode it; escaping here removes the dependency on that.
  const jsUrl = JSON.stringify(target).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const hrefAttr = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const body =
    `<!doctype html><html lang="${INTERSTITIAL_COPY.lang}"><head><meta charset="utf-8">` +
    `<meta name="robots" content="noindex"><title>${INTERSTITIAL_COPY.title}</title></head>` +
    `<body><script>location.replace(${jsUrl})</script>` +
    `<noscript><a href="${hrefAttr}">${INTERSTITIAL_COPY.manualLink}</a></noscript></body></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The destination carries an authorization code in its query; do not hand
      // this page's URL to it.
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/** The subject of the BeeL access token (a JWT), which keys the grant. */
function subjectFromJwt(token: string): string | null {
  try {
    const claims = decodeJwt(token);
    const sub = claims.user_id ?? claims.sub;
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null;
  }
}

export const BeelAuthHandler = app;
