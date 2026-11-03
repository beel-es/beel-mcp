import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../src/api/client.js';
import type { ResolvedConfig } from '../src/config.js';

const config: ResolvedConfig = {
  apiKey: 'beel_sk_test_x',
  env: 'test',
  baseUrl: 'https://api.test',
};

function captureFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ success: true, data: { id: '1' } }), { status: 200 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const keyOf = (call: { init: RequestInit } | undefined) =>
  (call?.init.headers as Record<string, string> | undefined)?.['Idempotency-Key'];

/** Every operation in these cases declares the header in the contract. */
const declaredHeaders = ['Idempotency-Key'];

describe('idempotency key (fiscal duplicate protection)', () => {
  it('is stable across byte-identical POST retries', async () => {
    const calls = captureFetch();
    const body = { total: 100, customer: 'c1' };
    await apiRequest(config, {
      method: 'POST',
      path: '/v1/companies/x/invoices',
      body,
      declaredHeaders,
    });
    await apiRequest(config, {
      method: 'POST',
      path: '/v1/companies/x/invoices',
      body,
      declaredHeaders,
    });
    expect(keyOf(calls[0])).toBe(keyOf(calls[1]));
  });

  it('differs when the payload changes', async () => {
    const calls = captureFetch();
    await apiRequest(config, {
      method: 'POST',
      path: '/v1/companies/x/invoices',
      body: { total: 100 },
      declaredHeaders,
    });
    await apiRequest(config, {
      method: 'POST',
      path: '/v1/companies/x/invoices',
      body: { total: 200 },
      declaredHeaders,
    });
    expect(keyOf(calls[0])).not.toBe(keyOf(calls[1]));
  });

  it('differs for the same body against different companies (multi-NIF safety)', async () => {
    // The company is part of the path on every scoped operation, so an identical
    // payload sent to two NIFs cannot collapse into one backend operation.
    const calls = captureFetch();
    const body = { total: 100 };
    await apiRequest(config, {
      method: 'POST',
      path: '/v1/companies/nif-A/invoices',
      body,
      declaredHeaders,
    });
    await apiRequest(config, {
      method: 'POST',
      path: '/v1/companies/nif-B/invoices',
      body,
      declaredHeaders,
    });
    expect(keyOf(calls[0])).not.toBe(keyOf(calls[1]));
  });

  it('honours an explicit caller-supplied key', async () => {
    const calls = captureFetch();
    await apiRequest(config, {
      method: 'POST',
      path: '/v1/companies/x/invoices',
      body: { total: 100 },
      idempotencyKey: 'my-key',
      declaredHeaders,
    });
    expect(keyOf(calls[0])).toBe('my-key');
  });

  it('is not set on GET', async () => {
    const calls = captureFetch();
    await apiRequest(config, { method: 'GET', path: '/v1/companies/x/invoices' });
    expect(keyOf(calls[0])).toBeUndefined();
  });

  it('is not set on a POST whose contract declares no such header', async () => {
    // The header is part of an operation's contract, not of the verb. Sending it
    // where it was never documented asks the API to honour something it never
    // promised — `validateNif` is one such POST.
    const calls = captureFetch();
    await apiRequest(config, {
      method: 'POST',
      path: '/v1/nif/validate',
      body: { nif: 'B12345674' },
    });
    expect(keyOf(calls[0])).toBeUndefined();
  });

  it('is set on a PUT that declares it', async () => {
    const calls = captureFetch();
    await apiRequest(config, {
      method: 'PUT',
      path: '/v1/companies/x/series/s',
      body: { a: 1 },
      declaredHeaders,
    });
    expect(keyOf(calls[0])).toBeDefined();
  });
});

describe('the idempotency key covers the whole request', () => {
  it('differs when a query parameter changes the meaning of the call', async () => {
    // POST …/customers/bulk?dry_run=true and the same call with dry_run=false
    // carry an identical body. Leaving the query out of the key gives them the
    // same one: the backend replays the dry run, nothing is created, and the
    // agent is told it succeeded.
    const calls = captureFetch();
    const body = { customers: [{ nif: 'B12345674' }] };
    const path = '/v1/companies/x/customers/bulk';
    await apiRequest(config, {
      method: 'POST',
      path,
      body,
      query: { dry_run: 'true' },
      declaredHeaders,
    });
    await apiRequest(config, {
      method: 'POST',
      path,
      body,
      query: { dry_run: 'false' },
      declaredHeaders,
    });
    expect(keyOf(calls[0])).not.toBe(keyOf(calls[1]));
  });

  it('is stable when only the order of query parameters changes', async () => {
    // Order is not significant in HTTP, so the same request must hash one way —
    // otherwise a retry could miss the deduplication it exists for.
    const calls = captureFetch();
    const body = { total: 100 };
    const path = '/v1/companies/x/invoices';
    await apiRequest(config, {
      method: 'POST',
      path,
      body,
      query: { a: '1', b: '2' },
      declaredHeaders,
    });
    await apiRequest(config, {
      method: 'POST',
      path,
      body,
      query: { b: '2', a: '1' },
      declaredHeaders,
    });
    expect(keyOf(calls[0])).toBe(keyOf(calls[1]));
  });

  it('still collapses a byte-identical retry into one operation', async () => {
    const calls = captureFetch();
    const request = {
      method: 'POST',
      path: '/v1/companies/x/invoices',
      body: { total: 100 },
      query: { wait_for_pdf: 'true' },
      declaredHeaders,
    } as const;
    await apiRequest(config, { ...request });
    await apiRequest(config, { ...request });
    expect(keyOf(calls[0])).toBe(keyOf(calls[1]));
  });
});

describe('multipart CSV imports', () => {
  const parts = [
    { name: 'accounts_file', kind: 'file' },
    { name: 'customers_file', kind: 'file' },
    { name: 'options', kind: 'json' },
  ] as const;

  it('sends each CSV string as a file part and options as a JSON part', async () => {
    const calls = captureFetch();
    const csv = 'external_ref,nif\nr-1,B00000000\n';
    await apiRequest(config, {
      method: 'POST',
      path: '/v1/accounts/imports/preview',
      body: { accounts_file: csv, options: { access_level: 'OPERATE' } },
      multipart: parts,
    });
    const init = calls[0]!.init;
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    const form = init.body as FormData;
    const file = form.get('accounts_file') as File;
    expect(file.name).toBe('accounts_file.csv');
    expect(file.type).toBe('text/csv');
    expect(await file.text()).toBe(csv);
    expect(form.has('customers_file')).toBe(false);
    const options = form.get('options') as Blob;
    expect(options.type).toBe('application/json');
    expect(JSON.parse(await options.text())).toEqual({ access_level: 'OPERATE' });
  });

  it('keys a repeated import by its content, so a retry does not provision twice', async () => {
    const calls = captureFetch();
    const send = (csv: string) =>
      apiRequest(config, {
        method: 'POST',
        path: '/v1/accounts/imports',
        body: { accounts_file: csv },
        multipart: parts,
        declaredHeaders,
      });
    await send('external_ref\nr-1\n');
    await send('external_ref\nr-1\n');
    await send('external_ref\nr-2\n');
    expect(keyOf(calls[0])).toBe(keyOf(calls[1]));
    expect(keyOf(calls[2])).not.toBe(keyOf(calls[0]));
  });
});
