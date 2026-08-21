import { SignJWT } from 'jose';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { BEEL_DEFAULTS } from '../shared/defaults.js';

/**
 * Identity of the END client (Claude, Cursor, …) as far as it can be known.
 *
 * DCR client_name is SELF-ASSERTED — anyone can register as "Claude". The only
 * provable fact is the redirect_uri host: the authorization code is unusable
 * unless it returns there. Verification = the callback matches a curated
 * allowlist of well-known MCP hosts; everything else surfaces as unverified.
 */

export interface ClientIdentity {
  /** Self-asserted display name from DCR (may be absent). */
  label?: string;
  /** Host of the client's registered redirect_uri (provable). */
  origin?: string;
  /** True when the callback matches a well-known MCP host. */
  verified: boolean;
  /** The client's registered redirect_uri, to bind the assertion to this request. */
  redirectUri?: string;
}

/**
 * Callback-URL prefixes of well-known MCP hosts → canonical display name.
 *
 * ONLY web `https://` callbacks on a vendor-controlled domain belong here: those
 * are the only redirect_uris an impostor cannot claim. Loopback callbacks
 * (`http://localhost:PORT/...`, used by every CLI/editor — Claude Code, Codex,
 * Gemini CLI, Cursor desktop, Zed, Windsurf, Goose, OpenCode…) and custom
 * schemes (`cursor://`) are NEVER listed: any local app can bind a loopback port
 * or register a scheme, so they can't earn the verified badge. Those clients still
 * connect — they simply render as "not verified · <host>".
 * Post-CIMD (MCP spec 2025-11), identity can key off the client_id metadata origin
 * instead of this list; keep the shape ready for that dimension.
 */
export interface KnownClient {
  prefix: string;
  name: string;
}

/**
 * Built-in fallback. The live list is configurable via the `MCP_VERIFIED_CLIENTS`
 * env var (a JSON array of {prefix,name}); editing it in the Cloudflare dashboard
 * updates the allowlist without a code redeploy. Whatever the source, every prefix
 * is re-validated (https, non-loopback) before it can grant a badge — a bad env
 * entry can never lower the bar.
 */
export const DEFAULT_KNOWN_CLIENTS: KnownClient[] = [
  { prefix: 'https://claude.ai/api/mcp/auth_callback', name: 'Claude' },
  { prefix: 'https://claude.com/api/mcp/auth_callback', name: 'Claude' },
  { prefix: 'https://chatgpt.com/connector_platform_oauth_redirect', name: 'ChatGPT' },
  { prefix: 'https://www.cursor.com/agents/mcp/oauth/callback', name: 'Cursor' },
  { prefix: 'https://vscode.dev/redirect', name: 'VS Code (GitHub Copilot)' },
  { prefix: 'https://insiders.vscode.dev/redirect', name: 'VS Code Insiders' },
  { prefix: 'https://antigravity.google/oauth-callback', name: 'Antigravity' },
  { prefix: 'https://api.devin.ai/mcp/oauth/callback', name: 'Devin' },
];

/** A redirect_uri / prefix is verifiable only if it's https on a non-loopback host. */
function isVerifiableCallback(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1';
  } catch {
    return false;
  }
}

/**
 * Parse the allowlist from `MCP_VERIFIED_CLIENTS` (JSON), falling back to the
 * built-in default. Malformed JSON or entries, and any prefix that isn't a
 * verifiable https host, are dropped — the env can extend the list, never weaken it.
 */
export function parseKnownClients(raw: string | undefined): KnownClient[] {
  if (!raw) return DEFAULT_KNOWN_CLIENTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_KNOWN_CLIENTS;
  }
  if (!Array.isArray(parsed)) return DEFAULT_KNOWN_CLIENTS;
  const clients = parsed.filter(
    (e): e is KnownClient =>
      !!e && typeof e.prefix === 'string' && typeof e.name === 'string' && isVerifiableCallback(e.prefix),
  );
  return clients.length ? clients : DEFAULT_KNOWN_CLIENTS;
}

export async function resolveClientIdentity(
  provider: OAuthHelpers,
  clientId: string,
  knownClients: KnownClient[] = DEFAULT_KNOWN_CLIENTS,
): Promise<ClientIdentity> {
  const client = await provider.lookupClient(clientId).catch(() => null);
  const redirectUris: string[] = client?.redirectUris ?? [];
  // Guardrail: a loopback/custom-scheme URI must never satisfy a prefix check,
  // even if it somehow shared a prefix. Only verifiable https callbacks qualify.
  const matched = redirectUris.find(
    (u) => isVerifiableCallback(u) && knownClients.some((k) => u.startsWith(k.prefix)),
  );
  const known = matched && knownClients.find((k) => matched.startsWith(k.prefix));
  if (known && matched) {
    return { label: known.name, origin: hostOf(matched), verified: true, redirectUri: matched };
  }
  return {
    label: client?.clientName || undefined,
    origin: hostOf(redirectUris[0]),
    verified: false,
    redirectUri: redirectUris[0],
  };
}

/** Claim names of the identity assertion (mirrored by the backend verifier). */
export const IDENTITY_ASSERTION = {
  PARAM: 'client_identity_assertion',
  ISSUER: BEEL_DEFAULTS.publicUrl,
  CLAIM_LABEL: 'client_label',
  CLAIM_ORIGIN: 'client_origin',
  CLAIM_VERIFIED: 'client_verified',
  /** Binds the assertion to the exact request it was minted for (anti-transplant). */
  CLAIM_CLIENT_ID: 'assert_client_id',
  CLAIM_REDIRECT_URI: 'assert_redirect_uri',
  TTL_SECONDS: 120,
} as const;

/**
 * Standard JWS (HS256) carrying the end-client identity, keyed with a DEDICATED
 * HMAC secret (NOT the OAuth client secret — key separation, independently
 * rotatable). Bound to the specific authorization request via `assert_client_id`
 * + `assert_redirect_uri` and a single-use `jti`, so a valid "verified" assertion
 * cannot be transplanted onto a different authorize request or replayed: the
 * backend cross-checks both claims against the pending request and burns the jti.
 */
export async function createIdentityAssertion(
  identity: ClientIdentity,
  hmacSecret: string,
  audience: string,
  binding: { clientId: string; redirectUri: string | undefined },
): Promise<string> {
  const key = new TextEncoder().encode(hmacSecret);
  return new SignJWT({
    [IDENTITY_ASSERTION.CLAIM_LABEL]: identity.label ?? null,
    [IDENTITY_ASSERTION.CLAIM_ORIGIN]: identity.origin ?? null,
    [IDENTITY_ASSERTION.CLAIM_VERIFIED]: identity.verified,
    [IDENTITY_ASSERTION.CLAIM_CLIENT_ID]: binding.clientId,
    [IDENTITY_ASSERTION.CLAIM_REDIRECT_URI]: binding.redirectUri ?? null,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(IDENTITY_ASSERTION.ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${IDENTITY_ASSERTION.TTL_SECONDS}s`)
    .setJti(crypto.randomUUID())
    .sign(key);
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
