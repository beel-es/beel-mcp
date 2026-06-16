import { describe, expect, it } from 'vitest';
import { TokenStore } from '../src/http/token-store.js';

describe('TokenStore', () => {
  it('issues opaque tokens distinct from the upstream and resolves back to it', () => {
    const store = new TokenStore();
    const issued = store.issue({
      access_token: 'beel-upstream',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'invoices:read sandbox',
      refresh_token: 'beel-refresh',
    });

    expect(issued.access_token).not.toBe('beel-upstream');
    expect(issued.refresh_token).not.toBe('beel-refresh');

    const auth = store.resolve(issued.access_token, 'beel-mcp');
    expect(auth.token).toBe('beel-upstream'); // the upstream token is forwarded to the API
    expect(auth.clientId).toBe('beel-mcp');
    expect(auth.scopes).toEqual(['invoices:read', 'sandbox']);
  });

  it('maps our refresh token to the upstream one', () => {
    const store = new TokenStore();
    const issued = store.issue({ access_token: 'a', token_type: 'Bearer', refresh_token: 'beel-refresh' });
    expect(store.upstreamRefresh(issued.refresh_token!)).toBe('beel-refresh');
    expect(store.upstreamRefresh('unknown')).toBeUndefined();
  });

  it('rejects unknown or expired access tokens', () => {
    const store = new TokenStore();
    expect(() => store.resolve('nope', 'beel-mcp')).toThrow();
    const expired = store.issue({ access_token: 'a', token_type: 'Bearer', expires_in: -10 });
    expect(() => store.resolve(expired.access_token, 'beel-mcp')).toThrow();
  });
});
