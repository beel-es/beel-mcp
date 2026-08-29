import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeelAuthHandler } from '../src/cf/beel-handler.js';
import { WORKER_PATH, WORKER_TTL } from '../src/cf/constants.js';

/**
 * The /authorize + /callback pair, which is the whole of the bridge between an
 * MCP client's OAuth request and BeeL's own authorization server. Everything
 * asserted here is a property a broken connection would otherwise show only as
 * "it did not work": what is stored, what is spent once, and what a session is
 * recorded as holding.
 */

const ISSUER = 'https://app.beel.es/api';

/** A JWT the code only ever decodes, never verifies. */
function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

const ACCESS_TOKEN = jwt({ sub: 'user-1', scope: 'invoices:read invoices:write' });

interface Stored {
  value: string;
  expirationTtl?: number;
}

function fakeKv() {
  const store = new Map<string, Stored>();
  return {
    store,
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, { value, expirationTtl: options?.expirationTtl });
    }),
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  };
}

let completed: Array<Record<string, unknown>>;

function fakeEnv(overrides: Record<string, unknown> = {}) {
  const kv = fakeKv();
  return {
    kv,
    env: {
      BEEL_OAUTH_ISSUER: ISSUER,
      BEEL_OAUTH_CLIENT_ID: 'beel-mcp',
      MCP_PUBLIC_URL: 'https://mcp.beel.es',
      OAUTH_KV: kv,
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => ({
          clientId: 'client-1',
          redirectUri: 'https://claude.ai/api/mcp/auth_callback',
          scope: ['invoices:read'],
          responseType: 'code',
          state: 'client-state',
        }),
        lookupClient: async () => ({ clientName: 'Claude', redirectUris: [] }),
        completeAuthorization: async (options: Record<string, unknown>) => {
          completed.push(options);
          return { redirectTo: 'https://claude.ai/api/mcp/auth_callback?code=ours' };
        },
      },
      ...overrides,
    },
  };
}

const call = (env: unknown, path: string, query = '') =>
  BeelAuthHandler.fetch(new Request(`https://mcp.beel.es${path}${query}`), env as never);

/** The state token /authorize minted, read back out of KV. */
const storedState = (kv: ReturnType<typeof fakeKv>): string =>
  [...kv.store.keys()][0]!.replace('pending-auth:', '');

beforeEach(() => {
  completed = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/authorize', () => {
  it('stores the pending request under a single-use state with a login-length TTL', async () => {
    const { env, kv } = fakeEnv();
    const response = await call(env, WORKER_PATH.authorize, '?client_id=client-1');

    expect(response.status).toBe(302);
    expect(kv.put).toHaveBeenCalledOnce();
    const [key, value, options] = kv.put.mock.calls[0]!;
    expect(key).toMatch(/^pending-auth:/);
    expect(JSON.parse(value).codeVerifier).toEqual(expect.any(String));
    expect(options?.expirationTtl).toBe(WORKER_TTL.pendingAuthSeconds);
  });

  it('sends the upstream everything the exchange will have to match', async () => {
    const { env, kv } = fakeEnv();
    const target = new URL((await call(env, WORKER_PATH.authorize)).headers.get('location')!);

    expect(target.origin + target.pathname).toBe(`${ISSUER}/oauth2/authorize`);
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('client_id')).toBe('beel-mcp');
    expect(target.searchParams.get('redirect_uri')).toBe('https://mcp.beel.es/callback');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('state')).toBe(storedState(kv));
    // The client asked for a scope, so no default is substituted for it.
    expect(target.searchParams.get('scope')).toBe('invoices:read');
  });

  it('attaches a signed client-identity assertion only when a key is provisioned', async () => {
    const without = new URL(
      (await call(fakeEnv().env, WORKER_PATH.authorize)).headers.get('location')!,
    );
    expect(without.searchParams.get('client_identity_assertion')).toBeNull();

    const withKey = new URL(
      (
        await call(fakeEnv({ MCP_IDENTITY_HMAC_KEY: 'dedicated-key' }).env, WORKER_PATH.authorize)
      ).headers.get('location')!,
    );
    expect(withKey.searchParams.get('client_identity_assertion')).toMatch(/^ey/);
  });

  it('falls back to the scopes discovery grants when the client asks for none', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ scopes_supported: ['invoices:read'] })),
    );
    const { env } = fakeEnv({
      OAUTH_PROVIDER: {
        ...fakeEnv().env.OAUTH_PROVIDER,
        parseAuthRequest: async () => ({ clientId: 'client-1', scope: [] }),
      },
    });

    const target = new URL((await call(env, WORKER_PATH.authorize)).headers.get('location')!);
    expect(target.searchParams.get('scope')).toBe('invoices:read');
  });

  it('answers 400, not 500, when the provider rejects the request before knowing the client', async () => {
    const rejection = Object.assign(new Error('client_id is required'), {
      name: 'AuthorizationError',
      code: 'invalid_request',
      description: 'client_id is required',
    });
    const { env } = fakeEnv({
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => {
          throw rejection;
        },
      },
    });
    const response = await call(env, WORKER_PATH.authorize);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('invalid_request');
  });

  it('returns the error to the client once its redirect_uri has been validated', async () => {
    const rejection = Object.assign(new Error('scope not allowed'), {
      name: 'AuthorizationError',
      code: 'invalid_scope',
      description: 'scope not allowed',
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      state: 'client-state',
    });
    const { env } = fakeEnv({
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => {
          throw rejection;
        },
      },
    });
    const response = await call(env, WORKER_PATH.authorize);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(location.searchParams.get('state')).toBe('client-state');
  });

  it('still surfaces failures that are not authorization errors', async () => {
    const { env } = fakeEnv({
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => {
          throw new Error('kv unavailable');
        },
      },
    });
    // Anything that is not the caller's mistake stays a 500: it must reach the
    // error tracker rather than be dressed up as an OAuth error.
    expect((await call(env, WORKER_PATH.authorize)).status).toBe(500);
  });

  it('refuses a request that names no client', async () => {
    const { env } = fakeEnv({
      OAUTH_PROVIDER: { parseAuthRequest: async () => ({ clientId: '', scope: [] }) },
    });
    expect((await call(env, WORKER_PATH.authorize)).status).toBe(400);
  });
});

describe('/callback rejects what it cannot trust', () => {
  it('needs a state, and one it actually issued', async () => {
    const { env } = fakeEnv();
    expect((await call(env, WORKER_PATH.callback, '?code=x')).status).toBe(400);
    expect((await call(env, WORKER_PATH.callback, '?state=never-issued&code=x')).status).toBe(400);
  });

  it('answers 400, not 500, when the stored state is not readable', async () => {
    const { env, kv } = fakeEnv();
    kv.store.set('pending-auth:s', { value: 'not json' });
    const response = await call(env, WORKER_PATH.callback, '?state=s&code=x');
    expect(response.status).toBe(400);
  });

  it('echoes only the error codes the RFC defines', async () => {
    const { env, kv } = fakeEnv();
    await call(env, WORKER_PATH.authorize);
    const state = storedState(kv);

    const denied = await call(env, WORKER_PATH.callback, `?state=${state}&error=access_denied`);
    expect(await denied.text()).toContain('access_denied');

    await call(env, WORKER_PATH.authorize);
    const injected = await call(
      env,
      WORKER_PATH.callback,
      `?state=${storedState(kv)}&error=${encodeURIComponent('<script>alert(1)</script>')}`,
    );
    const body = await injected.text();
    expect(body).not.toContain('script');
    expect(body).toContain('unrecognized_error');
  });

  it('spends the state once, so a second hit never reaches the token endpoint', async () => {
    const { env, kv } = fakeEnv();
    let exchanges = 0;
    vi.stubGlobal('fetch', async () => {
      exchanges += 1;
      return new Response(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
    });

    await call(env, WORKER_PATH.authorize);
    const state = storedState(kv);
    const first = await call(env, WORKER_PATH.callback, `?state=${state}&code=abc`);
    const second = await call(env, WORKER_PATH.callback, `?state=${state}&code=abc`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(exchanges).toBe(1);
    expect(kv.store.size).toBe(0);
  });

  it('explains a rejected code instead of surfacing the upstream failure', async () => {
    const { env, kv } = fakeEnv();
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );

    await call(env, WORKER_PATH.authorize);
    const response = await call(env, WORKER_PATH.callback, `?state=${storedState(kv)}&code=abc`);

    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/already been used|expired/i);
  });

  it('fails the connection when the token carries no identity', async () => {
    const { env, kv } = fakeEnv();
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ access_token: jwt({ scope: 'invoices:read' }) })),
    );

    await call(env, WORKER_PATH.authorize);
    const response = await call(env, WORKER_PATH.callback, `?state=${storedState(kv)}&code=abc`);

    expect(response.status).toBe(502);
    expect(completed).toHaveLength(0);
  });
});

describe('/callback records what the session really holds', () => {
  async function connect(tokenBody: Record<string, unknown>) {
    const { env, kv } = fakeEnv();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(tokenBody)));
    await call(env, WORKER_PATH.authorize);
    const response = await call(env, WORKER_PATH.callback, `?state=${storedState(kv)}&code=abc`);
    return { response, grant: completed[0] };
  }

  it('prefers the scope the token response states', async () => {
    const { grant } = await connect({ access_token: ACCESS_TOKEN, scope: 'invoices:read' });
    expect(grant?.scope).toEqual(['invoices:read']);
  });

  it('reads the granted scope out of the token when the response omits it', async () => {
    // Never the REQUESTED set: it may contain scopes the user declined, and one
    // of them decides whether the session runs against the test environment.
    const { grant } = await connect({ access_token: ACCESS_TOKEN });
    expect(grant?.scope).toEqual(['invoices:read', 'invoices:write']);
  });

  it('falls back to what was requested only when nothing else says', async () => {
    const { grant } = await connect({ access_token: jwt({ sub: 'user-1' }) });
    expect(grant?.scope).toEqual(['invoices:read']);
  });

  it('names the source of the scopes in the connection log', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(
      (...a: unknown[]) => void logged.push(String(a[0])),
    );
    await connect({ access_token: ACCESS_TOKEN });
    expect(JSON.parse(logged.find((l) => l.includes('oauth_callback'))!).scope_source).toBe('jwt');
  });

  it('keys the grant by the subject of the token', async () => {
    const { grant } = await connect({ access_token: ACCESS_TOKEN, refresh_token: 'rt' });
    expect(grant?.userId).toBe('user-1');
    expect(grant?.props).toMatchObject({ accessToken: ACCESS_TOKEN, refreshToken: 'rt' });
  });
});

describe('the interstitial that ends the flow', () => {
  async function finish(redirectTo: string) {
    const { env, kv } = fakeEnv();
    env.OAUTH_PROVIDER.completeAuthorization = async () => ({ redirectTo });
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ access_token: ACCESS_TOKEN })),
    );
    await call(env, WORKER_PATH.authorize);
    return call(env, WORKER_PATH.callback, `?state=${storedState(kv)}&code=abc`);
  }

  it('navigates from a page of our own rather than redirecting', async () => {
    const response = await finish('https://claude.ai/cb?code=ours');
    expect(response.status).toBe(200);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('location.replace("https://claude.ai/cb?code=ours")');
  });

  it('refuses a destination that is not a web address', async () => {
    for (const target of ['javascript:alert(1)', 'data:text/html,x', 'not a url']) {
      expect((await finish(target)).status).toBe(502);
    }
  });

  it('cannot be broken out of by a target containing markup', async () => {
    const body = await (await finish('https://claude.ai/cb?x=</script><img src=x>')).text();
    expect(body).not.toContain('</script><img');
    expect(body).toContain('\\u003c/script');
  });
});

describe('/healthz', () => {
  it('answers without touching any binding', async () => {
    const response = await call(fakeEnv().env, WORKER_PATH.health);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', runtime: 'cloudflare' });
  });
});
