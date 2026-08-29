import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from '../server.js';
import { ENV_VAR, SERVER_INFO } from '../shared/defaults.js';
import { readEnv, type EnvRecord } from '../shared/env.js';
import { WORKER_PATH } from './constants.js';

/**
 * Unauthenticated discovery on the MCP endpoint, opt-in via `MCP_PUBLIC_DISCOVERY`.
 *
 * When enabled, a request without a bearer token may run `initialize` and the
 * list methods against a stateless server, so registries and crawlers can read
 * the tool catalogue without an account. Every other method — `tools/call`
 * above all — is left to the OAuth provider, which answers 401 as before.
 *
 * Off by default: some hosts only start the OAuth flow when `initialize` itself
 * answers 401, and would otherwise connect a session that cannot call anything.
 */

/** Methods that read the catalogue and touch no user data. */
const PUBLIC_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
]);

export function publicDiscoveryEnabled(env: EnvRecord): boolean {
  return readEnv(env, ENV_VAR.publicDiscovery) === 'true';
}

/** Whether a request is eligible: a token-less JSON-RPC POST to the MCP endpoint. */
export function isPublicDiscoveryCandidate(request: Request): boolean {
  if (request.method !== 'POST') return false;
  if (request.headers.get('Authorization')) return false;
  return new URL(request.url).pathname === WORKER_PATH.api;
}

/** The JSON-RPC method of a single-message body, or `null` for anything else. */
export async function publicMethodOf(request: Request): Promise<string | null> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const method = (body as { method?: unknown }).method;
  return typeof method === 'string' && PUBLIC_METHODS.has(method) ? method : null;
}

/**
 * Serves the request from a fresh, stateless server. Returns `null` when the
 * request is not a public-discovery call, so the caller falls through to the
 * authenticated transport.
 */
export async function handlePublicDiscovery(request: Request): Promise<Response | null> {
  if (!isPublicDiscoveryCandidate(request)) return null;
  if (!(await publicMethodOf(request))) return null;

  const server = createServer(SERVER_INFO, {
    quiet: true,
    getConfig: () => {
      throw new Error('Unauthenticated discovery session: authenticate to call tools.');
    },
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
  }
}
