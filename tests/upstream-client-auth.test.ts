import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exchangeCode,
  resetOAuthWarningsForTests,
  TokenEndpointError,
  OAUTH_MARKER,
} from '../src/cf/upstream.js';
import type { UpstreamConfig } from '../src/cf/upstream.js';

/**
 * El incidente que estas pruebas congelan:
 *
 * El secreto de cliente se provisionó en el Worker mientras el código desplegado era
 * anterior al URL-encode de `client_secret_basic`. Un secreto con `+` llegaba corrompido,
 * el authorization server contestaba `invalid_client` y NADIE PODÍA CONECTAR — mientras
 * que sin secreto el puente funcionaba, solo que con sesiones de una hora.
 *
 * O sea: añadir configuración correcta, en el orden equivocado, tumbaba el servicio. Y el
 * fallo se veía igual que un error de red cualquiera.
 */

const config: UpstreamConfig = {
  issuer: 'https://app.beel.es/api',
  authorizeUrl: 'https://app.beel.es/api/oauth2/authorize',
  tokenUrl: 'https://app.beel.es/api/oauth2/token',
  clientId: 'beel-mcp',
  clientSecret: 'un+secreto/con+especiales',
  apiBaseUrl: 'https://app.beel.es/api',
  publicUrl: 'https://mcp.beel.es',
};

const tokens = { access_token: 'at', refresh_token: 'rt', expires_in: 3600 };

/** Cada llamada capturada: cómo se autenticó y qué mandó en el cuerpo. */
interface Attempt {
  authorization?: string;
  body: URLSearchParams;
}

function stubFetch(responder: (attempt: Attempt, n: number) => Response): Attempt[] {
  const attempts: Attempt[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const attempt: Attempt = {
      authorization: headers.Authorization ?? headers.authorization,
      body: new URLSearchParams(String(init.body)),
    };
    attempts.push(attempt);
    return responder(attempt, attempts.length);
  });
  return attempts;
}

const ok = () => new Response(JSON.stringify(tokens), { status: 200 });
const invalidClient = () =>
  new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });

beforeEach(() => {
  // Los avisos son «una vez por proceso» y el runner comparte proceso: sin rearmarlos,
  // el primer caso los consume y los demás medirían silencio.
  resetOAuthWarningsForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('autenticación del cliente contra el token endpoint', () => {
  it('con secreto autentica por Basic y no filtra el client_id al cuerpo', async () => {
    const attempts = stubFetch(ok);
    await exchangeCode(config, 'code', 'https://mcp.beel.es/callback', 'verifier');

    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.authorization).toMatch(/^Basic /);
    // Con Basic el client_id viaja SOLO en la cabecera (RFC 6749 §2.3.1).
    expect(attempts[0]!.body.get('client_id')).toBeNull();
  });

  it('un invalid_client NO deja a nadie fuera: degrada a cliente público', async () => {
    const attempts = stubFetch((_a, n) => (n === 1 ? invalidClient() : ok()));

    const result = await exchangeCode(config, 'code', 'https://mcp.beel.es/callback', 'verifier');

    expect(result.access_token).toBe('at');
    expect(attempts).toHaveLength(2);
    // El reintento va como cliente público: sin Basic y con el client_id en el cuerpo,
    // que es como el puente funcionaba antes de que existiera el secreto.
    expect(attempts[1]!.authorization).toBeUndefined();
    expect(attempts[1]!.body.get('client_id')).toBe('beel-mcp');
    // Y el code_verifier sigue viajando: PKCE es lo que protege al cliente público.
    expect(attempts[1]!.body.get('code_verifier')).toBe('verifier');
  });

  it('la degradación se anuncia con un marcador estable, no en silencio', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch((_a, n) => (n === 1 ? invalidClient() : ok()));

    await exchangeCode(config, 'code', 'https://mcp.beel.es/callback', 'verifier');

    const mensajes = spy.mock.calls.map((c) => String(c[0]));
    expect(mensajes.some((m) => m.startsWith(OAUTH_MARKER.rejectedSecret))).toBe(true);
  });

  it('sin secreto avisa como error, porque cuesta usuarios en silencio', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(ok);

    await exchangeCode(
      { ...config, clientSecret: '' },
      'code',
      'https://mcp.beel.es/callback',
      'verifier',
    );

    const mensajes = spy.mock.calls.map((c) => String(c[0]));
    expect(mensajes.some((m) => m.startsWith(OAUTH_MARKER.missingSecret))).toBe(true);
  });

  it('otros fallos NO se degradan: un invalid_grant se propaga tipado', async () => {
    const attempts = stubFetch(
      () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );

    await expect(
      exchangeCode(config, 'code', 'https://mcp.beel.es/callback', 'verifier'),
    ).rejects.toMatchObject({
      name: 'TokenEndpointError',
      status: 400,
      oauthError: 'invalid_grant',
      usedClientSecret: true,
    });
    // Un code caducado no mejora reintentando sin secreto: una sola llamada.
    expect(attempts).toHaveLength(1);
  });

  it('un 500 del servidor tampoco degrada, y llega tipado', async () => {
    stubFetch(() => new Response('upstream boom', { status: 500 }));

    const error = await exchangeCode(
      config,
      'code',
      'https://mcp.beel.es/callback',
      'verifier',
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TokenEndpointError);
    expect((error as TokenEndpointError).oauthError).toBeUndefined();
  });

  it('si la degradación tampoco funciona, el error final es el de verdad', async () => {
    stubFetch(() => invalidClient());

    await expect(
      exchangeCode(config, 'code', 'https://mcp.beel.es/callback', 'verifier'),
    ).rejects.toMatchObject({ name: 'TokenEndpointError', oauthError: 'invalid_client' });
  });
});
