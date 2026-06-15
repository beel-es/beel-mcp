import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { resolveConfig, type ResolvedConfig } from './config.js';
import { ApiError } from './http/client.js';
import { buildApiTools, executeApiTool, type ApiTool } from './tools/api-tools.js';
import { docsTools, executeDocsTool, isDocsTool } from './tools/docs-tools.js';
import { guardrailResources, readGuardrailResource } from './resources/guardrails.js';
import { getPrompt, prompts } from './prompts/workflows.js';

export interface ServerInfo {
  name: string;
  version: string;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function formatApiError(err: ApiError): string {
  const parts = [`BeeL API error (${err.status}): ${err.message}`];
  if (err.code) parts.push(`code: ${err.code}`);
  if (err.details) parts.push(`details: ${JSON.stringify(err.details)}`);
  if (err.requestId) parts.push(`request_id: ${err.requestId}`);
  return parts.join('\n');
}

/** Build and wire the BeeL MCP server (transport-agnostic). */
export function createServer(info: ServerInfo): Server {
  const { tools: apiTools, policy } = buildApiTools();
  const apiByName = new Map<string, ApiTool>(apiTools.map((t) => [t.tool.name, t]));

  // Resolve credentials lazily so the server starts (and can list tools) without
  // an API key; we only need it the first time an API tool actually runs.
  let config: ResolvedConfig | null = null;
  const getConfig = (): ResolvedConfig => (config ??= resolveConfig());

  const server = new Server(info, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions:
      'BeeL is a Spanish invoicing API with VeriFactu compliance. Tools are derived from ' +
      'the public OpenAPI spec. Before mutating fiscal data, consult the beel://guardrails/* ' +
      'resources and use beel_docs_search. Sandbox keys (beel_sk_test_) are safe to experiment with.',
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...apiTools.map((t) => t.tool), ...docsTools],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    try {
      if (isDocsTool(name)) {
        return textResult(await executeDocsTool(name, args));
      }
      const apiTool = apiByName.get(name);
      if (!apiTool) return textResult(`Unknown tool: ${name}`, true);
      const data = await executeApiTool(getConfig(), apiTool.operation, args);
      return textResult(JSON.stringify(data, null, 2));
    } catch (err) {
      if (err instanceof ApiError) return textResult(formatApiError(err), true);
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: guardrailResources,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const body = readGuardrailResource(uri);
    if (body === null) throw new Error(`Unknown resource: ${uri}`);
    return { contents: [{ uri, mimeType: 'text/markdown', text: body }] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return getPrompt(name, (args ?? {}) as Record<string, string>);
  });

  // Surface the policy on stderr at boot for operability (never on stdout — that's the protocol channel).
  process.stderr.write(
    `[beel-mcp] ${apiTools.length} API tools, ${docsTools.length} docs tools, ` +
      `${policy.excluded.length} operations excluded by policy.\n`,
  );

  return server;
}
