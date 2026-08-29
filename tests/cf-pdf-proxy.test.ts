import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { pdfProxyHandler } from '../src/cf/pdf-proxy.js';
import { PDF_RELAY_LIMITS } from '../src/cf/constants.js';
import { DEFAULT_APP_ORIGIN as APP_ORIGIN } from '../src/mcpapp/contract.js';
import { PDF_PROXY_PATH } from '../src/mcpapp/contract.js';

/**
 * The relay forwards a capability its caller already holds, so what it must
 * never become is a readable, unauthenticated tunnel to an arbitrary host. Every
 * test here pins one edge of that: which targets it accepts, which it accepts
 * across a redirect, what it will treat as a document, and who may read it.
 */

const HOSTS = 'storage.example.com,alt.example.com:8443,*.cdn.example.com';

const app = new Hono<{ Bindings: Record<string, unknown> }>();
app.get(PDF_PROXY_PATH, pdfProxyHandler);

const pdf = (init: ResponseInit = {}) =>
  new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' }, ...init });

async function get(
  url: string,
  options: { hosts?: string; origin?: string } = {},
): Promise<Response> {
  const headers = options.origin ? { Origin: options.origin } : undefined;
  return await app.fetch(
    new Request(`https://mcp.beel.es${PDF_PROXY_PATH}?u=${encodeURIComponent(url)}`, { headers }),
    { BEEL_PDF_STORAGE_HOSTS: options.hosts ?? HOSTS },
  );
}

const stub = (responder: (url: string) => Response) =>
  vi.stubGlobal('fetch', async (url: string) => responder(url));

afterEach(() => vi.unstubAllGlobals());

describe('what the relay will fetch at all', () => {
  it('is disabled, not permissive, when no host is configured', async () => {
    expect((await get('https://storage.example.com/a.pdf', { hosts: '' })).status).toBe(503);
  });

  it('refuses a request with no url, and a url it cannot parse', async () => {
    const empty = await get('');
    expect(empty.status).toBe(400);
    expect((await get('not a url')).status).toBe(400);
  });

  it('refuses plaintext even towards an allowed host', async () => {
    expect((await get('http://storage.example.com/a.pdf')).status).toBe(403);
  });

  it('matches the host with its port, so an unlisted port is a different host', async () => {
    stub(() => pdf());
    expect((await get('https://alt.example.com:8443/a.pdf')).status).toBe(200);
    expect((await get('https://storage.example.com:8443/a.pdf')).status).toBe(403);
    expect((await get('https://alt.example.com/a.pdf')).status).toBe(403);
  });

  it('honours a wildcard entry for subdomains only', async () => {
    stub(() => pdf());
    expect((await get('https://eu.cdn.example.com/a.pdf')).status).toBe(200);
    expect((await get('https://cdn.example.com/a.pdf')).status).toBe(403);
  });

  it('sends an Accept naming the media types it will take', async () => {
    let accept: string | null = null;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      accept = new Headers(init.headers).get('accept');
      return pdf();
    });
    await get('https://storage.example.com/a.pdf');
    expect(accept).toContain('application/pdf');
  });
});

describe('redirects are re-validated hop by hop', () => {
  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

  it('follows a redirect that stays inside the allowlist', async () => {
    stub((url) =>
      url.includes('/a.pdf') ? redirect('https://alt.example.com:8443/b.pdf') : pdf(),
    );
    expect((await get('https://storage.example.com/a.pdf')).status).toBe(200);
  });

  it('refuses a redirect that leaves it', async () => {
    stub(() => redirect('https://evil.example/a.pdf'));
    expect((await get('https://storage.example.com/a.pdf')).status).toBe(403);
  });

  it('refuses a redirect that drops to plaintext', async () => {
    stub(() => redirect('http://storage.example.com/a.pdf'));
    expect((await get('https://storage.example.com/a.pdf')).status).toBe(403);
  });

  it('gives up on a redirect loop instead of following it forever', async () => {
    let hops = 0;
    stub(() => {
      hops += 1;
      return redirect('https://storage.example.com/next.pdf');
    });
    expect((await get('https://storage.example.com/a.pdf')).status).toBe(502);
    expect(hops).toBeLessThanOrEqual(PDF_RELAY_LIMITS.maxRedirects + 1);
  });
});

describe('what comes back is a document or nothing', () => {
  it('refuses a 200 that is not a document', async () => {
    stub(() => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));
    expect((await get('https://storage.example.com/a.pdf')).status).toBe(502);
  });

  it('accepts an octet-stream, which storage hosts use for unknown types', async () => {
    stub(() => new Response('%PDF', { headers: { 'content-type': 'application/octet-stream' } }));
    const response = await get('https://storage.example.com/a.pdf');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
  });

  it('never forwards the upstream status: its trouble is a bad gateway', async () => {
    stub(() => new Response('boom', { status: 503 }));
    expect((await get('https://storage.example.com/a.pdf')).status).toBe(502);
  });

  it('reports anything else missing as a 404, whatever the upstream called it', async () => {
    for (const status of [401, 403, 410, 418]) {
      stub(() => new Response('nope', { status }));
      expect((await get('https://storage.example.com/a.pdf')).status).toBe(404);
    }
  });

  it('refuses a body that declares itself oversized', async () => {
    stub(() =>
      pdf({
        headers: {
          'content-type': 'application/pdf',
          'content-length': String(PDF_RELAY_LIMITS.maxBytes + 1),
        },
      }),
    );
    expect((await get('https://storage.example.com/a.pdf')).status).toBe(413);
  });

  it('turns a transport failure into a bad gateway', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('connection reset');
    });
    expect((await get('https://storage.example.com/a.pdf')).status).toBe(502);
  });

  it('serves the document inline and unsniffable', async () => {
    stub(() => pdf());
    const response = await get('https://storage.example.com/a.pdf');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('only the viewer may read the bytes', () => {
  it('allows the sandboxed app, whose origin is null', async () => {
    stub(() => pdf());
    const response = await get('https://storage.example.com/a.pdf', { origin: 'null' });
    expect(response.headers.get('access-control-allow-origin')).toBe('null');
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('allows this deployment own origin', async () => {
    stub(() => pdf());
    const response = await get('https://storage.example.com/a.pdf', { origin: APP_ORIGIN });
    expect(response.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
  });

  it('does not let any other origin read them', async () => {
    stub(() => pdf());
    const response = await get('https://storage.example.com/a.pdf', {
      origin: 'https://evil.example',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('vary')).toBe('Origin');
  });
});
