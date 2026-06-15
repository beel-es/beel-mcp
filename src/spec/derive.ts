/**
 * Naming helpers: turn an OpenAPI `operationId` into a stable MCP tool name.
 *
 * MCP tool names live in a flat namespace, so we don't split into command
 * groups like the CLI does. We prefix every spec-derived tool with `beel_` and
 * snake_case the operationId. operationIds are unique in the spec, so the
 * resulting tool names are unique by construction — no collision handling needed.
 */

const TOOL_PREFIX = 'beel_';

/** "downloadInvoicesPdfBulk" -> ["download", "invoices", "pdf", "bulk"] */
export function words(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** "createInvoice" -> "create_invoice" */
export function snakeCase(id: string): string {
  return words(id).join('_');
}

/** "createInvoice" -> "beel_create_invoice" */
export function toolName(operationId: string): string {
  return TOOL_PREFIX + snakeCase(operationId);
}

/** Extract `{path_params}` from a path template, in order. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}
