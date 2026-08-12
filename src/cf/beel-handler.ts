import { Hono } from 'hono';
import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import { exchangeCode, pkcePair, randomToken, upstreamConfig } from './upstream.js';
import { IDENTITY_ASSERTION, createIdentityAssertion, parseKnownClients, resolveClientIdentity } from './client-identity.js';
import { loadSpec } from '../spec/load.js';
import { buildManifest } from '../spec/manifest.js';
import { requiredScopes } from '../policy/tool-policy.js';

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

/**
 * Fallback scopes requested upstream when the MCP client asks for none (Claude
 * sends no scope parameter) and the backend discovery doesn't advertise its
 * catalog. Must be a subset of the beel-mcp client registration (Spring rejects
 * unknown scopes with invalid_scope). `sandbox` is NEVER defaulted: connecting
 * means working with your real (live) BeeL data unless explicitly requested.
 */
const FALLBACK_SCOPES = [
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
  'nif:validate',
  'companies:read',
  'companies:write',
  // NOT here: companies:list — the fallback must stay a subset of what the OLDEST
  // deployed backend registers, or Spring fails the whole authorize with
  // invalid_scope. New scopes arrive via scopes_supported in the discovery.
];

/** Scopes never granted by default even if the catalog advertises them. */
const NON_DEFAULT_SCOPES = new Set(['sandbox']);

const SCOPES_CACHE_TTL_MS = 15 * 60 * 1000;
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
  let grantable: string[] = FALLBACK_SCOPES;
  try {
    const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
    if (response.ok) {
      const metadata = (await response.json()) as { scopes_supported?: string[] };
      if (metadata.scopes_supported?.length) grantable = metadata.scopes_supported;
    }
  } catch {
    /* keep the static fallback */
  }
  const grantableSet = new Set(grantable.filter((s) => !NON_DEFAULT_SCOPES.has(s)));
  const scopes = needed.filter((s) => grantableSet.has(s));
  const result = scopes.length ? scopes : [...grantableSet];
  scopesCache = { scopes: result, fetchedAt: Date.now() };
  return result;
}

/**
 * Dedicated HMAC secret for the identity assertion. Separate from the OAuth
 * client secret (key separation) and independently rotatable. Falls back to the
 * client secret only if the dedicated key isn't provisioned yet.
 */
function identityHmacSecret(env: Env): string | undefined {
  return env.MCP_IDENTITY_HMAC_KEY || env.BEEL_OAUTH_CLIENT_SECRET || undefined;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ status: 'ok', name: 'beel-mcp', runtime: 'cloudflare' }));

app.get('/authorize', async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) return c.text('Invalid authorization request', 400);

  const upstream = upstreamConfig(c.env);
  const { verifier, challenge } = await pkcePair();
  const state = randomToken();
  const pending: PendingAuth = { oauthReqInfo, codeVerifier: verifier };
  await c.env.OAUTH_KV.put(`pending-auth:${state}`, JSON.stringify(pending), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const url = new URL(upstream.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', upstream.clientId);
  url.searchParams.set('redirect_uri', new URL('/callback', c.req.url).href);
  const requestedScopes = oauthReqInfo.scope.length
    ? oauthReqInfo.scope
    : await defaultScopes(upstream.issuer);
  url.searchParams.set('scope', requestedScopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // End-client identity for the consent screen: name is self-asserted (DCR),
  // origin is provable, verified only against the well-known-hosts allowlist.
  // Signed with a DEDICATED HMAC key (not the OAuth client secret) and bound to
  // this client_id + redirect_uri so it can't be transplanted onto another request.
  const identity = await resolveClientIdentity(
    c.env.OAUTH_PROVIDER,
    oauthReqInfo.clientId,
    parseKnownClients(c.env.MCP_VERIFIED_CLIENTS),
  );
  const hmacSecret = identityHmacSecret(c.env);
  if (hmacSecret) {
    url.searchParams.set(
      IDENTITY_ASSERTION.PARAM,
      await createIdentityAssertion(identity, hmacSecret, upstream.issuer, {
        clientId: oauthReqInfo.clientId,
        redirectUri: identity.redirectUri,
      }),
    );
  }
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
  const tokens = await exchangeCode(
    upstream,
    code,
    new URL('/callback', c.req.url).href,
    codeVerifier,
  );

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
  return c.redirect(redirectTo, 302);
});

/** Best-effort subject from the BeeL access token (JWT), for grant bookkeeping. */
function subjectFromJwt(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    const sub = claims.user_id ?? claims.sub;
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null;
  }
}

export const BeelAuthHandler = app;
