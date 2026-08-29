import OAuthProvider from '@cloudflare/workers-oauth-provider';
import * as Sentry from '@sentry/cloudflare';
import { McpAgent } from 'agents/mcp';
import specYaml from '../../openapi/public-api.yaml';
import invoicePdfHtml from '../../dist/mcpapp/invoice-pdf.html';
import { setSpecSource } from '../spec/load.js';
import { setInvoicePdfAppHtml } from '../mcpapp/resource.js';
import type { Env } from './env.js';
import { createServer } from '../server.js';
import type { ResolvedConfig } from '../config.js';
import { advertisedScopes, keyEnvFromScopes } from '../policy/scopes.js';
import { SERVER_INFO } from '../shared/defaults.js';
import { BeelAuthHandler } from './beel-handler.js';
import { handlePublicDiscovery, publicDiscoveryEnabled } from './public-discovery.js';
import { WORKER_PATH, WORKER_TTL } from './constants.js';
import { sentryOptions } from './telemetry.js';
import { createTokenExchangeCallback, type SessionProps } from './token-exchange.js';
import { upstreamConfig, workerAccessTokenTTL } from './upstream.js';

/**
 * Cloudflare Worker entrypoint for the remote BeeL MCP server.
 *
 * workers-oauth-provider is the OAuth authorization server the MCP clients see
 * (DCR, /authorize, /token, KV-backed grants). The BeeL access token obtained
 * upstream travels encrypted inside the grant's props and surfaces as
 * `this.props` here, where it becomes the per-session bearer for every API call.
 */

// The Worker bundle has no filesystem: the spec and the MCP-App HTML are
// embedded as text modules at build time (see `rules` in wrangler.jsonc).
setSpecSource(specYaml);
setInvoicePdfAppHtml(invoicePdfHtml);

/**
 * The MCP session runs inside the Durable Object, a different runtime from the
 * Worker's `fetch`: instrumenting only the latter would leave out all the real
 * work. The class is declared uninstrumented so `serve()` resolves against it
 * with its statics intact, and exported wrapped under the name wrangler binds.
 */
class BeelMcpAgentBase extends McpAgent<Env, Record<string, never>, SessionProps> {
  server = createServer(SERVER_INFO, {
    quiet: true,
    getConfig: (): ResolvedConfig => {
      const props = this.props;
      if (!props) throw new Error('No authenticated session — reconnect the BeeL MCP.');
      return {
        apiKey: props.accessToken,
        env: keyEnvFromScopes(props.scopes),
        baseUrl: upstreamConfig(this.env).apiBaseUrl,
        transport: 'remote',
      };
    },
  });

  async init(): Promise<void> {
    // Tools/resources/prompts are wired inside createServer — nothing to do here.
  }
}

/**
 * `sentryOptions` reads the environment through the shared helpers, so it is
 * typed by what it uses. Binding it to `Env` here is what tells the Sentry
 * wrappers which bindings the handlers they wrap receive.
 */
const workerSentryOptions = (env: Env) => sentryOptions(env);

/** The name `wrangler.jsonc` registers as the Durable Object's `class_name`. */
export const BeelMcpAgent = Sentry.instrumentDurableObjectWithSentry(
  workerSentryOptions,
  // McpAgent is a Durable Object at runtime but does not declare the brand the
  // wrapper's signature expects; the cast bridges only that type difference.
  BeelMcpAgentBase as unknown as new (
    state: DurableObjectState,
    env: Env,
  ) => import('cloudflare:workers').DurableObject<Env>,
);

/** The protected transport, resolved once: it depends on nothing per-request. */
const apiHandler = BeelMcpAgentBase.serve(WORKER_PATH.api);

/**
 * One provider per request, so the bindings reach `tokenExchangeCallback`
 * through a closure. The callback receives no `env` of its own, and holding it
 * in a module-level variable would make it whichever request wrote there last —
 * or nothing at all on a cold isolate, which silently skips the upstream
 * refresh and leaves an expired bearer in the props.
 */
function createProvider(env: Env): OAuthProvider {
  return new OAuthProvider({
    apiRoute: WORKER_PATH.api,
    // The first token of a session; every refresh replaces this with a TTL taken
    // from the upstream token itself, via tokenExchangeCallback.
    accessTokenTTL: workerAccessTokenTTL(),
    clientRegistrationTTL: WORKER_TTL.clientRegistrationSeconds,
    apiHandler,
    defaultHandler: BeelAuthHandler,
    authorizeEndpoint: WORKER_PATH.authorize,
    tokenEndpoint: WORKER_PATH.token,
    clientRegistrationEndpoint: WORKER_PATH.register,
    // Refresh the upstream BeeL token whenever the MCP client refreshes ours, so
    // the bearer in props never outlives its upstream counterpart.
    tokenExchangeCallback: createTokenExchangeCallback(env),
    // Advertised in both discovery documents, so a client can request least
    // privilege before it ever sees the consent screen.
    scopesSupported: advertisedScopes(),
    resourceMetadata: {
      scopes_supported: advertisedScopes(),
      resource_name: SERVER_INFO.name,
    },
  });
}

export default Sentry.withSentry(workerSentryOptions, {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (publicDiscoveryEnabled(env)) {
      const response = await handlePublicDiscovery(request);
      if (response) return response;
    }
    return createProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>);
