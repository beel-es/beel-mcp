import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { McpAgent } from 'agents/mcp';
import specYaml from '../../openapi/public-api.yaml';
import invoicePdfHtml from '../../dist/ui/invoice-pdf.html';
import { setSpecSource } from '../spec/load.js';
import { setPdfAppHtml } from '../resources/pdf-app.js';
import { createServer } from '../server.js';
import type { KeyEnv, ResolvedConfig } from '../config.js';
import { BeelAuthHandler } from './beel-handler.js';
import { refreshUpstream, upstreamConfig } from './upstream.js';

/**
 * Cloudflare Worker entrypoint for the remote BeeL MCP server.
 *
 * workers-oauth-provider is the OAuth authorization server the MCP clients see
 * (DCR, /authorize, /token, KV-backed grants) — it replaces the hand-rolled
 * Express facade entirely. The BeeL access token obtained upstream travels
 * encrypted inside the grant's props and surfaces as `this.props` here, where
 * it becomes the per-session bearer for every API tool call.
 */

// The Worker bundle has no filesystem: the spec and the MCP-App HTML are
// embedded as text modules at build time (see `rules` in wrangler.jsonc).
setSpecSource(specYaml);
setPdfAppHtml(invoicePdfHtml);

const SERVER_INFO = { name: 'beel-mcp', version: '0.2.0' };

interface Props extends Record<string, unknown> {
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
}

export class BeelMcpAgent extends McpAgent<Env, Record<string, never>, Props> {
  server = createServer(SERVER_INFO, {
    quiet: true,
    getConfig: (): ResolvedConfig => {
      const props = this.props;
      if (!props) throw new Error('No authenticated session — reconnect the BeeL MCP.');
      const env: KeyEnv = props.scopes.includes('sandbox') ? 'test' : 'live';
      return {
        apiKey: props.accessToken,
        env,
        baseUrl: upstreamConfig(this.env).apiBaseUrl,
      };
    },
  });

  async init(): Promise<void> {
    // Tools/resources/prompts are wired inside createServer — nothing to do here.
  }
}

// tokenExchangeCallback gets no `env`; the wrapper fetch below captures it per request.
let currentEnv: Env | null = null;

// Margen para que el access token del worker caduque ANTES que el de BeeL
// (1h). Así el refresh del cliente MCP siempre dispara antes, y cada refresh
// arrastra el token upstream vía tokenExchangeCallback. Sin esto, el token del
// worker podía sobrevivir al de BeeL → 401 sin auto-refresh (había que reconectar).
const UPSTREAM_SKEW_SECONDS = 300;
const WORKER_ACCESS_TOKEN_TTL = 3600 - UPSTREAM_SKEW_SECONDS;

const provider = new OAuthProvider({
  apiRoute: '/mcp',
  accessTokenTTL: WORKER_ACCESS_TOKEN_TTL,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiHandler: BeelMcpAgent.serve('/mcp') as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: BeelAuthHandler as any,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  // Refresh the upstream BeeL token whenever the MCP client refreshes ours, so
  // the bearer in props never outlives its upstream counterpart.
  tokenExchangeCallback: async ({ grantType, props }) => {
    if (grantType !== 'refresh_token') return undefined;
    const p = props as Props;
    if (!p.refreshToken) return undefined;
    if (!currentEnv) return undefined;
    const tokens = await refreshUpstream(upstreamConfig(currentEnv), p.refreshToken);
    return {
      newProps: {
        ...p,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? p.refreshToken,
      },
      // Mantener el token del worker por debajo del upstream también tras refrescar.
      accessTokenTTL: Math.max(60, (tokens.expires_in ?? 3600) - UPSTREAM_SKEW_SECONDS),
    };
  },
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    currentEnv = env;
    return provider.fetch(request, env, ctx);
  },
};
