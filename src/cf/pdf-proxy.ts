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

/**
 * Hosts this relay may fetch from, from `BEEL_PDF_STORAGE_HOSTS` (comma-separated).
 * Empty by design: with nothing configured the relay is disabled rather than
 * permissive.
 */
function allowedStorageHosts(env: EnvRecord): Set<string> {
  return new Set(readEnvList(env, ENV_VAR.pdfStorageHosts));
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

  let upstream: Response;
  try {
    upstream = await fetch(target.href);
  } catch {
    return c.text('Upstream fetch failed', 502);
  }
  if (!upstream.ok) {
    return c.text(`Upstream ${upstream.status}`, upstream.status as 400);
  }

  const declaredLength = Number(upstream.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BYTES) {
    return c.text('Document too large', 413);
  }

  return new Response(upstream.body, {
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
