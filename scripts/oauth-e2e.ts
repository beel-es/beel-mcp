/**
 * End-to-end OAuth resource-server test against a LOCAL JWKS.
 *
 * We can't perform a real BeeL login here (OAuth client registration is manual),
 * so we stand up a local JWKS, sign a JWT with the same claim shape BeeL issues,
 * and drive the MCP HTTP server with the real MCP client. This exercises the full
 * resource-server path: discovery metadata, 401 + WWW-Authenticate, JWKS token
 * validation, the session handshake, tool listing, and token forwarding to the API.
 *
 * Run: npx tsx scripts/oauth-e2e.ts
 */
import http from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ISSUER = 'https://issuer.test';

function portOf(server: http.Server): number {
  const addr = server.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('server has no port');
}
function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(portOf(server)));
  });
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

async function main() {
  // 1. Key material + local JWKS endpoint.
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const jwksServer = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  const jwksPort = await listen(jwksServer);

  // 2. Stub BeeL API that echoes the Authorization header it received.
  let seenAuth: string | undefined;
  const apiServer = http.createServer((req, res) => {
    seenAuth = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, data: { invoices: [], auth_seen: seenAuth } }));
  });
  const apiPort = await listen(apiServer);

  // 3. Point the MCP server at the local issuer/JWKS/API, then build it. We bind
  //    the MCP app to an ephemeral port too (read it back) to avoid collisions.
  const mcpPort = await new Promise<number>((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = portOf(probe);
      probe.close(() => resolve(p));
    });
  });
  process.env.BEEL_OAUTH_ISSUER = ISSUER;
  process.env.BEEL_OAUTH_JWKS_URL = `http://127.0.0.1:${jwksPort}/jwks`;
  process.env.BEEL_BASE_URL = `http://127.0.0.1:${apiPort}/api`;
  process.env.MCP_PUBLIC_URL = `http://127.0.0.1:${mcpPort}`;
  const { createHttpApp } = await import('../src/http/serve.js');
  const app = createHttpApp({ name: 'beel-mcp', version: 'test' });
  const mcpServer = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(mcpPort, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

  const base = `http://127.0.0.1:${mcpPort}`;

  // Test A — protected-resource metadata is served for discovery (anchored at root).
  const metaRes = await fetch(`${base}/.well-known/oauth-protected-resource`);
  const metaText = await metaRes.text();
  if (metaRes.status !== 200) {
    console.error(`metadata fetch ${metaRes.status}:`, metaText.slice(0, 120));
  }
  const meta = (metaRes.status === 200 ? JSON.parse(metaText) : {}) as Record<string, unknown>;
  check('discovery: protected-resource metadata served', metaRes.status === 200);
  check(
    'discovery: advertises the BeeL authorization server',
    Array.isArray(meta.authorization_servers) &&
      (meta.authorization_servers as string[]).includes(ISSUER),
    JSON.stringify(meta.authorization_servers),
  );
  check(
    'discovery: advertises scopes',
    Array.isArray(meta.scopes_supported) && (meta.scopes_supported as string[]).length > 5,
  );

  // Test B — unauthenticated request is rejected with a discovery pointer.
  const unauth = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  const wwwAuth = unauth.headers.get('www-authenticate') ?? '';
  check('auth: missing token → 401', unauth.status === 401, `status ${unauth.status}`);
  check(
    'auth: 401 carries WWW-Authenticate with resource_metadata',
    wwwAuth.includes('resource_metadata'),
    wwwAuth,
  );

  // Test C — a token signed by an UNKNOWN key is rejected.
  const { privateKey: rogueKey } = await generateKeyPair('RS256');
  const rogueToken = await new SignJWT({ scope: 'invoices:read' })
    .setProtectedHeader({ alg: 'RS256', kid: 'rogue' })
    .setSubject('u-1')
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(rogueKey);
  const rogue = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${rogueToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check('auth: token from unknown key → 401', rogue.status === 401, `status ${rogue.status}`);

  // Test D — a valid token drives the full MCP flow via the real client.
  const token = await new SignJWT({
    scope: 'invoices:read invoices:write customers:read sandbox',
    environment: 'SANDBOX',
    user_id: 'u-123',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject('u-123')
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);

  const client = new Client({ name: 'oauth-e2e', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  check('flow: client connected (initialize handshake over OAuth)', true);

  const tools = await client.listTools();
  check('flow: tools/list returns the curated surface', tools.tools.length > 60, `${tools.tools.length} tools`);
  check(
    'flow: includes beel_create_invoice and docs tools',
    tools.tools.some((t) => t.name === 'beel_create_invoice') &&
      tools.tools.some((t) => t.name === 'beel_docs_search'),
  );

  const resources = await client.listResources();
  check('flow: guardrail resources listed', resources.resources.some((r) => r.uri.startsWith('beel://guardrails')));

  // Test E — calling an API tool forwards the validated token to the API.
  const result = await client.callTool({ name: 'beel_list_invoices', arguments: {} });
  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  const forwarded = seenAuth === `Bearer ${token}`;
  check('forwarding: API received the caller token as Bearer', forwarded, seenAuth?.slice(0, 24) + '…');
  check('forwarding: tool returned the API payload', text.includes('auth_seen'));

  await client.close();
  mcpServer.close();
  apiServer.close();
  jwksServer.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E harness error:', err);
  process.exit(1);
});
