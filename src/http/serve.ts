import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { createServer, type ServerInfo } from '../server.js';
import {
  configFromAuth,
  createOAuthProvider,
  loadOAuthConfig,
  SUPPORTED_SCOPES,
  type OAuthConfig,
} from './oauth.js';

/**
 * Express app for the remote (Streamable HTTP) MCP server.
 *
 * The server is an OAuth authorization-server facade in front of BeeL: it serves
 * the discovery metadata and the /authorize, /token, /register and /revoke
 * endpoints on its own domain, mints its own opaque tokens, and protects the MCP
 * endpoint with Bearer auth (see oauth.ts). Each `initialize` opens a session
 * bound to the caller's token, so the server is multi-tenant. Sessions are held
 * in memory (single instance; behind a load balancer use sticky routing on the
 * `mcp-session-id` header).
 */
export function createHttpApp(info: ServerInfo, config: OAuthConfig = loadOAuthConfig()) {
  const app = express();
  // Behind Cloudflare/Traefik (Dokploy) requests carry X-Forwarded-For; trust the
  // proxy so the SDK's rate limiter reads the real client IP. Hop count via TRUST_PROXY.
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
  app.use(express.json({ limit: '4mb' }));

  const provider = createOAuthProvider(config);
  // Anchor the resource (and its metadata) at the server root so the connector URL is
  // just https://host — clients read the OAuth endpoints from this server's metadata.
  const resourceServerUrl = new URL(config.resourceServerUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: resourceServerUrl,
      resourceServerUrl,
      scopesSupported: SUPPORTED_SCOPES,
      resourceName: 'BeeL MCP',
    }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', name: info.name, version: info.version });
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

  // Serve the MCP endpoint at the root, so the connector URL is just https://host.
  const MCP_PATH = '/';

  app.post(MCP_PATH, bearer, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const existing = sessionId ? transports.get(sessionId) : undefined;

      let transport: StreamableHTTPServerTransport;
      if (existing) {
        transport = existing;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New session: bind the server to this caller's validated token.
        const requestConfig = configFromAuth(req.auth!, config);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        const server = createServer(info, { getConfig: () => requestConfig, quiet: true });
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'No valid session. Send an initialize request first.' },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      process.stderr.write(`[beel-mcp-http] request error: ${String(err)}\n`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET opens the server→client SSE stream; DELETE terminates the session.
  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send('Invalid or missing session id');
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get(MCP_PATH, bearer, handleSessionRequest);
  app.delete(MCP_PATH, bearer, handleSessionRequest);

  return app;
}
