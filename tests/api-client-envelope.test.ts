import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ApiError, apiRequest, parseErrorEnvelope } from '../src/api/client.js';
import type { ResolvedConfig } from '../src/config.js';

const config: ResolvedConfig = {
  apiKey: 'beel_sk_test_x',
  env: 'test',
  baseUrl: 'https://api.test',
  transport: 'stdio',
};

/** A response body shaped exactly like the contract's ErrorResponse. */
const ERROR_FIXTURE = {
  success: false,
  error: {
    code: 'INVOICE_NO_LINES',
    message: 'La factura debe tener al menos una línea',
    details: { field: 'lines' },
  },
  meta: { timestamp: '2026-01-15T10:30:00Z', request_id: '4bf92f3577b34da6a3ce929d0e0e4736' },
  type: 'https://docs.beel.es/errors/INVOICE_NO_LINES',
  title: 'INVOICE_NO_LINES',
  detail: 'La factura debe tener al menos una línea',
  instance: '/v1/invoices/abc-123',
};

function stubResponses(...responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const make = responses[Math.min(index, responses.length - 1)]!;
    index++;
    return make();
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('the error envelope is read where the contract puts each field', () => {
  it('matches the shape declared by components/schemas/ErrorResponse', () => {
    const spec = parseYaml(readFileSync('openapi/public-api.yaml', 'utf8')) as {
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    const envelope = spec.components.schemas.ErrorResponse!;
    const detail = spec.components.schemas.ErrorDetail!;
    const meta = spec.components.schemas.ResponseMeta!;
    // The fields the client reads, and the depth it reads them at.
    expect(Object.keys(envelope.properties)).toEqual(
      expect.arrayContaining(['success', 'error', 'meta', 'type']),
    );
    expect(Object.keys(detail.properties)).toEqual(
      expect.arrayContaining(['code', 'message', 'details']),
    );
    expect(Object.keys(meta.properties)).toEqual(expect.arrayContaining(['request_id']));
  });

  it('extracts code, message, details, request id and docs URI from a real envelope', () => {
    expect(parseErrorEnvelope(ERROR_FIXTURE)).toEqual({
      code: 'INVOICE_NO_LINES',
      message: 'La factura debe tener al menos una línea',
      details: { field: 'lines' },
      requestId: '4bf92f3577b34da6a3ce929d0e0e4736',
      docsUrl: 'https://docs.beel.es/errors/INVOICE_NO_LINES',
    });
  });

  it('yields no fields at all rather than inventing them for a foreign body', () => {
    expect(parseErrorEnvelope('<html>gateway error</html>')).toEqual({});
    expect(parseErrorEnvelope({ error: 'a string, not ErrorDetail' })).toEqual({
      code: undefined,
      message: undefined,
      details: undefined,
      requestId: undefined,
      docsUrl: undefined,
    });
  });

  it('surfaces every envelope field on the thrown ApiError', async () => {
    stubResponses(() => new Response(JSON.stringify(ERROR_FIXTURE), { status: 422 }));
    const err = await apiRequest(config, { method: 'GET', path: '/v1/x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 422,
      code: 'INVOICE_NO_LINES',
      details: { field: 'lines' },
      requestId: '4bf92f3577b34da6a3ce929d0e0e4736',
      docsUrl: 'https://docs.beel.es/errors/INVOICE_NO_LINES',
    });
  });
});

describe('retrying may never apply a mutation twice', () => {
  const gone = () => new Response('', { status: 504, headers: { 'retry-after': '0' } });
  const busy = () => new Response('', { status: 503, headers: { 'retry-after': '0' } });
  const ok = () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });

  it('retries a GET on an ambiguous gateway status', async () => {
    const calls = stubResponses(gone, ok);
    await apiRequest(config, { method: 'GET', path: '/v1/x' });
    expect(calls).toHaveLength(2);
  });

  it('does not retry a keyless mutation on an ambiguous gateway status', async () => {
    // A 504 does not say whether the origin applied the request. Without a key
    // the repeat is a second application.
    const calls = stubResponses(gone);
    await expect(apiRequest(config, { method: 'DELETE', path: '/v1/x' })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(calls).toHaveLength(1);
  });

  it('retries a keyless mutation when the status says it was never applied', async () => {
    const calls = stubResponses(busy, ok);
    await apiRequest(config, { method: 'PATCH', path: '/v1/x', body: { a: 1 } });
    expect(calls).toHaveLength(2);
  });

  it('retries an ambiguous gateway status once an idempotency key is attached', async () => {
    const calls = stubResponses(gone, ok);
    await apiRequest(config, {
      method: 'POST',
      path: '/v1/x',
      body: { a: 1 },
      declaredHeaders: ['Idempotency-Key'],
    });
    expect(calls).toHaveLength(2);
  });

  it('stops after the configured number of attempts', async () => {
    const calls = stubResponses(busy);
    await expect(apiRequest(config, { method: 'GET', path: '/v1/x' })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(calls).toHaveLength(3);
  });
});

describe('a response body that is not the contract is not a result', () => {
  it('reports a non-JSON 2xx as an error instead of passing the text through', async () => {
    stubResponses(
      () =>
        new Response('<html>ok?</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const err = await apiRequest(config, { method: 'GET', path: '/v1/x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('unexpected_content_type');
  });

  it('reports an empty 204 as an explicit null with its status', async () => {
    stubResponses(() => new Response(null, { status: 204 }));
    expect(await apiRequest(config, { method: 'DELETE', path: '/v1/x' })).toEqual({
      status: 204,
      data: null,
    });
  });

  it('maps a timeout to a 504 ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.stubEnv('BEEL_REQUEST_TIMEOUT_MS', '5');
    const err = await apiRequest(config, { method: 'GET', path: '/v1/x' }).catch((e) => e);
    vi.unstubAllEnvs();
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 504, code: 'request_timeout' });
  });
});
