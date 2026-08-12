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
import { getSetupStatus, isWorkflowTool, workflowTools } from './tools/workflow-tools.js';
import { guardrailResources, readGuardrailResource } from './resources/guardrails.js';
import { pdfAppResource, readPdfApp } from './resources/pdf-app.js';
import { INVOICE_PDF_APP_URI, MCP_APP_MIME } from './ui/registry.js';
import { getPrompt, prompts } from './prompts/workflows.js';

export interface ServerInfo {
  name: string;
  version: string;
}

export interface CreateServerOptions {
  /**
   * Supplies the credentials used for API calls. Stdio mode omits this and the
   * server resolves a single key from the environment lazily. HTTP mode passes a
   * provider that returns per-request, token-derived credentials.
   */
  getConfig?: () => ResolvedConfig;
  /** Suppress the per-instance boot log (HTTP creates one server per request). */
  quiet?: boolean;
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

/**
 * One structured line per tool call for Cloudflare Workers Logs (and stderr in stdio).
 * Deliberately carries NO arguments, tokens or PII — only which tool ran, whether it
 * succeeded, the upstream status/error code, and latency. Emitted on stderr so it never
 * pollutes the stdio JSON-RPC channel; Workers Logs captures stdout and stderr alike.
 */
function logToolCall(
  tool: string,
  outcome: 'ok' | 'error',
  ms: number,
  meta?: { status?: number; code?: string },
): void {
  console.error(
    JSON.stringify({ evt: 'tool_call', tool, outcome, ms, ...meta }),
  );
}

/** Build and wire the BeeL MCP server (transport-agnostic). */
export function createServer(info: ServerInfo, options: CreateServerOptions = {}): Server {
  const { tools: apiTools, policy } = buildApiTools();
  const apiByName = new Map<string, ApiTool>(apiTools.map((t) => [t.tool.name, t]));

  // Resolve credentials lazily so the server starts (and can list tools) without
  // an API key; we only need it the first time an API tool actually runs. HTTP
  // mode injects a provider returning per-request, token-derived credentials.
  let config: ResolvedConfig | null = null;
  const getConfig = options.getConfig ?? ((): ResolvedConfig => (config ??= resolveConfig()));

  const server = new Server(info, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions:
      'BeeL is a Spanish invoicing API with VeriFactu compliance. Tools are derived from ' +
      'the public OpenAPI spec. Before mutating fiscal data, consult the beel://guardrails/* ' +
      'resources and use beel_docs_search. Sandbox keys (beel_sk_test_) are safe to experiment with.',
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...apiTools.map((t) => t.tool), ...docsTools, ...workflowTools],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const startedAt = Date.now();
    try {
      if (isDocsTool(name)) {
        const result = textResult(await executeDocsTool(name, args));
        logToolCall(name, 'ok', Date.now() - startedAt);
        return result;
      }
      if (isWorkflowTool(name)) {
        const status = await getSetupStatus(getConfig(), args);
        const result = textResult(JSON.stringify(status, null, 2));
        result.structuredContent = status as unknown as Record<string, unknown>;
        logToolCall(name, 'ok', Date.now() - startedAt);
        return result;
      }
      const apiTool = apiByName.get(name);
      if (!apiTool) {
        logToolCall(name, 'error', Date.now() - startedAt, { code: 'unknown_tool' });
        return textResult(`Unknown tool: ${name}`, true);
      }
      const data = await executeApiTool(getConfig(), apiTool.operation, args);
      const result = textResult(JSON.stringify(data, null, 2));
      // MCP App tools (e.g. the PDF viewer) need the payload as structuredContent
      // so the host can hand it to the UI panel.
      if (apiTool.appResourceUri && data && typeof data === 'object' && !Array.isArray(data)) {
        result.structuredContent = data as Record<string, unknown>;
      }
      logToolCall(name, 'ok', Date.now() - startedAt);
      return result;
    } catch (err) {
      if (err instanceof ApiError) {
        logToolCall(name, 'error', Date.now() - startedAt, { status: err.status, code: err.code });
        return textResult(formatApiError(err), true);
      }
      logToolCall(name, 'error', Date.now() - startedAt);
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [...guardrailResources, pdfAppResource],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === INVOICE_PDF_APP_URI) {
      const app = readPdfApp();
      if (!app) throw new Error('Invoice PDF app not built. Run `npm run build:ui`.');
      return {
        contents: [
          {
            uri,
            mimeType: MCP_APP_MIME,
            text: app.text,
            // CSP must allow the presigned PDF host inside the sandboxed iframe.
            _meta: { ui: { csp: { frameDomains: app.frameDomains } } },
          },
        ],
      };
    }
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
  if (!options.quiet) {
    process.stderr.write(
      `[beel-mcp] ${apiTools.length} API tools, ${docsTools.length + workflowTools.length} synthetic tools, ` +
        `${policy.excluded.length} operations excluded by policy.\n`,
    );
  }

  return server;
}
