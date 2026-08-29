import { describe, expect, it } from 'vitest';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { IDENTITY_ASSERTION, createIdentityAssertion } from '../src/cf/client-identity.js';
import { WORKER_TTL } from '../src/cf/constants.js';

/**
 * The assertion is what lets the consent screen name the client. It is signed
 * with a key the backend also holds and bound to the exact authorization request
 * it was minted for, so a "verified" assertion cannot be transplanted onto
 * another request or replayed.
 */

const SECRET = 'a-dedicated-hmac-key';
const AUDIENCE = 'https://app.beel.es/api';
const binding = {
  issuer: 'https://mcp.beel.es',
  clientId: 'beel-mcp',
  redirectUri: 'https://mcp.beel.es/callback',
};

const verify = async (token: string) =>
  jwtVerify(token, new TextEncoder().encode(SECRET), {
    audience: AUDIENCE,
    issuer: binding.issuer,
  });

describe('createIdentityAssertion', () => {
  it('signs HS256 and carries every display and binding claim', async () => {
    const token = await createIdentityAssertion(
      { label: 'Claude', origin: 'claude.ai', verified: true },
      SECRET,
      AUDIENCE,
      binding,
    );

    expect(decodeProtectedHeader(token)).toEqual({ alg: 'HS256', typ: 'JWT' });
    const { payload } = await verify(token);
    expect(payload[IDENTITY_ASSERTION.CLAIM_LABEL]).toBe('Claude');
    expect(payload[IDENTITY_ASSERTION.CLAIM_ORIGIN]).toBe('claude.ai');
    expect(payload[IDENTITY_ASSERTION.CLAIM_VERIFIED]).toBe(true);
    expect(payload[IDENTITY_ASSERTION.CLAIM_CLIENT_ID]).toBe(binding.clientId);
    expect(payload[IDENTITY_ASSERTION.CLAIM_REDIRECT_URI]).toBe(binding.redirectUri);
  });

  it('expires within the redirect it was minted for, and is single use', async () => {
    const token = await createIdentityAssertion({ verified: false }, SECRET, AUDIENCE, binding);
    const { payload } = await verify(token);

    expect(payload.exp! - payload.iat!).toBe(WORKER_TTL.identityAssertionSeconds);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('states an absent name or origin as null rather than omitting the claim', async () => {
    const token = await createIdentityAssertion({ verified: false }, SECRET, AUDIENCE, binding);
    const { payload } = await verify(token);

    expect(payload[IDENTITY_ASSERTION.CLAIM_LABEL]).toBeNull();
    expect(payload[IDENTITY_ASSERTION.CLAIM_ORIGIN]).toBeNull();
    expect(payload[IDENTITY_ASSERTION.CLAIM_VERIFIED]).toBe(false);
  });

  it('does not verify under a different key', async () => {
    const token = await createIdentityAssertion({ verified: true }, SECRET, AUDIENCE, binding);
    await expect(jwtVerify(token, new TextEncoder().encode('another-key'))).rejects.toBeInstanceOf(
      Error,
    );
  });
});
