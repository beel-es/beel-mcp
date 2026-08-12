import type { OperationSpec } from '../spec/manifest.js';

/**
 * Curated policy that decides which OpenAPI operations become MCP tools.
 *
 * Not every endpoint makes sense for an LLM agent. We *exclude by rule* the
 * operation classes that an agent cannot use or shouldn't drive:
 *
 *  - binary downloads (PDF preview, bulk ZIP, Excel/CSV export) — an agent can't
 *    consume raw bytes; the JSON variants (e.g. a PDF *URL* endpoint) stay in.
 *  - multipart uploads (CSV/Holded import, signed-PDF submission) — file I/O
 *    that belongs to a human/UI flow, not a chat agent.
 *  - webhook infrastructure — subscription/delivery plumbing the agent neither
 *    receives nor operates.
 *
 * Everything else is included. The rules are data-driven and testable; explicit
 * per-operation overrides exist as an escape hatch but should stay near-empty.
 */

export type ExclusionReason =
  | 'binary-response'
  | 'multipart-upload'
  | 'webhook-infrastructure'
  | 'deprecated'
  | 'explicitly-excluded';

export interface PolicyOptions {
  /** Tags whose operations are excluded wholesale. */
  excludedTags?: Set<string>;
  /** operationIds force-excluded regardless of other rules. */
  excludedOperationIds?: Set<string>;
  /** operationIds force-included even if a rule would exclude them. */
  includedOperationIds?: Set<string>;
}

export const DEFAULT_EXCLUDED_TAGS = new Set(['Webhooks']);

/** Reserved: JSON operations that are technically callable but not agent-appropriate. */
export const DEFAULT_EXCLUDED_OPERATION_IDS = new Set<string>();

export interface PolicyResult {
  tools: OperationSpec[];
  excluded: Array<{ op: OperationSpec; reason: ExclusionReason }>;
}

function classify(op: OperationSpec, opts: Required<PolicyOptions>): ExclusionReason | null {
  if (opts.includedOperationIds.has(op.operationId)) return null;
  if (opts.excludedOperationIds.has(op.operationId)) return 'explicitly-excluded';
  if (opts.excludedTags.has(op.tag)) return 'webhook-infrastructure';
  if (op.deprecated) return 'deprecated';
  if (op.binaryResponse) return 'binary-response';
  if (op.requestBody && op.requestBody.contentType.includes('multipart')) return 'multipart-upload';
  return null;
}

/**
 * Scopes an agent actually needs: the union of OAuth2 scopes across the tools the
 * policy exposes. Least privilege — the consent screen then never asks for a scope
 * no tool uses (e.g. webhooks, excluded as infrastructure) nor omits one it does.
 */
export function requiredScopes(operations: OperationSpec[]): string[] {
  const { tools } = applyToolPolicy(operations);
  const scopes = new Set<string>();
  for (const tool of tools) for (const scope of tool.scopes) scopes.add(scope);
  return [...scopes].sort();
}

export function applyToolPolicy(
  operations: OperationSpec[],
  options: PolicyOptions = {},
): PolicyResult {
  const opts: Required<PolicyOptions> = {
    excludedTags: options.excludedTags ?? DEFAULT_EXCLUDED_TAGS,
    excludedOperationIds: options.excludedOperationIds ?? DEFAULT_EXCLUDED_OPERATION_IDS,
    includedOperationIds: options.includedOperationIds ?? new Set(),
  };

  const tools: OperationSpec[] = [];
  const excluded: PolicyResult['excluded'] = [];

  for (const op of operations) {
    const reason = classify(op, opts);
    if (reason) excluded.push({ op, reason });
    else tools.push(op);
  }

  return { tools, excluded };
}
