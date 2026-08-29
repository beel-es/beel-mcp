/**
 * Result enrichers: turn an operation's raw API payload into a richer
 * `CallToolResult` — structured data for an MCP App, plus attachments.
 *
 * One entry per operation in {@link RESULT_ENRICHERS}, so the call handler does a
 * single lookup and adding a case never touches it.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { invoicePdfAppData } from '../mcpapp/binding.js';
import { INVOICE_PDF_OPERATION } from '../mcpapp/contract.js';
import { ENV_VAR, HTTP_DEFAULTS } from '../shared/defaults.js';
import { ambientEnv, readEnvInt, readEnvList, type EnvRecord } from '../shared/env.js';
import { fetchWithTimeout, readBoundedArrayBuffer } from '../shared/fetch.js';

/** Turns a tool payload into a CallToolResult; `null` falls back to plain JSON. */
export type ResultEnricher = (data: unknown) => Promise<CallToolResult | null>;

/** operationId → enricher. The single point of registration. */
export const RESULT_ENRICHERS: Record<string, ResultEnricher> = {
  [INVOICE_PDF_OPERATION]: buildInvoicePdfResult,
};

/** Apply the enricher for an operationId, or `null` when there is none. */
export async function enrichToolResult(
  operationId: string | undefined,
  data: unknown,
): Promise<CallToolResult | null> {
  const enricher = operationId ? RESULT_ENRICHERS[operationId] : undefined;
  return enricher ? enricher(data) : null;
}

// ---------------------------------------------------------------------------
// Invoice PDF: the result feeds the MCP App viewer (through structuredContent)
// and attaches the PDF itself as an `application/pdf` resource, so hosts without
// MCP Apps can still open or download it. The tool↔app binding is declared in
// api-tools (_meta.ui.resourceUri); this only supplies the data and the file.
// ---------------------------------------------------------------------------

/**
 * Ceiling on an attached PDF, before base64. Base64 inflates by a third and the
 * result travels in the tool response, so an unbounded attachment would spend
 * the model's context on bytes it cannot read. Past this the viewer and the
 * download link still work — only the inline copy is dropped.
 */
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;

/**
 * Hosts the attachment may be fetched from, from `BEEL_PDF_STORAGE_HOSTS`.
 *
 * The URL comes out of an API payload, so fetching it unconditionally makes this
 * server a fetcher of whatever that payload names. Empty by design: with nothing
 * configured no attachment is fetched, and the model still receives the link.
 * No storage host is hardcoded — hosts are deployment configuration.
 */
function allowedStorageHosts(env: EnvRecord): Set<string> {
  return new Set(readEnvList(env, ENV_VAR.pdfStorageHosts));
}

/** Why an attachment was not fetched, or the bytes themselves. */
type Attachment = { ok: true; base64: string } | { ok: false; reason: string };

async function buildInvoicePdfResult(data: unknown): Promise<CallToolResult | null> {
  const appData = invoicePdfAppData(data);
  if (!appData) return null;
  const fileName = appData.file_name ?? 'invoice.pdf';

  const content: CallToolResult['content'] = [];
  const pdf = await fetchAsBase64(appData.download_url);
  if (pdf.ok) {
    content.push({
      type: 'resource',
      resource: {
        uri: `beel://invoice/${fileName}`,
        mimeType: 'application/pdf',
        blob: pdf.base64,
      },
    });
  }
  content.push({
    type: 'text',
    text: pdf.ok
      ? `Invoice ${fileName}: interactive viewer above, PDF attached to open or download.`
      : `Invoice ${fileName}. The PDF was not attached (${pdf.reason}); it is still ` +
        `downloadable from the link in the structured result.`,
  });

  // `invoicePdfAppData` returns the app's own declared contract type; the SDK
  // types structuredContent as an open record.
  return { content, structuredContent: appData as unknown as Record<string, unknown> };
}

/**
 * Fetch the document and return it base64-encoded.
 *
 * Bounded on three axes. The presigned URL points at object storage rather than
 * the API, so it has none of the API client's protections: without an allow-list
 * the host is chosen by the payload, without a deadline a stalled download
 * suspends the whole tool call, and without a size cap a large document is read
 * into memory and then grown by a third. A refusal is never fatal and never
 * silent — the caller states why and still returns the viewer and the link.
 */
async function fetchAsBase64(url: string, env: EnvRecord = ambientEnv()): Promise<Attachment> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, reason: 'the download URL is not a valid URL' };
  }
  const allowed = allowedStorageHosts(env);
  if (allowed.size === 0) {
    return { ok: false, reason: `no storage host is allow-listed in ${ENV_VAR.pdfStorageHosts}` };
  }
  if (target.protocol !== 'https:' || !allowed.has(target.hostname.toLowerCase())) {
    return { ok: false, reason: `${target.hostname} is not an allow-listed https storage host` };
  }

  const timeoutMs = readEnvInt(env, ENV_VAR.requestTimeoutMs, HTTP_DEFAULTS.timeoutMs);
  try {
    const response = await fetchWithTimeout(target, { redirect: 'error' }, timeoutMs);
    if (!response.ok) return { ok: false, reason: `storage answered HTTP ${response.status}` };
    return {
      ok: true,
      base64: base64(await readBoundedArrayBuffer(response, MAX_ATTACHMENT_BYTES)),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** ArrayBuffer -> base64 in chunks (`btoa` with a spread overflows on large buffers). */
function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
