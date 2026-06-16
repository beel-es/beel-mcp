import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { createServer, type ServerInfo } from '../server.js';
import {
  buildOAuthMetadata,
  configFromAuth,
  createBeelTokenVerifier,
  loadOAuthConfig,
  SUPPORTED_SCOPES,
  type OAuthConfig,
} from './oauth.js';

/**
 * Express app for the remote (Streamable HTTP) MCP server, acting as an OAuth 2.1
 * Resource Server in front of the BeeL authorization server.
 *
 * - Discovery: serves RFC 9728 protected-resource metadata + a copy of the AS
 *   metadata so MCP clients can auto-configure the OAuth flow.
 * - Auth: every /mcp request must carry a Bearer JWT, validated offline via JWKS;
 *   a 401 returns WWW-Authenticate pointing at the metadata URL.
 * - Sessions: an `initialize` request mints a session bound to the caller's token,
 *   so the server is multi-tenant — each session acts with its own credentials.
 *   Sessions are held in memory (single-instance; behind a load balancer use
 *   sticky routing on the `mcp-session-id` header).
 */
export function createHttpApp(info: ServerInfo, config: OAuthConfig = loadOAuthConfig()) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const verifier = createBeelTokenVerifier(config);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
    new URL(`${config.resourceServerUrl}/mcp`),
  );

  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: buildOAuthMetadata(config),
      resourceServerUrl: new URL(`${config.resourceServerUrl}/mcp`),
      scopesSupported: SUPPORTED_SCOPES,
      resourceName: 'BeeL MCP',
    }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', name: info.name, version: info.version });
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const bearer = requireBearerAuth({ verifier, resourceMetadataUrl });

  app.post('/mcp', bearer, async (req: Request, res: Response) => {
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
  app.get('/mcp', bearer, handleSessionRequest);
  app.delete('/mcp', bearer, handleSessionRequest);

  return app;
}
