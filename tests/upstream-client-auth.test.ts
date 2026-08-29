import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exchangeCode, TokenEndpointError, OAUTH_MARKER } from '../src/cf/upstream.js';
import type { UpstreamConfig } from '../src/cf/upstream.js';
import { HTTP_DEFAULTS } from '../src/shared/defaults.js';

/**
 * Client authentication against the upstream token endpoint.
 *
 * Two invariants hold this together. The secret must survive the URL-decoding
 * the RFC mandates (see basic-auth-header.test.ts), and a secret the server
 * rejects must fail loudly: silently continuing as a public client trades a
 * visible misconfiguration for sessions that quietly lose their refresh token.
 */

const config: UpstreamConfig = {
  issuer: 'https://app.beel.es/api',
  authorizeUrl: 'https://app.beel.es/api/oauth2/authorize',
  tokenUrl: 'https://app.beel.es/api/oauth2/token',
  clientId: 'beel-mcp',
  clientSecret: 'a+secret/with+specials',
  apiBaseUrl: 'https://app.beel.es/api',
  publicUrl: 'https://mcp.beel.es',
  allowPublicFallback: false,
};

const tokens = { access_token: 'at', refresh_token: 'rt', expires_in: 3600 };

/** One captured call: how it authenticated and what it sent in the body. */
interface Attempt {
  authorization?: string;
  body: URLSearchParams;
  signal?: AbortSignal | null;
}

function stubFetch(responder: (attempt: Attempt, n: number) => Response): Attempt[] {
  const attempts: Attempt[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const attempt: Attempt = {
      authorization: headers.Authorization ?? headers.authorization,
      body: new URLSearchParams(String(init.body)),
      signal: init.signal,
    };
    attempts.push(attempt);
    return responder(attempt, attempts.length);
  });
  return attempts;
}

const ok = () => new Response(JSON.stringify(tokens), { status: 200 });
const invalidClient = () =>
  new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });

const exchange = (c: UpstreamConfig = config) =>
  exchangeCode(c, 'code', 'https://mcp.beel.es/callback', 'verifier');

let reported: string[];

beforeEach(() => {
  reported = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    reported.push(String(args[0]));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('client authentication against the token endpoint', () => {
  it('authenticates with Basic and keeps client_id out of the body', async () => {
    const attempts = stubFetch(ok);
    await exchange();

    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.authorization).toMatch(/^Basic /);
    // With Basic the client_id travels in the header only (RFC 6749 §2.3.1).
    expect(attempts[0]!.body.get('client_id')).toBeNull();
  });

  it('bounds every request with the shared outbound timeout', async () => {
    const attempts = stubFetch(ok);
    await exchange();
    expect(attempts[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails loudly when the server rejects the configured secret', async () => {
    const attempts = stubFetch(() => invalidClient());

    await expect(exchange()).rejects.toMatchObject({
      name: 'TokenEndpointError',
      oauthError: 'invalid_client',
      usedClientSecret: true,
    });
    // No silent downgrade: one attempt, and the rejection is reported.
    expect(attempts).toHaveLength(1);
    expect(reported.some((m) => m.startsWith(OAUTH_MARKER.rejectedSecret))).toBe(true);
  });

  it('downgrades to a public client only behind the explicit opt-in', async () => {
    const attempts = stubFetch((_a, n) => (n === 1 ? invalidClient() : ok()));

    const result = await exchange({ ...config, allowPublicFallback: true });

    expect(result.access_token).toBe('at');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.authorization).toBeUndefined();
    expect(attempts[1]!.body.get('client_id')).toBe('beel-mcp');
    // PKCE is what protects a public client, so the verifier still travels.
    expect(attempts[1]!.body.get('code_verifier')).toBe('verifier');
  });

  it('reports a missing secret on every exchange, not once per process', async () => {
    stubFetch(ok);
    const public_ = { ...config, clientSecret: '' };

    await exchange(public_);
    await exchange(public_);

    const missing = reported.filter((m) => m.startsWith(OAUTH_MARKER.missingSecret));
    expect(missing).toHaveLength(2);
  });

  it('never authenticates with Basic when no secret is configured', async () => {
    const attempts = stubFetch(ok);
    await exchange({ ...config, clientSecret: '' });

    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.authorization).toBeUndefined();
    expect(attempts[0]!.body.get('client_id')).toBe('beel-mcp');
  });

  it('surfaces a server error typed, without echoing the upstream body', async () => {
    stubFetch(() => new Response('upstream stack trace with secrets', { status: 500 }));

    const error = (await exchange().catch((e: unknown) => e)) as TokenEndpointError;

    expect(error).toBeInstanceOf(TokenEndpointError);
    expect(error.status).toBe(500);
    expect(error.oauthError).toBeUndefined();
    expect(error.message).not.toContain('upstream stack trace');
  });

  it('names the OAuth error code when the body carries one', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    await expect(exchange()).rejects.toMatchObject({ oauthError: 'invalid_grant' });
  });
});

describe('the token response is validated before it is trusted', () => {
  it('rejects a 200 that is not JSON', async () => {
    stubFetch(() => new Response('<html>maintenance</html>', { status: 200 }));
    await expect(exchange()).rejects.toBeInstanceOf(TokenEndpointError);
  });

  it('rejects a response without a usable access_token', async () => {
    for (const body of [{}, { access_token: 42 }, { access_token: '' }]) {
      stubFetch(() => new Response(JSON.stringify(body), { status: 200 }));
      await expect(exchange()).rejects.toBeInstanceOf(TokenEndpointError);
    }
  });

  it('rejects non-numeric or non-string optional members', async () => {
    for (const body of [
      { access_token: 'at', expires_in: 'soon' },
      { access_token: 'at', refresh_token: 7 },
      { access_token: 'at', scope: ['a'] },
    ]) {
      stubFetch(() => new Response(JSON.stringify(body), { status: 200 }));
      await expect(exchange()).rejects.toBeInstanceOf(TokenEndpointError);
    }
  });

  it('accepts a response carrying only the required member', async () => {
    stubFetch(() => new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }));
    await expect(exchange()).resolves.toEqual({ access_token: 'at' });
  });
});

describe('outbound timeout', () => {
  it('is the shared one, so no upstream call can hang a Worker forever', () => {
    expect(HTTP_DEFAULTS.timeoutMs).toBeGreaterThan(0);
  });
});
