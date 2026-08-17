/**
 * Proxy de PDFs presignados para la MCP App. La presigned viene con
 * `content-disposition=attachment` firmado (no reescribible) y su host de storage
 * cambia por entorno; aquí la buscamos server-side y la RE-servimos `inline` + CORS
 * desde nuestro dominio, para que el visor (sandbox de origen opaco) pueda leer los
 * bytes con fetch(). Guard anti-SSRF: solo hosts de storage conocidos.
 */
import type { Context } from 'hono';

/** Hosts de storage que el proxy puede buscar. Override: BEEL_PDF_STORAGE_HOSTS (coma). */
const DEFAULT_STORAGE_HOSTS = [
  'bucket-production-f776.up.railway.app',
  'storage.beel.es',
  'minio.beel.es',
  'app.beel.es',
];

function storageHosts(env: Record<string, unknown>): Set<string> {
  const raw = typeof env.BEEL_PDF_STORAGE_HOSTS === 'string' ? env.BEEL_PDF_STORAGE_HOSTS : '';
  const fromEnv = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set(fromEnv.length > 0 ? fromEnv : DEFAULT_STORAGE_HOSTS);
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
  const allowed = storageHosts(c.env as Record<string, unknown>);
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
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // El visor corre en un sandbox de origen opaco: sin CORS no puede leer los
      // bytes con fetch() para pintarlos. GET simple → sin preflight.
      'Access-Control-Allow-Origin': '*',
    },
  });
}
