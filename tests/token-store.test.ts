import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import { TokenIssuer } from '../src/http/token-store.js';

const ISSUER = 'https://mcp-test.beel.es';
const upstream = {
  access_token: 'beel-upstream',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'invoices:read sandbox',
  refresh_token: 'beel-refresh',
};

describe('TokenIssuer', () => {
  it('mints a signed JWT addressed to this server, mapping to the upstream token', async () => {
    const issuer = new TokenIssuer(ISSUER, [ISSUER, `${ISSUER}/`]);
    const issued = await issuer.issue(upstream, 'user-123');

    expect(issued.access_token).not.toBe('beel-upstream');
    const claims = decodeJwt(issued.access_token);
    expect(claims.iss).toBe(ISSUER); // iss = this server (what the client validates)
    expect(claims.aud).toContain(ISSUER); // aud = the resource
    expect(claims.sub).toBe('user-123');
    expect(decodeProtectedHeader(issued.access_token).alg).toBe('RS256');

    const auth = issuer.resolve(issued.access_token, 'beel-mcp');
    expect(auth.token).toBe('beel-upstream'); // upstream token forwarded to the API
    expect(auth.scopes).toEqual(['invoices:read', 'sandbox']);
  });

  it('publishes a JWKS with the signing public key', async () => {
    const issuer = new TokenIssuer(ISSUER, [ISSUER]);
    const { keys } = await issuer.jwks();
    expect(keys).toHaveLength(1);
    expect((keys[0] as { kty?: string }).kty).toBe('RSA');
  });

  it('maps our refresh token to the upstream one', async () => {
    const issuer = new TokenIssuer(ISSUER, [ISSUER]);
    const issued = await issuer.issue(upstream, 'user-123');
    expect(issuer.upstreamRefresh(issued.refresh_token!)).toBe('beel-refresh');
    expect(issuer.upstreamRefresh('unknown')).toBeUndefined();
  });

  it('rejects unknown or expired tokens', async () => {
    const issuer = new TokenIssuer(ISSUER, [ISSUER]);
    expect(() => issuer.resolve('nope', 'beel-mcp')).toThrow();
    const expired = await issuer.issue({ access_token: 'a', token_type: 'Bearer', expires_in: -10 }, 's');
    expect(() => issuer.resolve(expired.access_token, 'beel-mcp')).toThrow();
  });
});
