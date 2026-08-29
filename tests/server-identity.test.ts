import { describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { callbackUrl, upstreamConfig } from '../src/cf/upstream.js';
import { createIdentityAssertion } from '../src/cf/client-identity.js';
import { BEEL_DEFAULTS, ENV_VAR } from '../src/shared/defaults.js';

/**
 * This server's public origin is an identity, not a routing detail. Three things
 * depend on it agreeing with itself: the redirect_uri sent to the authorization
 * server, the identical one required in the token exchange, and the issuer of
 * the client-identity assertion that is bound to it. Deriving any of them from
 * the incoming request would make them vary with whichever hostname the Worker
 * was reached through, and a deployment on another origin would assert an
 * identity that is not its own.
 */
describe("the server's public identity comes from configuration", () => {
  it('defaults to the hosted origin', () => {
    const config = upstreamConfig({});
    expect(config.publicUrl).toBe(BEEL_DEFAULTS.publicUrl);
    expect(callbackUrl(config)).toBe(`${BEEL_DEFAULTS.publicUrl}/callback`);
  });

  it('follows MCP_PUBLIC_URL for a self-hosted deployment', () => {
    const config = upstreamConfig({ [ENV_VAR.publicUrl]: 'https://mcp.example.test' });
    expect(callbackUrl(config)).toBe('https://mcp.example.test/callback');
  });

  it('tolerates a trailing slash without producing a double one', () => {
    const config = upstreamConfig({ [ENV_VAR.publicUrl]: 'https://mcp.example.test/' });
    expect(callbackUrl(config)).toBe('https://mcp.example.test/callback');
  });

  it('is the same value for authorize and for the token exchange', () => {
    // OAuth requires the redirect_uri in the token exchange to match the one
    // sent to authorize exactly. One function, one answer.
    const config = upstreamConfig({ [ENV_VAR.publicUrl]: 'https://mcp.example.test' });
    expect(callbackUrl(config)).toBe(callbackUrl(config));
  });

  it('signs the identity assertion as the configured origin, not a constant', async () => {
    const config = upstreamConfig({ [ENV_VAR.publicUrl]: 'https://mcp.example.test' });
    const assertion = await createIdentityAssertion(
      { label: 'Claude', origin: 'claude.ai', verified: true },
      'test-hmac-key',
      config.issuer,
      { issuer: config.publicUrl, clientId: config.clientId, redirectUri: callbackUrl(config) },
    );
    const claims = decodeJwt(assertion);
    expect(claims.iss).toBe('https://mcp.example.test');
    expect(claims.aud).toBe(config.issuer);
  });

  it('binds the assertion to the callback it was minted for', async () => {
    // The binding is what stops a valid "verified" assertion being transplanted
    // onto a different authorization request.
    const config = upstreamConfig({});
    const assertion = await createIdentityAssertion(
      { verified: false },
      'test-hmac-key',
      config.issuer,
      { issuer: config.publicUrl, clientId: config.clientId, redirectUri: callbackUrl(config) },
    );
    const claims = decodeJwt(assertion);
    expect(claims.assert_redirect_uri).toBe(callbackUrl(config));
    expect(claims.assert_client_id).toBe(config.clientId);
    expect(claims.jti).toBeTruthy();
  });
});
