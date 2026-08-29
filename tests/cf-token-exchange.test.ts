import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenExchangeCallback } from '../src/cf/token-exchange.js';
import type { SessionProps } from '../src/cf/token-exchange.js';
import type { TokenExchangeCallbackOptions } from '@cloudflare/workers-oauth-provider';

/**
 * The provider package imports `cloudflare:workers`, which the Node test runner
 * cannot resolve. Only `OAuthError` is used here, and it is reproduced with the
 * contract this code depends on: a `code` carrying the OAuth error identifier.
 */
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthError: class OAuthError extends Error {
    constructor(
      readonly code: string,
      readonly options: { description: string },
    ) {
      super(options.description);
      this.name = 'OAuthError';
    }
  },
}));

/**
 * The refresh of this server's token is the only moment the upstream BeeL token
 * can be renewed. When it cannot be, the grant is dead and the client has to be
 * told in the one term it acts on: `invalid_grant`, which restarts consent.
 */

const env = { BEEL_OAUTH_CLIENT_SECRET: 'secret' };

const props: SessionProps = { accessToken: 'old', refreshToken: 'rt', scopes: ['invoices:read'] };

const options = (overrides: Record<string, unknown> = {}) =>
  ({ grantType: 'refresh_token', props, ...overrides }) as TokenExchangeCallbackOptions;

afterEach(() => vi.unstubAllGlobals());

describe('tokenExchangeCallback', () => {
  it('ignores anything that is not a refresh', async () => {
    const result = await createTokenExchangeCallback(env)(
      options({ grantType: 'authorization_code' }),
    );
    expect(result).toBeUndefined();
  });

  it('carries the renewed bearer into the props and derives the TTL from it', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600 }),
        ),
    );

    const result = await createTokenExchangeCallback(env)(options());

    expect(result?.newProps).toMatchObject({
      accessToken: 'new',
      refreshToken: 'rt2',
      scopes: ['invoices:read'],
    });
    // Ours must expire before the upstream token, never after.
    expect(result?.accessTokenTTL).toBeLessThan(3600);
  });

  it('keeps the current refresh token when the server does not rotate it', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ access_token: 'new', expires_in: 600 })),
    );

    const result = await createTokenExchangeCallback(env)(options());
    expect((result?.newProps as SessionProps).refreshToken).toBe('rt');
  });

  it('asks the client to re-consent when the upstream refresh is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );

    await expect(createTokenExchangeCallback(env)(options())).rejects.toMatchObject({
      code: 'invalid_grant',
    });
  });

  it('asks the client to re-consent when the grant holds no refresh token', async () => {
    await expect(
      createTokenExchangeCallback(env)(options({ props: { ...props, refreshToken: undefined } })),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('lets an unexpected failure surface unchanged', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network down');
    });
    await expect(createTokenExchangeCallback(env)(options())).rejects.toBeInstanceOf(TypeError);
  });
});
