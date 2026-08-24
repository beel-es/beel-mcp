import { describe, expect, it } from 'vitest';
import { basicAuthHeader } from '../src/shared/http.js';

/** Lo que hace el servidor: `URLDecoder.decode(parte, UTF_8)` sobre cada mitad. */
function decodeAsSpringWould(header: string): { clientId: string; clientSecret: string } {
  const [id = '', secret = ''] = atob(header.replace(/^Basic /, '')).split(':');
  // URLDecoder traduce '+' por espacio ANTES de resolver los %xx.
  const urlDecode = (v: string) => decodeURIComponent(v.replace(/\+/g, ' '));
  return { clientId: urlDecode(id), clientSecret: urlDecode(secret) };
}

describe('basicAuthHeader (RFC 6749 §2.3.1)', () => {
  it('un secreto base64 con + y / sobrevive al URLDecoder del servidor', () => {
    // El caso real: el secreto de BeeL es base64 de 64 chars y usa ambos.
    const secret = 'Hx+9aB/cD3ef+GhIjK/lMnOpQrStUvWxYz0123456789+abcDEF/ghiJKLmnopB';
    const decoded = decodeAsSpringWould(basicAuthHeader('beel-mcp', secret));
    expect(decoded.clientSecret).toBe(secret);
    expect(decoded.clientId).toBe('beel-mcp');
  });

  it('sin el encode, el + se convertía en espacio — la regresión que rompió el login', () => {
    const secret = 'abc+def';
    const sinEncode = `Basic ${btoa(`beel-mcp:${secret}`)}`;
    expect(decodeAsSpringWould(sinEncode).clientSecret).toBe('abc def');
    expect(decodeAsSpringWould(basicAuthHeader('beel-mcp', secret)).clientSecret).toBe(secret);
  });

  it('un secreto sin caracteres especiales viaja exactamente igual que antes', () => {
    const secret = 'plainAlphanumericSecret123';
    expect(basicAuthHeader('beel-mcp', secret)).toBe(`Basic ${btoa(`beel-mcp:${secret}`)}`);
  });

  it('también protege el % , que el servidor leería como escape', () => {
    const secret = 'a%2Fb';
    expect(decodeAsSpringWould(basicAuthHeader('beel-mcp', secret)).clientSecret).toBe(secret);
  });
});
