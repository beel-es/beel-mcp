/// <reference types="@cloudflare/workers-types" />

/** Text modules embedded at build time (see `rules` in wrangler.jsonc). */
declare module '*.yaml' {
  const text: string;
  export default text;
}
declare module '*.html' {
  const text: string;
  export default text;
}

/** Worker bindings. OAUTH_KV/OAUTH_PROVIDER are injected by workers-oauth-provider. */
interface Env {
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_PROVIDER: import('@cloudflare/workers-oauth-provider').OAuthHelpers;
  /** Upstream BeeL OAuth (secrets/vars). */
  BEEL_OAUTH_ISSUER?: string;
  BEEL_OAUTH_CLIENT_ID?: string;
  BEEL_OAUTH_CLIENT_SECRET?: string;
  /** Dedicated HMAC key for the client-identity assertion (key separation). */
  MCP_IDENTITY_HMAC_KEY?: string;
  BEEL_BASE_URL?: string;
  BEEL_DOCS_URL?: string;
}
