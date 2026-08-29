import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeelAuthHandler } from '../src/cf/beel-handler.js';
import { WORKER_PATH } from '../src/cf/constants.js';
import { fallbackGrantableScopes } from '../src/policy/scopes.js';

/**
 * The default consent set, for a client that asks for no scope of its own.
 *
 * It is the intersection of what the exposed tools need with what the upstream
 * authorization server says it will grant, so neither side is written down here.
 * What these tests pin is the behaviour around the second half being unavailable:
 * a degraded answer must never be cached as if it were the real catalogue.
 */

function env(issuer: string) {
  return {
    BEEL_OAUTH_ISSUER: issuer,
    MCP_PUBLIC_URL: 'https://mcp.beel.es',
    OAUTH_KV: { put: async () => {}, get: async () => null, delete: async () => {} },
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({ clientId: 'c', scope: [] }),
      lookupClient: async () => ({}),
    },
  };
}

async function requestedScopes(issuer: string): Promise<string[]> {
  const response = await BeelAuthHandler.fetch(
    new Request(`https://mcp.beel.es${WORKER_PATH.authorize}`),
    env(issuer) as never,
  );
  const scope = new URL(response.headers.get('location')!).searchParams.get('scope') ?? '';
  return scope.split(' ').filter(Boolean);
}

const discovery = (body: unknown, status = 200) =>
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status }));

/** A unique issuer per test, so no case can observe another's cache entry. */
let n = 0;
const issuer = () => `https://as-${(n += 1)}.example/api`;

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('default scopes', () => {
  it('asks only for what discovery says it may grant', async () => {
    discovery({ scopes_supported: ['invoices:read'] });
    expect(await requestedScopes(issuer())).toEqual(['invoices:read']);
  });

  it('caches a real answer instead of asking on every connection', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response(JSON.stringify({ scopes_supported: ['invoices:read'] }));
    });
    const as = issuer();

    await requestedScopes(as);
    await requestedScopes(as);

    expect(calls).toBe(1);
  });

  it('keys that cache by issuer, since the catalogue is per authorization server', async () => {
    const first = issuer();
    const second = issuer();
    discovery({ scopes_supported: ['invoices:read'] });
    await requestedScopes(first);

    discovery({ scopes_supported: ['invoices:write'] });
    expect(await requestedScopes(second)).toEqual(['invoices:write']);
  });

  it('never caches the static fallback, so an outage is not pinned for a TTL', async () => {
    const as = issuer();
    discovery({}, 500);
    const degraded = await requestedScopes(as);
    expect(degraded.every((s) => fallbackGrantableScopes().includes(s))).toBe(true);

    discovery({ scopes_supported: ['invoices:read'] });
    expect(await requestedScopes(as)).toEqual(['invoices:read']);
  });

  it('treats a discovery that never answers the same as one that failed', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('The operation was aborted', 'TimeoutError');
    });
    const degraded = await requestedScopes(issuer());
    expect(degraded.length).toBeGreaterThan(0);
    expect(degraded.every((s) => fallbackGrantableScopes().includes(s))).toBe(true);
  });

  it('ignores metadata that states no scopes at all', async () => {
    const as = issuer();
    discovery({ scopes_supported: [] });
    await requestedScopes(as);

    discovery({ scopes_supported: ['invoices:read'] });
    expect(await requestedScopes(as)).toEqual(['invoices:read']);
  });

  it('bounds the discovery call and lets the edge cache it', async () => {
    let init: RequestInit & { cf?: { cacheTtl?: number } } = {};
    vi.stubGlobal('fetch', async (_u: string, options: RequestInit) => {
      init = options;
      return new Response(JSON.stringify({ scopes_supported: ['invoices:read'] }));
    });
    await requestedScopes(issuer());

    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.cf?.cacheTtl).toBeGreaterThan(0);
  });
});
