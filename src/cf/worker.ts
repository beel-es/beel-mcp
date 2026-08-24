import OAuthProvider from '@cloudflare/workers-oauth-provider';
import * as Sentry from '@sentry/cloudflare';
import { McpAgent } from 'agents/mcp';
import specYaml from '../../openapi/public-api.yaml';
import invoicePdfHtml from '../../dist/mcpapp/invoice-pdf.html';
import { setSpecSource } from '../spec/load.js';
import { setInvoicePdfAppHtml } from '../mcpapp/resource.js';
import { createServer } from '../server.js';
import type { ResolvedConfig } from '../config.js';
import { keyEnvFromScopes } from '../policy/scopes.js';
import { SERVER_INFO } from '../shared/defaults.js';
import { BeelAuthHandler } from './beel-handler.js';
import { refreshUpstream, upstreamConfig, workerAccessTokenTTL } from './upstream.js';

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
setInvoicePdfAppHtml(invoicePdfHtml);

interface Props extends Record<string, unknown> {
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
}

/**
 * Sentry hablando con Better Stack Error Tracking: el mismo destino que el backend y
 * la app, o sea un solo sitio donde mirar y un solo Slack que avisa.
 *
 * Sin `SENTRY_DSN` no se envía nada, así que desplegar esto antes de poner el secreto
 * es inerte, no roto.
 *
 * Lo que se persigue NO son los errores de tool: esos vuelven al modelo, el usuario
 * los ve y se queja. Es el OAuth. Si a alguien le revienta el /authorize o el /token
 * conectando Claude o ChatGPT, no hay tool call que falle ni queja que llegue — hay
 * un alta que no ocurrió y de la que nadie se entera.
 */
function sentryOptions(env: Env): Sentry.CloudflareOptions {
  return {
    dsn: typeof env.SENTRY_DSN === 'string' ? env.SENTRY_DSN : undefined,
    environment: typeof env.SENTRY_ENVIRONMENT === 'string' ? env.SENTRY_ENVIRONMENT : 'production',
    release: SERVER_INFO.version,
    // Solo errores. Las trazas de rendimiento no responden ninguna pregunta que nos
    // hagamos hoy y multiplicarían el volumen de un plan que ya comparte el backend.
    tracesSampleRate: 0,
    // El bearer upstream viaja en los props del grant y en cada llamada a la API:
    // nada de eso puede salir del Worker aunque el evento lo arrastre.
    sendDefaultPii: false,
    beforeSend(event) {
      const headers = event.request?.headers;
      if (headers) {
        for (const name of ['authorization', 'Authorization', 'cookie', 'Cookie']) {
          delete headers[name];
        }
      }
      // La query de /authorize y /token lleva `code`, `state` y a veces el secreto del
      // cliente. El path basta para saber qué fase del OAuth falló.
      if (event.request) delete event.request.query_string;
      return event;
    },
  };
}

/**
 * La sesión MCP corre en el Durable Object, que es un runtime distinto del `fetch`
 * del Worker: envolver solo el segundo dejaría fuera todo el trabajo real. Se declara
 * sin instrumentar para conservar los estáticos de `McpAgent` —`serve()` se resuelve
 * sobre esta clase— y se exporta instrumentada con el nombre que registra wrangler.
 */
class BeelMcpAgentBase extends McpAgent<Env, Record<string, never>, Props> {
  server = createServer(SERVER_INFO, {
    quiet: true,
    getConfig: (): ResolvedConfig => {
      const props = this.props;
      if (!props) throw new Error('No authenticated session — reconnect the BeeL MCP.');
      return {
        apiKey: props.accessToken,
        env: keyEnvFromScopes(props.scopes),
        baseUrl: upstreamConfig(this.env).apiBaseUrl,
      };
    },
  });

  async init(): Promise<void> {
    // Tools/resources/prompts are wired inside createServer — nothing to do here.
  }
}

/** El nombre que `wrangler.jsonc` registra como `class_name` del Durable Object. */
export const BeelMcpAgent = Sentry.instrumentDurableObjectWithSentry(
  sentryOptions,
  // McpAgent no declara el brand de DurableObject que espera la firma del wrapper,
  // aunque en runtime lo es: el cast solo salva esa diferencia de tipos.
  BeelMcpAgentBase as unknown as new (state: DurableObjectState, env: Env) => import('cloudflare:workers').DurableObject<Env>,
);

// tokenExchangeCallback gets no `env`; the wrapper fetch below captures it per request.
let currentEnv: Env | null = null;

const provider = new OAuthProvider({
  apiRoute: '/mcp',
  // The first token of a session; every refresh replaces this with a TTL taken
  // from the upstream token itself, via tokenExchangeCallback.
  accessTokenTTL: workerAccessTokenTTL(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiHandler: BeelMcpAgentBase.serve('/mcp') as any,
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
      accessTokenTTL: workerAccessTokenTTL(tokens.expires_in),
    };
  },
});

export default Sentry.withSentry(sentryOptions, {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    currentEnv = env;
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>);
