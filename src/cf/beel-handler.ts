import { Hono, type Context } from 'hono';
import { decodeJwt } from 'jose';
import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import {
  callbackUrl,
  exchangeCode,
  pkcePair,
  randomToken,
  upstreamConfig,
  type UpstreamConfig,
} from './upstream.js';
import { IDENTITY_ASSERTION, createIdentityAssertion, parseKnownClients, resolveClientIdentity } from './client-identity.js';
import { loadSpec } from '../spec/load.js';
import { buildManifest } from '../spec/manifest.js';
import { FALLBACK_GRANTABLE_SCOPES, intersectScopes, requiredScopes } from '../policy/scopes.js';
import { CACHE_TTL_MS, ENV_VAR, OAUTH_PATH, SERVER_NAME } from '../shared/defaults.js';
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
 * are stored in KV under a single-use random state token (10 min TTL).
 */

interface PendingAuth {
  oauthReqInfo: AuthRequest;
  codeVerifier: string;
}

// Generous TTL: a fresh login (password, 2FA, password-manager fumbling) happens
// between /authorize and /callback. 10 minutes proved too short in practice.
const STATE_TTL_SECONDS = 1800;

const SCOPES_CACHE_TTL_MS = CACHE_TTL_MS.scopeDiscovery;
let scopesCache: { scopes: string[]; fetchedAt: number } | null = null;

/**
 * Scopes the consent screen should request by default = the intersection of
 *   (a) what the exposed tools actually need — least privilege, never asks for a
 *       scope no tool uses; derived from the tool manifest, and
 *   (b) what the backend lets this client consent to — `scopes_supported` in its
 *       AS discovery, derived from ApiKeyScope; excludes privileged scopes the
 *       authorize endpoint would reject with invalid_scope.
 * Both sides are single sources of truth (the spec's per-op security, and the
 * backend catalog); the Worker hardcodes neither. Fallback only for old backends.
 */
async function defaultScopes(issuer: string): Promise<string[]> {
  if (scopesCache && Date.now() - scopesCache.fetchedAt < SCOPES_CACHE_TTL_MS) {
    return scopesCache.scopes;
  }
  const needed = requiredScopes(buildManifest(loadSpec()));
  let grantable: readonly string[] = FALLBACK_GRANTABLE_SCOPES;
  try {
    const response = await fetch(`${issuer}${OAUTH_PATH.discovery}`);
    if (response.ok) {
      const metadata = (await response.json()) as { scopes_supported?: string[] };
      if (metadata.scopes_supported?.length) grantable = metadata.scopes_supported;
    }
  } catch {
    /* keep the static fallback */
  }
  const scopes = intersectScopes(needed, grantable);
  // Cache only when discovery actually contributed (grantable != fallback), so a
  // transient discovery outage doesn't pin a degraded result for the full TTL.
  if (grantable !== FALLBACK_GRANTABLE_SCOPES) scopesCache = { scopes, fetchedAt: Date.now() };
  return scopes;
}

/**
 * Dedicated HMAC secret for the identity assertion. Separate from the OAuth
 * client secret (key separation) and independently rotatable. Falls back to the
 * client secret only if the dedicated key isn't provisioned yet.
 */
function identityHmacSecret(env: Env): string | undefined {
  return (
    readEnv(env, ENV_VAR.identityHmacKey) ?? readEnv(env, ENV_VAR.oauthClientSecret)
  );
}

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ status: 'ok', name: SERVER_NAME, runtime: 'cloudflare' }));

// The PDF relay for the viewer: inline + CORS, restricted to an allowlist.
app.get(PDF_PROXY_PATH, pdfProxyHandler);

/**
 * Build the upstream authorization URL for a pending request.
 *
 * Split out from the route so the URL is a value produced from configuration and
 * the parsed request, rather than something assembled in the middle of a handler
 * that is also writing to KV and minting a signature.
 */
async function buildUpstreamAuthorizeUrl(
  upstream: UpstreamConfig,
  params: {
    scopes: string[];
    state: string;
    codeChallenge: string;
    redirectUri: string;
    identityAssertion?: string;
  },
): Promise<URL> {
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
 * Returns `undefined` when no signing key is provisioned: the flow proceeds and
 * every client simply renders as unverified, which is the safe degradation.
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

app.get('/authorize', async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) return c.text('Invalid authorization request', 400);

  const upstream = upstreamConfig(c.env);
  const redirectUri = callbackUrl(upstream);

  // Single-use state, holding the client's parsed request and our PKCE verifier
  // until the callback redeems it.
  const { verifier, challenge } = await pkcePair();
  const state = randomToken();
  const pending: PendingAuth = { oauthReqInfo, codeVerifier: verifier };
  await c.env.OAUTH_KV.put(`pending-auth:${state}`, JSON.stringify(pending), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const scopes = oauthReqInfo.scope.length
    ? oauthReqInfo.scope
    : await defaultScopes(upstream.issuer);

  const url = await buildUpstreamAuthorizeUrl(upstream, {
    scopes,
    state,
    codeChallenge: challenge,
    redirectUri,
    identityAssertion: await signClientIdentity(c, upstream, oauthReqInfo, redirectUri),
  });

  return c.redirect(url.href, 302);
});

app.get('/callback', async (c) => {
  const state = c.req.query('state');
  const code = c.req.query('code');
  const upstreamError = c.req.query('error');
  if (!state) return c.text('Missing state', 400);

  const key = `pending-auth:${state}`;
  const raw = await c.env.OAUTH_KV.get(key);
  if (!raw) return c.text('Unknown or expired authorization state. Retry the connection.', 400);

  const { oauthReqInfo, codeVerifier } = JSON.parse(raw) as PendingAuth;
  if (upstreamError || !code) {
    return c.text(`BeeL authorization failed: ${upstreamError ?? 'missing code'}`, 400);
  }

  // Note: the pending state is deleted only after a successful completeAuthorization.
  // Replay is already prevented upstream (BeeL redeems each code exactly once), and a
  // refresh/prefetch of this URL mid-login must not burn the user's only attempt.
  const upstream = upstreamConfig(c.env);
  // The same value the authorize step sent: OAuth requires the redirect_uri in
  // the token exchange to match it exactly, so both must come from the one place
  // that decides this server's public identity.
  const tokens = await exchangeCode(upstream, code, callbackUrl(upstream), codeVerifier);

  const scopes = (tokens.scope ?? oauthReqInfo.scope.join(' ')).split(' ').filter(Boolean);
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: subjectFromJwt(tokens.access_token) ?? upstream.clientId,
    metadata: { connectedAt: new Date().toISOString() },
    scope: scopes,
    props: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scopes,
    },
  });
  await c.env.OAUTH_KV.delete(key);
  // The final hop to the MCP client's callback CANNOT be a 302. It would sit
  // inside the redirect chain of the consent POST, which starts on BeeL's domain,
  // and CSP `form-action` governs that WHOLE chain — blocking any host outside
  // it. So we serve an interstitial from our own domain (not under that CSP) that
  // navigates afresh from JavaScript: the form's chain ends on BeeL's domain and
  // the cross-origin jump falls outside form-action. Works for every client
  // without anyone having to touch the CSP.
  return finalRedirect(redirectTo);
});

/**
 * Breaks the form-action chain: the submit ends here with a 200, and the jump to
 * the real destination happens through `location.replace` — a fresh navigation,
 * which form-action does not govern. `<noscript>` falls back to a manual link.
 */
function finalRedirect(target: string): Response {
  // JSON.stringify does not escape "<", so a target containing "</script>"
  // would break out of the script element. The URL serializer should already
  // percent-encode it; escaping here removes the dependency on that.
  const jsUrl = JSON.stringify(target).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const hrefAttr = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const body = `<!doctype html><html lang="es"><head><meta charset="utf-8">`
    + `<meta name="robots" content="noindex"><title>Conectando…</title></head>`
    + `<body><script>location.replace(${jsUrl})</script>`
    + `<noscript><a href="${hrefAttr}">Continuar</a></noscript></body></html>`;
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

/** Best-effort subject from the BeeL access token (JWT), for grant bookkeeping. */
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
