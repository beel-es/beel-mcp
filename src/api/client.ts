import type { ResolvedConfig } from '../config.js';
import { ContentType, HttpHeader, bearerAuthHeader } from '../shared/http.js';
import { BEEL_HEADER, ENV_VAR, HTTP_DEFAULTS } from '../shared/defaults.js';
import { ambientEnv, readEnvInt } from '../shared/env.js';

/** A normalised API error carrying BeeL's error envelope fields. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
    readonly requestId?: string,
    /**
     * The RFC 7807 `type` URI from the error envelope: a stable link to the
     * documentation page for this exact code. The API hands it to us on every
     * error, so relaying it beats anything we could write locally — the docs
     * cover ~357 codes and are maintained alongside the API.
     */
    readonly docsUrl?: string,
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
  /** Explicit idempotency key; when absent it is derived from method+path+body. */
  idempotencyKey?: string;
}

export interface ApiResult {
  status: number;
  /** Parsed JSON payload (or null for 204 / empty). */
  data: unknown;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Transient upstream conditions worth one more attempt. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Honour `Retry-After` when the server sends one (seconds or an HTTP date),
 * otherwise back off exponentially. Capped so a tool call cannot stall a session.
 */
function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, HTTP_DEFAULTS.timeoutMs);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), HTTP_DEFAULTS.timeoutMs);
  }
  return HTTP_DEFAULTS.retryBaseDelayMs * 2 ** attempt;
}

/**
 * `fetch` with a hard deadline. Without it an unresponsive upstream hangs the
 * tool call forever: MCP has no timeout of its own, so the client just waits.
 */
async function fetchWithTimeout(url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ApiError(`BeeL API request timed out after ${timeoutMs} ms`, 504, 'request_timeout');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deterministic idempotency key for a mutating call: SHA-256 over the full
 * request — method, path, canonicalised query and body.
 *
 * Two byte-identical POSTs — an agent retrying — yield the same key and collapse
 * into one backend operation, which for VeriFactu means one fiscal document
 * rather than two.
 *
 * The query string is part of the material, and must be: several POSTs change
 * meaning through it. `POST …/customers/bulk?dry_run=true` and the same call
 * with `dry_run=false` carry an identical body, so leaving the query out gives
 * them the same key — the backend replays the dry run, nothing is created, and
 * the agent is told it succeeded. Query order is not significant in HTTP, so the
 * parameters are sorted before hashing; otherwise the same request could hash
 * two ways and defeat the deduplication it exists for.
 */
function canonicalQuery(query: ApiRequestOptions['query']): string {
  if (!query) return '';
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) pairs.push([name, String(v)]);
  }
  pairs.sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

async function idempotencyKeyFor(
  method: string,
  path: string,
  query: ApiRequestOptions['query'],
  body: unknown,
): Promise<string> {
  const material =
    `${method} ${path}?${canonicalQuery(query)}\n` +
    `${body === undefined ? '' : JSON.stringify(body)}`;
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
 * Issue a request against the BeeL API. Adds bearer auth and a STABLE
 * Idempotency-Key on POST (derived from method+path+body, so a retry never
 * duplicates an invoice). Errors are mapped to ApiError from the standard
 * `{ success:false, error:{...}, meta:{request_id} }` envelope.
 */
export async function apiRequest(
  config: ResolvedConfig,
  opts: ApiRequestOptions,
): Promise<ApiResult> {
  const method = opts.method.toUpperCase();
  const url = buildUrl(config.baseUrl, opts.path, opts.query);

  const headers: Record<string, string> = {
    [HttpHeader.Authorization]: bearerAuthHeader(config.apiKey),
    [HttpHeader.Accept]: ContentType.Json,
  };
  const hasBody = BODY_METHODS.has(method) && opts.body !== undefined;
  if (hasBody) headers[HttpHeader.ContentType] = ContentType.Json;
  // Idempotency-Key STABLE per logical operation, not per HTTP call: an agent that
  // retries "create invoice" must reuse the key or the backend mints a duplicate
  // (VeriFactu = a real fiscal document). A random-per-call key defeated that.
  // Caller may pass an explicit key; else derive it from method+path+body so a
  // byte-identical retry collapses to one operation.
  if (method === 'POST') {
    headers[BEEL_HEADER.idempotencyKey] =
      opts.idempotencyKey ?? (await idempotencyKeyFor(method, opts.path, opts.query, opts.body));
  }

  const timeoutMs = readEnvInt(ambientEnv(), ENV_VAR.requestTimeoutMs, HTTP_DEFAULTS.timeoutMs);
  const init: RequestInit = {
    method,
    headers,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  };

  // Retrying is safe for every method here: GET/PUT/DELETE are idempotent by HTTP
  // semantics, and POST carries the stable Idempotency-Key set above, so a repeat
  // collapses into the same backend operation rather than a second invoice.
  let response = await fetchWithTimeout(url, init, timeoutMs);
  for (let attempt = 0; attempt < HTTP_DEFAULTS.maxRetries && RETRYABLE_STATUSES.has(response.status); attempt++) {
    await sleep(retryDelayMs(response, attempt));
    response = await fetchWithTimeout(url, init, timeoutMs);
  }

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
      typeof envelope?.type === 'string' ? envelope.type : undefined,
    );
  }

  // Unwrap the success envelope { success, data, meta } to the data payload when present.
  const envelope = parsed as Record<string, unknown> | null;
  const data =
    envelope && typeof envelope === 'object' && 'data' in envelope ? envelope.data : parsed;
  return { status: response.status, data };
}
