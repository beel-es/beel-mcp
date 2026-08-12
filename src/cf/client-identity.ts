import { SignJWT } from 'jose';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

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

/** Callback-URL prefixes of well-known MCP hosts → canonical display name. */
const KNOWN_CLIENTS: Array<{ prefix: string; name: string }> = [
  { prefix: 'https://claude.ai/api/mcp/auth_callback', name: 'Claude' },
  { prefix: 'https://claude.com/api/mcp/auth_callback', name: 'Claude' },
  { prefix: 'https://chatgpt.com/connector_platform_oauth_redirect', name: 'ChatGPT' },
  { prefix: 'https://cursor.com/api/auth/callback', name: 'Cursor' },
];

export async function resolveClientIdentity(
  provider: OAuthHelpers,
  clientId: string,
): Promise<ClientIdentity> {
  const client = await provider.lookupClient(clientId).catch(() => null);
  const redirectUris: string[] = client?.redirectUris ?? [];
  const matched = redirectUris.find((u) => KNOWN_CLIENTS.some((k) => u.startsWith(k.prefix)));
  const known = matched && KNOWN_CLIENTS.find((k) => matched.startsWith(k.prefix));
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
  ISSUER: 'https://mcp.beel.es',
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
