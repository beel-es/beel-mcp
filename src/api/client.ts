import type { ResolvedConfig } from '../config.js';
import { ContentType, HttpHeader, bearerAuthHeader } from '../shared/http.js';
import { BEEL_HEADER, ENV_VAR, HTTP_DEFAULTS } from '../shared/defaults.js';
import { ambientEnv, readEnvInt } from '../shared/env.js';
import { isRecord, readString } from '../shared/guards.js';
import { FetchTimeoutError, fetchWithTimeout } from '../shared/fetch.js';

/** A normalised API error carrying BeeL's error envelope fields. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
    readonly requestId?: string,
    /**
     * The RFC 9457 `type` URI from the error envelope: a stable link to the
     * documentation page for this exact code. The API hands it to us on every
     * error, so relaying it beats anything we could write locally — the docs
     * cover every code and are maintained alongside the API.
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
  /**
   * Header parameter names the operation declares in the contract. The
   * `Idempotency-Key` header is sent only when it appears here: an operation
   * whose contract does not document it may reject the request outright, and
   * every header we invent is a header the API never promised to honour.
   */
  declaredHeaders?: readonly string[];
}

export interface ApiResult {
  status: number;
  /** Parsed JSON payload (or null for 204 / empty). */
  data: unknown;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Methods that change state, so a blind repeat can apply twice. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Transient conditions worth one more attempt on a safe request.
 *
 * 502 and 504 are ambiguous by nature: the gateway does not know whether the
 * origin applied the request before the connection broke. They are only
 * retryable when the repeat is guaranteed to collapse into the same operation.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Statuses that carry a promise the request was NOT applied: the caller was
 * throttled (429) or the service refused to accept work (503). Safe to repeat
 * for any method, with or without an idempotency key.
 */
const UNAPPLIED_STATUSES = new Set([429, 503]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a response may be retried.
 *
 * The invariant: a mutation is repeated only when repeating it cannot apply it
 * twice — either because the status says it was never applied, or because an
 * Idempotency-Key makes the second attempt resolve to the first operation. For
 * VeriFactu a double application is a second real fiscal document.
 */
function isRetryable(method: string, status: number, hasIdempotencyKey: boolean): boolean {
  if (!RETRYABLE_STATUSES.has(status)) return false;
  if (!MUTATING_METHODS.has(method)) return true;
  return hasIdempotencyKey || UNAPPLIED_STATUSES.has(status);
}

/**
 * Honour `Retry-After` when the server sends one (seconds or an HTTP date),
 * otherwise back off exponentially. Capped so a tool call cannot stall a session.
 */
function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, HTTP_DEFAULTS.timeoutMs);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), HTTP_DEFAULTS.timeoutMs);
  }
  return HTTP_DEFAULTS.retryBaseDelayMs * 2 ** attempt;
}

/**
 * Deterministic idempotency key for a mutating call: SHA-256 over the full
 * request — method, path, canonicalised query and body.
 *
 * Two byte-identical requests — an agent retrying — yield the same key and
 * collapse into one backend operation, which for VeriFactu means one fiscal
 * document rather than two.
 *
 * The query string is part of the material, and must be: several operations
 * change meaning through it. `POST …/customers/bulk?dry_run=true` and the same
 * call with `dry_run=false` carry an identical body, so leaving the query out
 * gives them the same key — the backend replays the dry run, nothing is created,
 * and the agent is told it succeeded. Query order is not significant in HTTP, so
 * the parameters are sorted before hashing; otherwise the same request could
 * hash two ways and defeat the deduplication it exists for.
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

function declaresHeader(declared: readonly string[] | undefined, name: string): boolean {
  return (declared ?? []).some((header) => header.toLowerCase() === name.toLowerCase());
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

async function buildHeaders(
  config: ResolvedConfig,
  method: string,
  opts: ApiRequestOptions,
  hasBody: boolean,
  sendsIdempotencyKey: boolean,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    [HttpHeader.Authorization]: bearerAuthHeader(config.apiKey),
    [HttpHeader.Accept]: ContentType.Json,
  };
  if (hasBody) headers[HttpHeader.ContentType] = ContentType.Json;
  // Stable per logical operation, not per HTTP call: an agent that retries
  // "create invoice" must reuse the key or the backend mints a second fiscal
  // document. The caller may pass an explicit key when a repeat is intentional.
  if (sendsIdempotencyKey) {
    headers[BEEL_HEADER.idempotencyKey] =
      opts.idempotencyKey ?? (await idempotencyKeyFor(method, opts.path, opts.query, opts.body));
  }
  return headers;
}

/** The fields of the contract's `ErrorResponse`, once each has been type-checked. */
export interface ErrorEnvelope {
  message?: string;
  code?: string;
  details?: unknown;
  requestId?: string;
  /** RFC 9457 `type`: the documentation URI for this problem type. */
  docsUrl?: string;
}

/**
 * Read the contract's `ErrorResponse` (components/schemas/ErrorResponse).
 *
 * The payload carries two contracts at once and they are not nested the same
 * way: `code`, `message` and `details` live under `error` (ErrorDetail), the
 * request id under `meta`, and the documentation URI at the top level as the
 * RFC 9457 `type`. Reading any of them at the wrong depth yields `undefined`
 * silently, so each one is taken from exactly where the schema puts it.
 *
 * Every field is optional here even though the schema requires `success` and
 * `error`: an error response is precisely the situation in which the body may
 * not match its own contract (a gateway 502, an HTML error page).
 */
export function parseErrorEnvelope(payload: unknown): ErrorEnvelope {
  if (!isRecord(payload)) return {};
  const error = isRecord(payload.error) ? payload.error : undefined;
  return {
    message: readString(error, 'message') ?? readString(payload, 'detail'),
    code: readString(error, 'code') ?? readString(payload, 'title'),
    details: error?.details,
    requestId: readString(payload.meta, 'request_id'),
    docsUrl: readString(payload, 'type'),
  };
}

/**
 * Issue a request against the BeeL API.
 *
 * Adds bearer auth and — only for operations whose contract declares the header
 * — a stable `Idempotency-Key` derived from method+path+query+body, so a retry
 * never duplicates an invoice. Errors are mapped to {@link ApiError} through the
 * contract's `ErrorResponse` envelope.
 */
export async function apiRequest(
  config: ResolvedConfig,
  opts: ApiRequestOptions,
): Promise<ApiResult> {
  const method = opts.method.toUpperCase();
  const url = buildUrl(config.baseUrl, opts.path, opts.query);

  const hasBody = BODY_METHODS.has(method) && opts.body !== undefined;
  const sendsIdempotencyKey = declaresHeader(opts.declaredHeaders, BEEL_HEADER.idempotencyKey);
  const headers = await buildHeaders(config, method, opts, hasBody, sendsIdempotencyKey);

  const timeoutMs = readEnvInt(ambientEnv(), ENV_VAR.requestTimeoutMs, HTTP_DEFAULTS.timeoutMs);
  const init: RequestInit = {
    method,
    headers,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  };

  const send = async (): Promise<Response> => {
    try {
      return await fetchWithTimeout(url, init, timeoutMs);
    } catch (err) {
      if (err instanceof FetchTimeoutError) {
        throw new ApiError(
          `BeeL API request timed out after ${timeoutMs} ms`,
          504,
          'request_timeout',
        );
      }
      throw err;
    }
  };

  let response = await send();
  for (
    let attempt = 0;
    attempt < HTTP_DEFAULTS.maxRetries && isRetryable(method, response.status, sendsIdempotencyKey);
    attempt++
  ) {
    await sleep(retryDelayMs(response, attempt));
    response = await send();
  }

  return readResult(response);
}

async function readResult(response: Response): Promise<ApiResult> {
  const text = await response.text();

  if (!text) {
    if (response.ok) return { status: response.status, data: null };
    throw new ApiError(`BeeL API error ${response.status}`, response.status);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A body we cannot read is not a result. Returning the raw text would hand
    // the model an HTML error page as if it were the operation's payload.
    if (response.ok) {
      throw new ApiError(
        `BeeL API returned a non-JSON body (${response.headers.get('content-type') ?? 'no content-type'}) ` +
          `for a ${response.status} response`,
        response.status,
        'unexpected_content_type',
      );
    }
    throw new ApiError(`BeeL API error ${response.status}`, response.status);
  }

  if (!response.ok) {
    const envelope = parseErrorEnvelope(parsed);
    throw new ApiError(
      envelope.message ?? `BeeL API error ${response.status}`,
      response.status,
      envelope.code,
      envelope.details,
      envelope.requestId,
      envelope.docsUrl,
    );
  }

  // Unwrap the success envelope { success, data, meta } to the data payload when present.
  const data = isRecord(parsed) && 'data' in parsed ? parsed.data : parsed;
  return { status: response.status, data };
}
