/**
 * Naming: turn an OpenAPI `operationId` into a stable MCP tool name.
 *
 * MCP tool names live in a flat namespace, so every spec-derived tool is
 * prefixed with `beel_` and the operationId is snake_cased. operationIds are
 * unique in the contract, so the result is unique by construction — but not
 * automatically *short*, which matters: some MCP hosts and portals prepend
 * their own server and connector names, and warn beyond 40 characters. A name
 * that gets truncated or rejected is a tool the model cannot call at all.
 *
 * Two shortenings are unconditional, because they make names *better* as well
 * as shorter. The third costs a little clarity, so it applies only to the names
 * that would otherwise not fit. Every step is a deterministic function of the
 * operationId alone: a given operation always yields the same name, whatever
 * else the contract contains.
 */

const TOOL_PREFIX = 'beel_';

/**
 * The ceiling a tool name must respect. The protocol itself is more permissive;
 * this is the tightest limit reported by a host, and being under it costs
 * nothing.
 */
export const MAX_TOOL_NAME_LENGTH = 40;

/**
 * Words that say which resource owns the operation, not what it does.
 *
 * Every operation is scoped by a `company_id` or an `account_id` in its path,
 * and the tool's own input schema requires it — so repeating it in the name
 * distinguishes nothing. The flat, unscoped variants that would have collided
 * are excluded by policy for being deprecated.
 */
const SCOPE_WORDS = new Set(['company', 'account']);

/** "downloadInvoicesPdfBulk" -> ["download", "invoices", "pdf", "bulk"] */
export function words(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * "VeriFactu" is one word. The camelCase splitter cannot know that, so it
 * arrives as two — a spelling that appears nowhere in the regulation or the
 * documentation. Rejoining it is a correction, applied regardless of length.
 */
function joinDomainTerms(parts: string[]): string[] {
  const out: string[] = [];
  for (const word of parts) {
    if (word === 'factu' && out.at(-1) === 'veri') out[out.length - 1] = 'verifactu';
    else out.push(word);
  }
  return out;
}

/** Drop the owning resource, unless doing so would leave only the verb. */
function dropScope(parts: string[]): string[] {
  const kept = parts.filter((w) => !SCOPE_WORDS.has(w));
  return kept.length >= 2 ? kept : parts;
}

/**
 * "recurring invoice" is a single concept in this API, and "recurring" carries
 * it unambiguously — there is nothing else recurring here. Only worth the loss
 * when a name would otherwise be too long.
 */
function collapseRecurringInvoice(parts: string[]): string[] {
  return parts.filter((w, i) => !(w === 'invoice' && parts[i - 1] === 'recurring'));
}

/** "createCompanyInvoice" -> "create_invoice" */
export function snakeCase(id: string): string {
  // Unconditional: dropping the owning resource is applied to every name, even
  // ones that would fit without it. Doing it only where needed would leave
  // sibling operations named inconsistently — `get_company_verifactu_config`
  // beside `update_verifactu_config` — which is worse for a model to reason
  // about than either name is on its own.
  const base = dropScope(joinDomainTerms(words(id)));

  const full = base.join('_');
  if (TOOL_PREFIX.length + full.length <= MAX_TOOL_NAME_LENGTH) return full;

  // Only for the few that still do not fit, since it costs a word of meaning.
  return collapseRecurringInvoice(base).join('_');
}

/** "createCompanyInvoice" -> "beel_create_invoice" */
export function toolName(operationId: string): string {
  return TOOL_PREFIX + snakeCase(operationId);
}

/** Extract `{path_params}` from a path template, in order. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}
