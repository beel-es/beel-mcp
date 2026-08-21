/// <reference types="@cloudflare/workers-types" />

/** Worker bindings. OAUTH_KV/OAUTH_PROVIDER are injected by workers-oauth-provider. */
interface Env {
  /** Bindings and vars are read generically by `shared/env.ts`; see ENV_VAR. */
  [key: string]: unknown;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_PROVIDER: import('@cloudflare/workers-oauth-provider').OAuthHelpers;
  /** Upstream BeeL OAuth (secrets/vars). */
  BEEL_OAUTH_ISSUER?: string;
  BEEL_OAUTH_CLIENT_ID?: string;
  BEEL_OAUTH_CLIENT_SECRET?: string;
  /** Dedicated HMAC key for the client-identity assertion (key separation). */
  MCP_IDENTITY_HMAC_KEY?: string;
  /** JSON array of {prefix,name} overriding the verified-clients allowlist. */
  MCP_VERIFIED_CLIENTS?: string;
  BEEL_BASE_URL?: string;
  BEEL_DOCS_URL?: string;
  /** Comma-separated storage hosts the invoice-PDF relay may fetch from. */
  BEEL_PDF_STORAGE_HOSTS?: string;
}
