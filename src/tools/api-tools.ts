import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ResolvedConfig } from '../config.js';
import { apiRequest } from '../api/client.js';
import { loadSpec } from '../spec/load.js';
import { buildManifest, type OperationSpec } from '../spec/manifest.js';
import { buildInputSchema } from '../spec/json-schema.js';
import { toolName } from '../spec/derive.js';
import { applyToolPolicy, type PolicyResult } from '../policy/tool-policy.js';
import { annotationsFor } from '../policy/annotations.js';
import { describeTool } from '../guardrails/enrich.js';
import { APP_BINDINGS } from '../mcpapp/binding.js';
import { assertNoViolations } from '../guardrails/validate.js';
import { ArgumentError } from './validate-args.js';

/** A registered API tool: its MCP definition plus the operation it invokes. */
export interface ApiTool {
  tool: Tool;
  operation: OperationSpec;
}

let cached: { tools: ApiTool[]; policy: PolicyResult } | null = null;

/** Build the curated set of API tools from the embedded spec (memoised — pure). */
export function buildApiTools(): { tools: ApiTool[]; policy: PolicyResult } {
  if (cached) return cached;
  const doc = loadSpec();
  const manifest = buildManifest(doc);
  const policy = applyToolPolicy(manifest);
  const tools = policy.tools.map((operation): ApiTool => {
    const tool: Tool = {
      name: toolName(operation.operationId),
      description: describeTool(operation),
      inputSchema: buildInputSchema(operation, doc),
      annotations: annotationsFor(operation),
    };
    // MCP Apps: when an operation has a viewer bound to it, the host renders it on call.
    const appResourceUri = APP_BINDINGS[operation.operationId];
    if (appResourceUri) tool._meta = { ui: { resourceUri: appResourceUri } };
    return { operation, tool };
  });
  cached = { tools, policy };
  return cached;
}

/** Escape a parameter name so it can be spliced into a RegExp literally. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fill a path template from the arguments.
 *
 * Two invariants: a placeholder is replaced everywhere it occurs (a template may
 * repeat one), and the value is a non-empty string. An absent id substituted as
 * `''` produces `/v1/companies//invoices` — a different, usually valid, endpoint
 * that answers about the wrong thing instead of failing.
 */
export function substitutePath(op: OperationSpec, args: Record<string, unknown>): string {
  let path = op.path;
  for (const p of op.pathParams) {
    const value = args[p.name];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new ArgumentError(op.operationId, [
        `${p.name} is required and must be a string (path parameter of ${op.operationId})`,
      ]);
    }
    const raw = String(value);
    if (raw.length === 0) {
      throw new ArgumentError(op.operationId, [
        `${p.name} must not be empty (path parameter of ${op.operationId})`,
      ]);
    }
    path = path.replace(
      new RegExp(`\\{${escapeForRegExp(p.name)}\\}`, 'g'),
      encodeURIComponent(raw),
    );
  }
  return path;
}

/**
 * Map arguments onto query parameters.
 *
 * Array values are comma-joined because that is what the contract asks for:
 * every array query parameter it declares is `style: form, explode: false`.
 * `tests/api-query-style.test.ts` fails if an operation ever adopts another
 * style, rather than letting this serialise it the wrong way in silence.
 */
export function collectQuery(
  op: OperationSpec,
  args: Record<string, unknown>,
): Record<string, string> {
  const query: Record<string, string> = {};
  for (const p of op.queryParams) {
    const value = args[p.name];
    if (value === undefined || value === null) continue;
    query[p.name] = Array.isArray(value) ? value.map(String).join(',') : String(value);
  }
  return query;
}

/**
 * Execute an API tool: map MCP arguments onto path/query/body and call the API.
 * Returns the raw data payload (already unwrapped from the success envelope).
 */
export async function executeApiTool(
  config: ResolvedConfig,
  op: OperationSpec,
  args: Record<string, unknown>,
): Promise<unknown> {
  const path = substitutePath(op, args);
  const query = collectQuery(op, args);
  const body = op.requestBody ? args.body : undefined;
  // Travels as a header, never as body or query: it is not part of the hashed
  // material, so two otherwise identical calls with different keys stay two
  // distinct operations.
  const idempotencyKey =
    typeof args.idempotency_key === 'string' && args.idempotency_key.length > 0
      ? args.idempotency_key
      : undefined;
  // Pre-flight the fiscal invariants the schema cannot express. Runs before the
  // request so a rejected payload never burns an idempotency key. See
  // guardrails/validate.ts for why this can only ever be a subset of the API's
  // own rejections.
  assertNoViolations(op.operationId, body);
  const result = await apiRequest(config, {
    method: op.method,
    path,
    query,
    body,
    idempotencyKey,
    declaredHeaders: op.headerParams.map((p) => p.name),
  });
  return result.data;
}
