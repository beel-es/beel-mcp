import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ResolvedConfig } from '../config.js';
import { apiRequest } from '../http/client.js';
import { loadSpec } from '../spec/load.js';
import { buildManifest, type OperationSpec } from '../spec/manifest.js';
import { buildInputSchema } from '../spec/json-schema.js';
import { toolName } from '../spec/derive.js';
import { applyToolPolicy, type PolicyResult } from '../policy/tool-policy.js';
import { annotationsFor } from '../policy/annotations.js';
import { describeTool } from '../guardrails/enrich.js';
import { UI_TOOLS } from '../ui/registry.js';

/** A registered API tool: its MCP definition plus the operation it invokes. */
export interface ApiTool {
  tool: Tool;
  operation: OperationSpec;
  /** If set, the tool renders this MCP App (ui:// resource) and emits structuredContent. */
  appResourceUri?: string;
}

let cached: { tools: ApiTool[]; policy: PolicyResult } | null = null;

/** Build the curated set of API tools from the embedded spec (memoised — pure). */
export function buildApiTools(): { tools: ApiTool[]; policy: PolicyResult } {
  if (cached) return cached;
  const doc = loadSpec();
  const manifest = buildManifest(doc);
  const policy = applyToolPolicy(manifest);
  const tools = policy.tools.map((operation): ApiTool => {
    const appResourceUri = UI_TOOLS[operation.operationId];
    const tool: Tool = {
      name: toolName(operation.operationId),
      description: describeTool(operation),
      inputSchema: buildInputSchema(operation, doc),
      annotations: annotationsFor(operation),
    };
    // MCP Apps: link the tool to its UI panel so the host renders it on call.
    if (appResourceUri) tool._meta = { ui: { resourceUri: appResourceUri } };
    return { operation, tool, appResourceUri };
  });
  cached = { tools, policy };
  return cached;
}

function substitutePath(op: OperationSpec, args: Record<string, unknown>): string {
  let path = op.path;
  for (const p of op.pathParams) {
    const value = args[p.name];
    if (value === undefined || value === null) {
      throw new Error(`Missing required path parameter "${p.name}" for ${op.operationId}`);
    }
    path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
  }
  return path;
}

function collectQuery(
  op: OperationSpec,
  args: Record<string, unknown>,
): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const p of op.queryParams) {
    const value = args[p.name];
    if (value === undefined || value === null) continue;
    query[p.name] = Array.isArray(value) ? value.map(String) : String(value);
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
  const result = await apiRequest(config, {
    method: op.method,
    path,
    query,
    body,
  });
  return result.data;
}
