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
import { ENV_VAR } from '../shared/defaults.js';
import { readEnvList, type EnvRecord } from '../shared/env.js';

/** Refuse to stream anything larger than a plausible invoice PDF. */
const MAX_BYTES = 25 * 1024 * 1024;

/** Presigned URLs redirect at most once or twice; more suggests a loop. */
const MAX_REDIRECTS = 3;

/**
 * Hosts this relay may fetch from, from `BEEL_PDF_STORAGE_HOSTS` (comma-separated).
 * Empty by design: with nothing configured the relay is disabled rather than
 * permissive.
 */
function allowedStorageHosts(env: EnvRecord): Set<string> {
  return new Set(readEnvList(env, ENV_VAR.pdfStorageHosts));
}

/**
 * Wrap a body stream so it errors once more than `maxBytes` have flowed through
 * it. The client sees the stream break (a truncated download) rather than the
 * relay buffering or forwarding an unbounded response — the size cap holds even
 * when the upstream sends no content-length or an untruthful one.
 */
function capBodyStream(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pdfProxyHandler(c: Context<{ Bindings: any }>): Promise<Response> {
  const raw = c.req.query('u');
  if (!raw) return c.text('Missing url', 400);

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return c.text('Invalid url', 400);
  }

  const allowed = allowedStorageHosts(c.env as EnvRecord);
  if (allowed.size === 0) {
    // Fail closed: an unconfigured relay must not forward anywhere.
    return c.text('PDF relay is not configured', 503);
  }
  if (target.protocol !== 'https:' || !allowed.has(target.hostname.toLowerCase())) {
    return c.text('Host not allowed', 403);
  }

  // `redirect: 'manual'` is the point of this block. Left to follow, the
  // allowlist would only cover the FIRST hop: a permitted host answering a 3xx
  // would carry the request to any host and scheme, and the body comes back to
  // the caller with open CORS — a readable, unauthenticated relay into wherever
  // that redirect points. Each hop is re-validated instead.
  let upstream: Response;
  let current = target;
  try {
    for (let hop = 0; ; hop++) {
      upstream = await fetch(current.href, { redirect: 'manual' });
      const location = upstream.headers.get('location');
      if (!location) break;
      if (hop >= MAX_REDIRECTS) return c.text('Too many redirects', 502);

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return c.text('Invalid redirect', 502);
      }
      if (next.protocol !== 'https:' || !allowed.has(next.hostname.toLowerCase())) {
        return c.text('Redirect target not allowed', 403);
      }
      current = next;
    }
  } catch {
    return c.text('Upstream fetch failed', 502);
  }
  if (!upstream.ok) {
    return c.text(`Upstream ${upstream.status}`, upstream.status as 400);
  }

  // content-length is only a hint: it may be absent or lie. Reject early when it
  // declares an oversized body, but never trust it as the actual limit — that is
  // enforced byte-by-byte while streaming below.
  const declaredLength = Number(upstream.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BYTES) {
    return c.text('Document too large', 413);
  }

  // Enforce the ceiling on the bytes that actually arrive, not on the declared
  // length: a response with no (or a lying) content-length would otherwise stream
  // unbounded through the relay. The counter aborts the stream once the cap is
  // crossed, so an oversized or endless upstream cannot exhaust the Worker.
  const body = upstream.body ? capBodyStream(upstream.body, MAX_BYTES) : null;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // The viewer runs in an opaque-origin sandbox: without CORS it cannot read
      // the bytes with fetch() to paint them. Simple GET → no preflight.
      'Access-Control-Allow-Origin': '*',
    },
  });
}
