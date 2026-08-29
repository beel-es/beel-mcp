import { describe, expect, it } from 'vitest';
import { basicAuthHeader } from '../src/shared/http.js';

/** What the authorization server does: URL-decode each half of the credentials. */
function decodeAsServerWould(header: string): { clientId: string; clientSecret: string } {
  const [id = '', secret = ''] = atob(header.replace(/^Basic /, '')).split(':');
  // URL-decoding maps '+' to a space before it resolves the %xx escapes.
  const urlDecode = (v: string) => decodeURIComponent(v.replace(/\+/g, ' '));
  return { clientId: urlDecode(id), clientSecret: urlDecode(secret) };
}

describe('basicAuthHeader (RFC 6749 §2.3.1)', () => {
  it('a base64 secret containing + and / survives the server URL-decoding it', () => {
    const secret = 'Hx+9aB/cD3ef+GhIjK/lMnOpQrStUvWxYz0123456789+abcDEF/ghiJKLmnopB';
    const decoded = decodeAsServerWould(basicAuthHeader('beel-mcp', secret));
    expect(decoded.clientSecret).toBe(secret);
    expect(decoded.clientId).toBe('beel-mcp');
  });

  it('without the encoding a + would arrive as a space', () => {
    const secret = 'abc+def';
    const unencoded = `Basic ${btoa(`beel-mcp:${secret}`)}`;
    expect(decodeAsServerWould(unencoded).clientSecret).toBe('abc def');
    expect(decodeAsServerWould(basicAuthHeader('beel-mcp', secret)).clientSecret).toBe(secret);
  });

  it('a secret with no special characters is transmitted unchanged', () => {
    const secret = 'plainAlphanumericSecret123';
    expect(basicAuthHeader('beel-mcp', secret)).toBe(`Basic ${btoa(`beel-mcp:${secret}`)}`);
  });

  it('also protects %, which the server would otherwise read as an escape', () => {
    const secret = 'a%2Fb';
    expect(decodeAsServerWould(basicAuthHeader('beel-mcp', secret)).clientSecret).toBe(secret);
  });
});
