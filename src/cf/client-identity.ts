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
  const known = KNOWN_CLIENTS.find((k) => redirectUris.some((u) => u.startsWith(k.prefix)));
  if (known) return { label: known.name, origin: hostOf(redirectUris[0]), verified: true };
  return {
    label: client?.clientName || undefined,
    origin: hostOf(redirectUris[0]),
    verified: false,
  };
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
