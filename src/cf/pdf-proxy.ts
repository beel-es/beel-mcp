/**
 * Presigned-PDF relay for the invoice viewer app.
 *
 * The presigned URL BeeL issues carries a signed `content-disposition=attachment`
 * (not rewritable) and lives on a storage host that differs per deployment. The
 * viewer runs in an opaque-origin sandbox, so it can only paint the document if
 * some same-origin endpoint re-serves those bytes `inline` with CORS. That is all
 * this handler does.
 *
 * Threat model, stated plainly: the presigned URL *is* the capability — the relay
 * grants no access a caller did not already hold, so it is not an authorization
 * boundary and does not try to be one. What it must not become is an open relay
 * for arbitrary hosts, so it forwards only to an explicitly configured allowlist
 * and fails closed when none is configured. No storage host is hardcoded: hosts
 * are deployment infrastructure and belong in `BEEL_PDF_STORAGE_HOSTS`.
 */
import type { Context } from 'hono';
import { ENV_VAR, HTTP_DEFAULTS } from '../shared/defaults.js';
import { readEnvList, type EnvRecord } from '../shared/env.js';
import { appOrigin } from '../mcpapp/contract.js';
import { PDF_RELAY_LIMITS } from './constants.js';

/**
 * The relay reads exactly one variable, so its context is typed by what the
 * shared environment helpers accept rather than by the full binding set.
 */
type RelayContext = Context<{ Bindings: EnvRecord }>;

/** Media types a storage host may legitimately answer a PDF request with. */
const PDF_MEDIA_TYPES = ['application/pdf', 'application/octet-stream'];

/**
 * Hosts this relay may fetch from, from `BEEL_PDF_STORAGE_HOSTS` (comma-separated).
 * Empty by design: with nothing configured the relay is disabled rather than
 * permissive.
 *
 * Entries are matched against the URL's `host`, so they carry a port whenever the
 * storage endpoint listens on a non-default one. An entry may start with `*.` to
 * cover the subdomains of a zone — never the zone itself, and never across a port.
 */
function allowedStorageHosts(env: EnvRecord): Set<string> {
  return new Set(readEnvList(env, ENV_VAR.pdfStorageHosts));
}

/**
 * Whether a URL may be fetched. Compared on `host` and not `hostname` on purpose:
 * `hostname` drops the port, so an allowlist checked against it would authorise
 * every service on the machine, not the storage endpoint that was configured.
 */
function isAllowedTarget(url: URL, allowed: Set<string>): boolean {
  if (url.protocol !== 'https:') return false;
  const host = url.host.toLowerCase();
  if (allowed.has(host)) return true;
  for (const entry of allowed) {
    if (entry.startsWith('*.') && host.endsWith(entry.slice(1))) return true;
  }
  return false;
}

/**
 * Wrap a body stream so it errors once more than `maxBytes` have flowed through
 * it. The client sees the stream break (a truncated download) rather than the
 * relay buffering or forwarding an unbounded response — the size cap holds even
 * when the upstream sends no content-length or an untruthful one.
 */
function capBodyStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(new Error('Document exceeds maximum size'));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return body.pipeThrough(limiter);
}

/** A refusal carrying the status the caller should see, rather than the upstream's. */
class RelayRefusal extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 502,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'RelayRefusal';
  }
}

/**
 * Fetch the document, re-validating every hop.
 *
 * `redirect: 'manual'` is the point of this loop. Left to follow, the allowlist
 * would only cover the FIRST hop: a permitted host answering a 3xx would carry
 * the request to any host and scheme, and the body comes back to the caller with
 * CORS — a readable, unauthenticated relay into wherever that redirect points.
 */
async function fetchThroughAllowlist(target: URL, allowed: Set<string>): Promise<Response> {
  let current = target;
  for (let hop = 0; ; hop++) {
    const response = await fetch(current.href, {
      redirect: 'manual',
      headers: { Accept: PDF_MEDIA_TYPES.join(', ') },
      // No outbound call may outlive the request that started it.
      signal: AbortSignal.timeout(HTTP_DEFAULTS.timeoutMs),
    });
    const location = response.headers.get('location');
    if (!location) return response;
    if (hop >= PDF_RELAY_LIMITS.maxRedirects) throw new RelayRefusal(502, 'Too many redirects');

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new RelayRefusal(502, 'Invalid redirect');
    }
    if (!isAllowedTarget(next, allowed)) throw new RelayRefusal(403, 'Redirect target not allowed');
    current = next;
  }
}

/**
 * What the caller learns about an upstream that did not answer with a document.
 *
 * The upstream status is never forwarded verbatim: it is chosen by the storage
 * host, and passing it through would let that host drive this endpoint's
 * contract — including statuses with header semantics the relay does not honour.
 * Its own trouble is a bad gateway; anything else means the document is not there.
 */
function refusalFor(status: number): RelayRefusal {
  return status >= 500
    ? new RelayRefusal(502, 'Upstream storage error')
    : new RelayRefusal(404, 'Document not available');
}

/**
 * A presigned URL is a bearer capability, so the relay answers only the viewer.
 *
 * The app runs sandboxed with an opaque origin and therefore sends `Origin: null`;
 * a page served from this deployment's own origin sends that. Any other origin
 * gets the bytes without CORS, which means its script cannot read them.
 */
function corsHeaders(requestOrigin: string | undefined, ownOrigin: string): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (requestOrigin !== undefined && (requestOrigin === 'null' || requestOrigin === ownOrigin)) {
    headers['Access-Control-Allow-Origin'] = requestOrigin;
  }
  return headers;
}

/** Re-serve the document inline, with the ceilings this relay enforces. */
function relayedDocument(
  upstream: Response,
  requestOrigin: string | undefined,
  ownOrigin: string,
): Response {
  const type = (upstream.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  // A storage host answering with HTML is an error page or a login redirect that
  // reached 200, not a document; forwarding it as `application/pdf` would hand
  // the viewer a file it cannot read and hide the real failure.
  if (!PDF_MEDIA_TYPES.includes(type)) throw new RelayRefusal(502, 'Upstream is not a document');

  // content-length is only a hint: it may be absent or lie. Reject early when it
  // declares an oversized body, but never trust it as the actual limit — that is
  // enforced byte-by-byte while streaming.
  const declaredLength = Number(upstream.headers.get('content-length') ?? '0');
  if (declaredLength > PDF_RELAY_LIMITS.maxBytes) {
    return new Response('Document too large', { status: 413 });
  }

  const body = upstream.body ? capBodyStream(upstream.body, PDF_RELAY_LIMITS.maxBytes) : null;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(requestOrigin, ownOrigin),
    },
  });
}

export async function pdfProxyHandler(c: RelayContext): Promise<Response> {
  const raw = c.req.query('u');
  if (!raw) return c.text('Missing url', 400);

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return c.text('Invalid url', 400);
  }

  const allowed = allowedStorageHosts(c.env);
  // Fail closed: an unconfigured relay must not forward anywhere.
  if (allowed.size === 0) return c.text('PDF relay is not configured', 503);
  if (!isAllowedTarget(target, allowed)) return c.text('Host not allowed', 403);

  try {
    const upstream = await fetchThroughAllowlist(target, allowed);
    if (!upstream.ok) throw refusalFor(upstream.status);
    return relayedDocument(upstream, c.req.header('Origin'), appOrigin(c.env));
  } catch (error) {
    if (error instanceof RelayRefusal) return c.text(error.detail, error.status);
    return c.text('Upstream fetch failed', 502);
  }
}
