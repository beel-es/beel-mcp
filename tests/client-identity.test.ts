import { describe, expect, it } from 'vitest';
import { DEFAULT_KNOWN_CLIENTS, parseKnownClients, resolveClientIdentity } from '../src/cf/client-identity.js';

/** Minimal fake of the OAuthProvider's lookupClient for the identity resolver. */
function provider(redirectUris: string[], clientName?: string) {
  return { lookupClient: async () => ({ redirectUris, clientName }) } as never;
}

describe('client identity (verified badge allowlist)', () => {
  it('verifies well-known web https callbacks', async () => {
    const cases: Array<[string, string]> = [
      ['https://claude.ai/api/mcp/auth_callback', 'Claude'],
      ['https://chatgpt.com/connector_platform_oauth_redirect', 'ChatGPT'],
      ['https://www.cursor.com/agents/mcp/oauth/callback', 'Cursor'],
      ['https://vscode.dev/redirect', 'VS Code (GitHub Copilot)'],
      ['https://antigravity.google/oauth-callback', 'Antigravity'],
      ['https://api.devin.ai/mcp/oauth/callback', 'Devin'],
    ];
    for (const [uri, name] of cases) {
      const id = await resolveClientIdentity(provider([uri]), 'c', uri);
      expect(id.verified).toBe(true);
      expect(id.label).toBe(name);
    }
  });

  it('never verifies loopback callbacks (impersonable by any local app)', async () => {
    for (const uri of [
      'http://localhost:8787/callback',
      'http://127.0.0.1:33418/',
      'http://localhost:7777/oauth/callback',
    ]) {
      const id = await resolveClientIdentity(provider([uri], 'Claude Code'), 'c', uri);
      expect(id.verified).toBe(false);
    }
  });

  it('does not verify a look-alike host (prefix pinned by full path + https)', async () => {
    const id = await resolveClientIdentity(provider(['https://claude.ai.evil.com/api/mcp/auth_callback']), 'c', 'https://claude.ai.evil.com/api/mcp/auth_callback');
    expect(id.verified).toBe(false);
  });

  it('rejects the old wrong Cursor callback, accepts only the real one', async () => {
    expect((await resolveClientIdentity(provider(['https://cursor.com/api/auth/callback']), 'c', 'https://cursor.com/api/auth/callback')).verified).toBe(false);
    expect((await resolveClientIdentity(provider(['https://www.cursor.com/agents/mcp/oauth/callback']), 'c', 'https://www.cursor.com/agents/mcp/oauth/callback')).verified).toBe(true);
  });
});

describe('parseKnownClients (env-configurable allowlist)', () => {
  it('falls back to the default list when unset or malformed', () => {
    expect(parseKnownClients(undefined)).toBe(DEFAULT_KNOWN_CLIENTS);
    expect(parseKnownClients('not json')).toBe(DEFAULT_KNOWN_CLIENTS);
    expect(parseKnownClients('{}')).toBe(DEFAULT_KNOWN_CLIENTS);
  });

  it('accepts a valid env override', () => {
    const list = parseKnownClients('[{"prefix":"https://partner.example/mcp/callback","name":"Partner"}]');
    expect(list).toEqual([{ prefix: 'https://partner.example/mcp/callback', name: 'Partner' }]);
  });

  it('drops entries that would weaken the bar (loopback / non-https), keeping only safe ones', () => {
    const list = parseKnownClients(JSON.stringify([
      { prefix: 'http://localhost:9000/callback', name: 'Evil Local' },
      { prefix: 'http://partner.example/x', name: 'Insecure' },
      { prefix: 'https://good.example/cb', name: 'Good' },
    ]));
    expect(list).toEqual([{ prefix: 'https://good.example/cb', name: 'Good' }]);
  });

  it('an env override made entirely of loopback entries falls back to the default (never empty-open)', () => {
    expect(parseKnownClients('[{"prefix":"http://localhost:1/cb","name":"X"}]')).toBe(DEFAULT_KNOWN_CLIENTS);
  });
});

describe('the badge follows the callback this request will use', () => {
  const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';

  it('refuses to vouch for a client that registered a well-known callback but is using another', async () => {
    // Registration is open, so anyone can register a client listing Claude's
    // callback alongside their own. Judging by the registered set would let the
    // consent screen say "Claude · verified" while the code goes elsewhere —
    // the exact consent-phishing this badge exists to prevent.
    const attacker = provider([CLAUDE, 'https://evil.example/cb'], 'Claude');
    const id = await resolveClientIdentity(attacker, 'c', 'https://evil.example/cb');

    expect(id.verified).toBe(false);
    expect(id.origin).toBe('evil.example');
    expect(id.redirectUri).toBe('https://evil.example/cb');
  });

  it('verifies the same client when it does use the well-known callback', async () => {
    const id = await resolveClientIdentity(provider([CLAUDE, 'https://other.example/cb']), 'c', CLAUDE);
    expect(id.verified).toBe(true);
    expect(id.label).toBe('Claude');
  });

  it('matches at a segment boundary, not by bare prefix', async () => {
    // A bare startsWith would accept a host that merely begins with the prefix.
    for (const impostor of [
      `${CLAUDE}.evil.example/x`,
      'https://claude.ai.evil.example/api/mcp/auth_callback',
      `${CLAUDE}evil`,
    ]) {
      const id = await resolveClientIdentity(provider([impostor]), 'c', impostor);
      expect(id.verified, impostor).toBe(false);
    }
    // The genuine forms still pass.
    for (const genuine of [CLAUDE, `${CLAUDE}/`, `${CLAUDE}?state=x`]) {
      expect((await resolveClientIdentity(provider([genuine]), 'c', genuine)).verified, genuine).toBe(true);
    }
  });

  it('stays unverified when the request carries no callback at all', async () => {
    const id = await resolveClientIdentity(provider([CLAUDE]), 'c', undefined);
    expect(id.verified).toBe(false);
  });
});
