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
import { ambientEnv, readEnvInt } from '../shared/env.js';

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

async function buildInvoicePdfResult(data: unknown): Promise<CallToolResult | null> {
  const appData = invoicePdfAppData(data);
  if (!appData) return null;
  const fileName = appData.file_name ?? 'invoice.pdf';

  const content: CallToolResult['content'] = [];
  const pdf = await fetchAsBase64(appData.download_url);
  if (pdf) {
    content.push({
      type: 'resource',
      resource: { uri: `beel://invoice/${fileName}`, mimeType: 'application/pdf', blob: pdf },
    });
  }
  content.push({
    type: 'text',
    text: pdf
      ? `Invoice ${fileName}: interactive viewer above, PDF attached to open or download.`
      : `Invoice ${fileName}. The PDF could not be attached; it is still downloadable from ` +
        `the link in the structured result.`,
  });

  return { content, structuredContent: appData as unknown as Record<string, unknown> };
}

/**
 * Fetch a URL and return it base64-encoded; `null` on any failure.
 *
 * Deliberately bounded on both axes. The presigned URL points at object storage
 * rather than the API, so it has none of the API client's protections: without a
 * deadline a stalled download would hang the whole tool call, and without a size
 * cap a large document would be read entirely into memory and then grown by a
 * third. Failure is not fatal — the caller still returns the viewer and the link.
 */
async function fetchAsBase64(url: string): Promise<string | null> {
  const timeoutMs = readEnvInt(ambientEnv(), ENV_VAR.requestTimeoutMs, HTTP_DEFAULTS.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;

    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_ATTACHMENT_BYTES) return null;

    const buffer = await response.arrayBuffer();
    // Re-check: content-length is a hint, and may be absent or wrong.
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) return null;

    return base64(buffer);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** ArrayBuffer → base64 in chunks (`btoa` with a spread overflows on large buffers). */
function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
