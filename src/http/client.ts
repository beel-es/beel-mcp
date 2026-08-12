import type { ResolvedConfig } from '../config.js';

/** A normalised API error carrying BeeL's error envelope fields. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequestOptions {
  method: string;
  /** Path beginning with `/v1/...` (the spec server base is prepended). */
  path: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  /** Override the active company for this single call (else the configured default). */
  activeCompany?: string;
  /** Explicit idempotency key; when absent it is derived from method+path+body. */
  idempotencyKey?: string;
}

export interface ApiResult {
  status: number;
  /** Parsed JSON payload (or null for 204 / empty). */
  data: unknown;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Deterministic idempotency key for a mutating call: SHA-256 over method+path+body.
 * Two byte-identical POSTs (an agent retry) yield the same key and collapse to one
 * backend operation; any change in the payload yields a new key. `crypto.subtle`
 * exists in both the Worker and modern Node.
 */
async function idempotencyKeyFor(method: string, path: string, body: unknown): Promise<string> {
  const material = `${method} ${path}\n${body === undefined ? '' : JSON.stringify(body)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function buildUrl(baseUrl: string, path: string, query?: ApiRequestOptions['query']): URL {
  const url = new URL(baseUrl.replace(/\/$/, '') + path);
  if (query) {
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(name, String(v));
      }
    }
  }
  return url;
}

/**
 * Issue a request against the BeeL API. Adds bearer auth, a STABLE Idempotency-Key
 * on POST (derived from method+path+body so a retry never duplicates an invoice),
 * and the Beel-Active-Company header when a company is in scope. Errors are mapped to
 * ApiError from the standard `{ success:false, error:{...}, meta:{request_id} }` envelope.
 */
export async function apiRequest(
  config: ResolvedConfig,
  opts: ApiRequestOptions,
): Promise<ApiResult> {
  const method = opts.method.toUpperCase();
  const url = buildUrl(config.baseUrl, opts.path, opts.query);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: 'application/json',
  };
  const hasBody = BODY_METHODS.has(method) && opts.body !== undefined;
  if (hasBody) headers['Content-Type'] = 'application/json';
  // Idempotency-Key STABLE per logical operation, not per HTTP call: an agent that
  // retries "create invoice" must reuse the key or the backend mints a duplicate
  // (VeriFactu = a real fiscal document). A random-per-call key defeated that.
  // Caller may pass an explicit key; else derive it from method+path+body so a
  // byte-identical retry collapses to one operation.
  if (method === 'POST') {
    headers['Idempotency-Key'] =
      opts.idempotencyKey ?? (await idempotencyKeyFor(method, opts.path, opts.body));
  }

  const activeCompany = opts.activeCompany ?? config.activeCompany;
  if (activeCompany) headers['Beel-Active-Company'] = activeCompany;

  const response = await fetch(url, {
    method,
    headers,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text; // non-JSON body (shouldn't happen for the curated tools)
    }
  }

  if (!response.ok) {
    const envelope = (parsed ?? {}) as Record<string, any>;
    const error = envelope.error ?? envelope;
    throw new ApiError(
      error?.message ?? `BeeL API error ${response.status}`,
      response.status,
      error?.code,
      error?.details,
      envelope?.meta?.request_id,
    );
  }

  // Unwrap the success envelope { success, data, meta } to the data payload when present.
  const envelope = parsed as Record<string, unknown> | null;
  const data =
    envelope && typeof envelope === 'object' && 'data' in envelope ? envelope.data : parsed;
  return { status: response.status, data };
}
