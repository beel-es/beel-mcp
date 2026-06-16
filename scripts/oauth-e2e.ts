/**
 * End-to-end test of the OAuth token-minting proxy, with BeeL stubbed locally
 * (no real login needed). Verifies the full chain: discovery metadata, DCR shim,
 * 401 challenge, the token exchange that mints OUR OWN opaque token (not BeeL's),
 * and that calling a tool forwards the UPSTREAM BeeL token to the API.
 *
 * Run: npx tsx scripts/oauth-e2e.ts
 */
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const UPSTREAM_TOKEN = 'beel-upstream-access-token';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

function portOf(server: http.Server): number {
  const addr = server.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('no port');
}
function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(portOf(server)));
  });
}

async function main() {
  // Stub BeeL authorization server: only the token endpoint is exercised here.
  const beel = http.createServer((req, res) => {
    if (req.url?.startsWith('/oauth2/token')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          access_token: UPSTREAM_TOKEN,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'invoices:read sandbox',
          refresh_token: 'beel-refresh',
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const beelPort = await listen(beel);

  // Stub BeeL API: echoes the Authorization header it receives.
  let seenAuth: string | undefined;
  const api = http.createServer((req, res) => {
    seenAuth = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, data: { invoices: [], auth_seen: seenAuth } }));
  });
  const apiPort = await listen(api);

  const mcpPort = await new Promise<number>((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = portOf(probe);
      probe.close(() => resolve(p));
    });
  });

  process.env.BEEL_OAUTH_ISSUER = `http://127.0.0.1:${beelPort}`;
  process.env.BEEL_BASE_URL = `http://127.0.0.1:${apiPort}/api`;
  process.env.MCP_PUBLIC_URL = `http://127.0.0.1:${mcpPort}`;
  process.env.BEEL_OAUTH_CLIENT_SECRET = ''; // public client
  const { createHttpApp } = await import('../src/http/serve.js');
  const app = createHttpApp({ name: 'beel-mcp', version: 'test' });
  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(mcpPort, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  const base = `http://127.0.0.1:${mcpPort}`;

  // Discovery
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  check('discovery: protected-resource metadata served', Array.isArray(prm.authorization_servers));
  const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  check(
    'discovery: /authorize and /token are on the MCP server',
    String(asm.authorization_endpoint).startsWith(base) && String(asm.token_endpoint).startsWith(base),
  );

  // DCR shim
  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
  });
  const regJson = await reg.json();
  check('dcr: /register returns the pre-registered client', reg.ok && regJson.client_id === 'beel-mcp');

  // 401 challenge
  const unauth = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check('auth: missing token → 401', unauth.status === 401);
  check(
    'auth: 401 points at the resource metadata',
    (unauth.headers.get('www-authenticate') ?? '').includes('resource_metadata'),
  );

  // Token exchange mints OUR OWN opaque token (not BeeL's upstream token).
  const tokenRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'beel-mcp',
      code: 'any-code',
      code_verifier: 'a'.repeat(43),
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    }).toString(),
  });
  const token = (await tokenRes.json()) as { access_token?: string };
  check('token: exchange succeeds', tokenRes.ok && Boolean(token.access_token), `status ${tokenRes.status}`);
  check('token: issued token is OURS, not the upstream BeeL token', token.access_token !== UPSTREAM_TOKEN);

  // Use the opaque token: connect, list tools, call one — the API must receive the UPSTREAM token.
  const client = new Client({ name: 'oauth-e2e', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(base), {
    requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  check('flow: tools/list works with the opaque token', tools.tools.length > 60, `${tools.tools.length} tools`);

  await client.callTool({ name: 'beel_list_invoices', arguments: {} });
  check('forwarding: API received the UPSTREAM BeeL token', seenAuth === `Bearer ${UPSTREAM_TOKEN}`, seenAuth);

  await client.close();
  server.close();
  api.close();
  beel.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E harness error:', err);
  process.exit(1);
});
