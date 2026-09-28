import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { resolveConfig, type ResolvedConfig } from './config.js';
import { ApiError } from './api/client.js';
import { buildApiTools, executeApiTool, type ApiTool } from './tools/api-tools.js';
import { docsTools, executeDocsTool, isDocsTool } from './tools/docs-tools.js';
import { executeRulesTool, isRulesTool, rulesTools } from './tools/rules-tools.js';
import { executeSchemaTool, isSchemaTool, schemaTools } from './tools/schema-tools.js';
import { getSetupStatus, workflowTools } from './tools/workflow-tools.js';
import { listGuardrailResources, readGuardrailResource } from './resources/guardrails.js';
import { enrichToolResult, jsonText } from './tools/tool-result.js';
import { INVOICE_PDF_APP_URI, MCP_APP_MIME } from './mcpapp/contract.js';
import { invoicePdfAppResource, readInvoicePdfApp } from './mcpapp/resource.js';
import { getPrompt, prompts } from './prompts/workflows.js';
import {
  ArgumentError,
  OutputError,
  assertValidArguments,
  assertValidOutput,
} from './tools/validate-args.js';
import { isRecord } from './shared/guards.js';
import { GuardrailError } from './guardrails/validate.js';
import { explainErrorWithRules } from './guardrails/explain.js';
import { SERVER_NAME } from './shared/defaults.js';

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

/**
 * Render an API error for the model. Goes through the guardrail catalogue, so a
 * bare code like EMISSION_NOT_READY arrives with its meaning, its remedy and its
 * nested blockers expanded — an agent that only sees the code retries blindly —
 * and names the published fiscal rules that code enforces.
 */
function formatApiError(err: ApiError): Promise<string> {
  return explainErrorWithRules({
    status: err.status,
    message: err.message,
    code: err.code,
    details: err.details,
    requestId: err.requestId,
    docsUrl: err.docsUrl,
  });
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
  console.error(JSON.stringify({ evt: 'tool_call', tool, outcome, ms, ...meta }));
}

/**
 * Write a line to stderr where there is one.
 *
 * `process` exists under Node and not in every Worker build, and this is
 * operability output: it must never be the reason a request fails.
 */
function writeStderr(line: string): void {
  if (typeof process !== 'undefined' && process.stderr) process.stderr.write(line);
}

/** Resolve a resource URI to its contents: the MCP App, or a guardrail document. */
async function readResource(uri: string): Promise<{ contents: Array<Record<string, unknown>> }> {
  if (uri === INVOICE_PDF_APP_URI) {
    const app = readInvoicePdfApp();
    if (!app) throw new Error('Invoice PDF app not built. Run `npm run build:mcpapp`.');
    return {
      contents: [
        {
          uri,
          mimeType: MCP_APP_MIME,
          text: app.html,
          // CSP: pdf.js from the CDN (resourceDomains) plus the PDF fetch through the relay.
          _meta: { ui: { csp: app.csp } },
        },
      ],
    };
  }
  const body = await readGuardrailResource(uri);
  if (body === null) throw new Error(`Unknown resource: ${uri}`);
  return { contents: [{ uri, mimeType: 'text/markdown', text: body }] };
}

/**
 * Run one of the hand-written tools: the documentation and rules readers, the
 * schema declarations and the setup report. Their schemas are advertised exactly like the derived ones, so their
 * arguments — and, where they declare an outputSchema, their output — go
 * through the same validator.
 */
async function runSyntheticTool(
  tool: Tool,
  args: Record<string, unknown>,
  getConfig: () => ResolvedConfig,
): Promise<CallToolResult> {
  assertValidArguments(tool, args);
  if (isDocsTool(tool.name)) return textResult(await executeDocsTool(tool.name, args));
  if (isRulesTool(tool.name)) return textResult(await executeRulesTool(tool.name, args));
  if (isSchemaTool(tool.name)) return textResult(await executeSchemaTool(tool.name, args));

  const status = await getSetupStatus(getConfig(), args);
  // The output schema is advertised to the client, which may validate against
  // it. A divergence is our defect and is reported as one.
  assertValidOutput(tool, status);
  const result = textResult(jsonText(status));
  // Validated against that same outputSchema just above; the SDK types
  // structuredContent as an open record and cannot see it.
  result.structuredContent = status as unknown as Record<string, unknown>;
  return result;
}

/**
 * Turn a thrown failure into a tool result, logging which layer stopped the
 * call. A local rejection never reached the API, and the log says so: "we
 * stopped this" and "BeeL stopped this" call for different fixes.
 */
async function errorResult(name: string, err: unknown, ms: number): Promise<CallToolResult> {
  if (err instanceof ApiError) {
    logToolCall(name, 'error', ms, { status: err.status, code: err.code });
    return textResult(await formatApiError(err), true);
  }
  if (err instanceof GuardrailError) {
    logToolCall(name, 'error', ms, { code: 'guardrail_violation' });
    return textResult(err.message, true);
  }
  if (err instanceof ArgumentError) {
    logToolCall(name, 'error', ms, { code: 'invalid_arguments' });
    return textResult(err.message, true);
  }
  if (err instanceof OutputError) {
    logToolCall(name, 'error', ms, { code: 'invalid_output' });
    return textResult(err.message, true);
  }
  logToolCall(name, 'error', ms);
  return textResult(err instanceof Error ? err.message : String(err), true);
}

/**
 * The CallTool handler: dispatch to a docs tool, a workflow tool or a derived
 * API tool, and turn every failure into a result the model can act on.
 */
function createCallToolHandler(
  apiByName: Map<string, ApiTool>,
  syntheticByName: Map<string, Tool>,
  getConfig: () => ResolvedConfig,
): (request: { params: { name: string; arguments?: unknown } }) => Promise<CallToolResult> {
  return async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const startedAt = Date.now();
    try {
      // `arguments` is whatever the client sent. An array or a scalar would sail
      // through a cast and fail much later as a missing property.
      if (rawArgs !== undefined && !isRecord(rawArgs)) {
        throw new ArgumentError(name, ['arguments must be a JSON object']);
      }
      const args: Record<string, unknown> = rawArgs ?? {};

      const synthetic = syntheticByName.get(name);
      if (synthetic) {
        const result = await runSyntheticTool(synthetic, args, getConfig);
        logToolCall(name, 'ok', Date.now() - startedAt);
        return result;
      }
      const apiTool = apiByName.get(name);
      if (!apiTool) {
        logToolCall(name, 'error', Date.now() - startedAt, { code: 'unknown_tool' });
        return textResult(`Unknown tool: ${name}`, true);
      }
      // Validate against the schema we advertised before anything else runs, so a
      // malformed call is answered with the field name rather than an upstream 400.
      assertValidArguments(apiTool.tool, args);
      const data = await executeApiTool(getConfig(), apiTool.operation, args);
      // A few tools enrich their payload — the invoice PDF supplies viewer data
      // and an attachment — while the rest fall back to compact JSON. Both live
      // in ./tools/tool-result.
      const result =
        (await enrichToolResult(apiTool.operation.operationId, data)) ?? textResult(jsonText(data));
      logToolCall(name, 'ok', Date.now() - startedAt);
      return result;
    } catch (err) {
      return errorResult(name, err, Date.now() - startedAt);
    }
  };
}

/**
 * The docs page that maps each invoicing case to its typed SDK call: where an
 * agent writing integration code starts. Only named in the instructions; no
 * behaviour depends on the page being there.
 */
export const INTEGRATION_GUIDE_PATH = '/guides/order-to-invoice';

/**
 * What the client puts in the agent's context: the ONE place for guidance that
 * applies to every tool — which tool family to reach for, in what order, when
 * not to, and how to cite. Tool descriptions only say what each tool does and
 * how it differs from its neighbours; they do not repeat this.
 */
export const SERVER_INSTRUCTIONS = [
  'BeeL is a Spanish invoicing API with VeriFactu built in. These tools call its public API ' +
    'and read its documentation and fiscal rules.',
  '',
  'Which tools, in this order:',
  '1. Designing a flow, or before proposing code or a call that creates or changes a fiscal ' +
    'document (issue, void, correct, simplified exchange, series and numbering, refunds, dates, ' +
    'PDF or QR): start with beel_rules_list filtered, by domain for that flow or with ' +
    'enforced_by "integrator", the checklist of what the API leaves to your code. Answer from that list; do not read every rule first. Open with beel_rules_get ' +
    'only the rules your answer relies on, all in one call with ids.',
  '2. How the API, a field or a flow works: beel_docs_search, then beel_docs_get with the page ' +
    'and section of the result that answers, not the whole page. Which fiscal rule applies ' +
    'is step 1.',
  '3. To act: the API tool for the operation. Use a test key (beel_sk_test_) unless the user ' +
    'asks for Live. Send an Idempotency-Key on every create, issue, correct or void, and reuse ' +
    'it only to retry the same request.',
  '4. A 4xx with a fiscal error.code: beel_rules_get with that error_code, fix the request, ' +
    'and send it again with a new Idempotency-Key.',
  'Skip the rules for questions that do not touch them (listing, reading, auth, pagination). ' +
    'beel://guardrails/* resources hold the same rules plus API usage guides.',
  '',
  `To write integration code, follow beel_docs_get page "${INTEGRATION_GUIDE_PATH}" (one SDK ` +
    "call per invoicing case) with the official SDK for the project's language if there is " +
    'one, not hand-written HTTP calls. beel_get_setup_status lists the SDKs, the company id, ' +
    "series ids and tax defaults; beel_schema_get gives field-level shapes, not an SDK's type file.",
  'Batch reads: sections of one page in one beel_docs_get, rules in one beel_rules_get, ' +
    'schemas in one beel_schema_get.',
  '',
  'When your answer relies on a rule, cite its id with its link (e.g. COR-024, ' +
    'https://docs.beel.es/rules/corrective#cor-024); when it relies on a docs page, link it.',
].join('\n');

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
    instructions: SERVER_INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...apiTools.map((t) => t.tool),
      ...docsTools,
      ...rulesTools,
      ...schemaTools,
      ...workflowTools,
    ],
  }));

  const syntheticByName = new Map<string, Tool>(
    [...docsTools, ...rulesTools, ...schemaTools, ...workflowTools].map((t) => [t.name, t]),
  );
  const callTool = createCallToolHandler(apiByName, syntheticByName, getConfig);

  server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(request));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [...(await listGuardrailResources()), invoicePdfAppResource],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    readResource(request.params.uri),
  );

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return getPrompt(name, (args ?? {}) as Record<string, string>);
  });

  // Surface the policy on stderr at boot for operability (never on stdout — that's the protocol channel).
  if (!options.quiet) {
    writeStderr(
      `[${SERVER_NAME}] ${apiTools.length} API tools, ${docsTools.length + rulesTools.length + schemaTools.length + workflowTools.length} synthetic tools, ` +
        `${policy.excluded.length} operations excluded by policy.\n`,
    );
  }

  return server;
}
