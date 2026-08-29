/**
 * Worker bindings.
 *
 * Declared as a type alias rather than an interface on purpose: the shared
 * environment helpers take a `Record<string, unknown>`, and only an object type
 * alias is structurally assignable to one. Every binding is listed explicitly so
 * that a variable which exists in `wrangler.jsonc` but nowhere here — or the
 * reverse — is a compile error rather than a silent `undefined` at runtime.
 */
export type Env = {
  /** Grants, tokens and pending authorizations, owned by workers-oauth-provider. */
  OAUTH_KV: import('@cloudflare/workers-types').KVNamespace;
  /** The Durable Object namespace backing one MCP session each. */
  MCP_OBJECT: import('@cloudflare/workers-types').DurableObjectNamespace;
  /** Injected by workers-oauth-provider into the handlers it wraps. */
  OAUTH_PROVIDER: import('@cloudflare/workers-oauth-provider').OAuthHelpers;
  /** Upstream BeeL OAuth (secrets/vars). */
  BEEL_OAUTH_ISSUER?: string;
  BEEL_OAUTH_CLIENT_ID?: string;
  BEEL_OAUTH_CLIENT_SECRET?: string;
  BEEL_OAUTH_AUTHORIZE_URL?: string;
  BEEL_OAUTH_TOKEN_URL?: string;
  /**
   * Set to `true` to let the token endpoint retry as a public client when the
   * configured secret is rejected. Absent, a rejected secret fails loudly.
   */
  BEEL_OAUTH_ALLOW_PUBLIC_FALLBACK?: string;
  /** Dedicated HMAC key for the client-identity assertion (key separation). */
  MCP_IDENTITY_HMAC_KEY?: string;
  /** JSON array of {prefix,name} overriding the verified-clients allowlist. */
  MCP_VERIFIED_CLIENTS?: string;
  /** This server's own public origin, used to build its callback URL. */
  MCP_PUBLIC_URL?: string;
  /** `true` serves initialize and the list methods on the MCP endpoint without a token. */
  MCP_PUBLIC_DISCOVERY?: string;
  BEEL_BASE_URL?: string;
  BEEL_DOCS_URL?: string;
  /** Comma-separated storage hosts the invoice-PDF relay may fetch from. */
  BEEL_PDF_STORAGE_HOSTS?: string;
  /** Sentry-compatible DSN. Absent, no event is sent anywhere. */
  SENTRY_DSN?: string;
  /** Environment label attached to those events. Defaults to `production`. */
  SENTRY_ENVIRONMENT?: string;
};
