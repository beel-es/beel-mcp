import { ENV_VAR } from '../shared/defaults.js';
/**
 * Constants of the Cloudflare Worker layer: the routes it serves, the lifetimes
 * it enforces and the ceilings of the PDF relay.
 *
 * They live here rather than in `shared/defaults.ts` because nothing outside the
 * Worker can observe them — the stdio server has no routes, no KV and no relay.
 * The rule they do obey is the same one: a path or a TTL is written down once,
 * and every module reads it from here instead of repeating the literal.
 */

/** Routes the Worker answers. The OAuth provider is configured from these too. */
export const WORKER_PATH = {
  /** Protected MCP transport; everything else is served by the auth handler. */
  api: '/mcp',
  authorize: '/authorize',
  token: '/token',
  register: '/register',
  /** Where the upstream authorization server sends the user back. */
  callback: '/callback',
  health: '/healthz',
} as const;

/** Lifetimes, in seconds, of everything the Worker mints or stores. */
export const WORKER_TTL = {
  /**
   * How long a dynamically registered client lives without being used. DCR is
   * unauthenticated by design, so registrations are unbounded input; without a
   * TTL every registration is a permanent KV record.
   */
  clientRegistrationSeconds: 30 * 24 * 60 * 60,
  /**
   * How long a pending authorization stays redeemable in KV.
   *
   * It has to cover a full interactive login — password, second factor, a
   * password manager — between `/authorize` and `/callback`, so it is measured
   * in minutes rather than seconds. It is not a security boundary: the state is
   * single-use and the code is bound to a PKCE verifier.
   */
  pendingAuthSeconds: 30 * 60,
  /**
   * Margin that makes this server's access token expire before BeeL's.
   *
   * The MCP client only refreshes when our token expires, and that refresh is
   * the only thing that drags the upstream token along. Ours must therefore run
   * out first: an upstream token that dies while ours is still valid 401s every
   * tool call with nothing to trigger a recovery.
   */
  upstreamSkewSeconds: 300,
  /** Fallback upstream access-token lifetime when the token endpoint omits one. */
  upstreamAssumedSeconds: 3600,
  /** Floor for our own access token, so a short upstream TTL never yields zero. */
  minimumAccessTokenSeconds: 60,
  /**
   * The identity assertion is consumed by the consent screen the redirect opens
   * immediately after it is minted, so its window is the redirect itself.
   */
  identityAssertionSeconds: 120,
  /** Edge-cache lifetime for the upstream authorization-server metadata. */
  discoveryCacheSeconds: 300,
} as const;

/** Ceilings the invoice-PDF relay enforces on whatever the storage host returns. */
export const PDF_RELAY_LIMITS = {
  /** Refuse to stream anything larger than a plausible invoice PDF. */
  maxBytes: 25 * 1024 * 1024,
  /** Presigned URLs redirect at most once or twice; more suggests a loop. */
  maxRedirects: 3,
} as const;

/** Worker-only environment names live in `ENV_VAR` (shared/defaults.ts); re-exported for local readers. */
export const WORKER_ENV_VAR = { allowPublicFallback: ENV_VAR.oauthAllowPublicFallback } as const;
