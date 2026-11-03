import type { OperationSpec } from '../spec/manifest.js';

/**
 * Curated policy that decides which OpenAPI operations become MCP tools.
 *
 * Not every endpoint makes sense for an LLM agent. We *exclude by rule* the
 * operation classes that an agent cannot use or shouldn't drive:
 *
 *  - binary downloads (PDF preview, bulk ZIP, Excel/CSV export) — an agent can't
 *    consume raw bytes; the JSON variants (e.g. a PDF *URL* endpoint) stay in.
 *  - multipart uploads (Holded import, signed-PDF submission, logo) — binary
 *    file I/O that belongs to a human/UI flow, not a chat agent. The CSV imports
 *    in `TEXT_UPLOAD_OPERATION_IDS` are the exception: a CSV is text an agent
 *    can write, so the tool takes it as a string and the client builds the
 *    multipart request.
 *  - excluded tags — whole families the agent neither receives nor operates,
 *    such as webhook subscription and delivery plumbing.
 *  - session-only operations — those whose `security` does not offer
 *    `ApiKeyAuth`. This server authenticates with an API key and nothing else,
 *    so such a tool could only ever answer 401.
 *
 * Everything else is included. The rules are data-driven and testable; explicit
 * per-operation overrides exist as an escape hatch but should stay near-empty.
 */

import { API_KEY_SECURITY_SCHEME } from '../shared/defaults.js';

/**
 * Why an operation is not a tool. A tag exclusion names the tag it matched:
 * one reason standing for every excluded family would misreport the next tag
 * added to `DEFAULT_EXCLUDED_TAGS`.
 */
export type ExclusionReason =
  | 'binary-response'
  | 'multipart-upload'
  | 'session-only'
  | 'deprecated'
  | 'explicitly-excluded'
  | `excluded-tag:${string}`;

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

/**
 * Multipart operations whose file parts are CSV, so the agent can send their
 * content as text. Any other multipart upload (images, signed PDFs, xlsx) stays
 * excluded: its bytes do not survive a round trip through a text argument.
 */
export const TEXT_UPLOAD_OPERATION_IDS = new Set([
  'previewAccountImport',
  'createAccountImport',
  'previewCompanyCustomerImport',
  'createCompanyCustomerImport',
]);

export interface PolicyResult {
  tools: OperationSpec[];
  excluded: Array<{ op: OperationSpec; reason: ExclusionReason }>;
}

function classify(op: OperationSpec, opts: Required<PolicyOptions>): ExclusionReason | null {
  if (opts.includedOperationIds.has(op.operationId)) return null;
  if (opts.excludedOperationIds.has(op.operationId)) return 'explicitly-excluded';
  const excludedTag = op.tags.find((tag) => opts.excludedTags.has(tag));
  if (excludedTag) return `excluded-tag:${excludedTag}`;
  if (op.deprecated) return 'deprecated';
  if (op.binaryResponse) return 'binary-response';
  if (
    op.requestBody?.contentType.includes('multipart') &&
    !TEXT_UPLOAD_OPERATION_IDS.has(op.operationId)
  )
    return 'multipart-upload';
  if (!op.securitySchemes.includes(API_KEY_SECURITY_SCHEME)) return 'session-only';
  return null;
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
