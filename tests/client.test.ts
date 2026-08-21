import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../src/api/client.js';
import type { ResolvedConfig } from '../src/config.js';

const config: ResolvedConfig = { apiKey: 'beel_sk_test_x', env: 'test', baseUrl: 'https://api.test' };

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

describe('idempotency key (fiscal duplicate protection)', () => {
  it('is stable across byte-identical POST retries', async () => {
    const calls = captureFetch();
    const body = { total: 100, customer: 'c1' };
    await apiRequest(config, { method: 'POST', path: '/v1/companies/x/invoices', body });
    await apiRequest(config, { method: 'POST', path: '/v1/companies/x/invoices', body });
    expect(keyOf(calls[0])).toBe(keyOf(calls[1]));
  });

  it('differs when the payload changes', async () => {
    const calls = captureFetch();
    await apiRequest(config, { method: 'POST', path: '/v1/companies/x/invoices', body: { total: 100 } });
    await apiRequest(config, { method: 'POST', path: '/v1/companies/x/invoices', body: { total: 200 } });
    expect(keyOf(calls[0])).not.toBe(keyOf(calls[1]));
  });

  it('differs for the same body against different companies (multi-NIF safety)', async () => {
    const calls = captureFetch();
    const body = { total: 100 };
    await apiRequest(config, { method: 'POST', path: '/v1/invoices', body, activeCompany: 'nif-A' });
    await apiRequest(config, { method: 'POST', path: '/v1/invoices', body, activeCompany: 'nif-B' });
    expect(keyOf(calls[0])).not.toBe(keyOf(calls[1]));
  });

  it('honours an explicit caller-supplied key', async () => {
    const calls = captureFetch();
    await apiRequest(config, { method: 'POST', path: '/v1/companies/x/invoices', body: { total: 100 }, idempotencyKey: 'my-key' });
    expect(keyOf(calls[0])).toBe('my-key');
  });

  it('is not set on GET', async () => {
    const calls = captureFetch();
    await apiRequest(config, { method: 'GET', path: '/v1/companies/x/invoices' });
    expect(keyOf(calls[0])).toBeUndefined();
  });
});
