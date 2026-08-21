/**
 * Single source of truth for every constant shared across the MCP server.
 *
 * Nothing here may be duplicated elsewhere in `src/`: an endpoint, a client id,
 * a header name or a TTL that appears twice eventually diverges (the scope lists
 * did exactly that). Every module reads from this file, and every deployment
 * detail that differs per install is an environment variable, never a literal.
 *
 * Values are the PUBLIC BeeL defaults — the same ones documented in the README.
 * Anything environment-specific (storage hosts, KV ids, HMAC keys) is absent by
 * design and must be provided through the variables named in `ENV_VAR`.
 */

import pkg from '../../package.json';

/**
 * MCP server identity, advertised in `initialize`. The version comes from
 * package.json so the published npm version and what a client sees can never
 * disagree — they did (the Worker reported 0.2.0 against a 0.1.0 package).
 */
export const SERVER_NAME = 'beel-mcp';
export const SERVER_VERSION: string = pkg.version;
export const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION } as const;

/** Public BeeL endpoints. Every one is overridable via the matching `ENV_VAR`. */
export const BEEL_DEFAULTS = {
  /** REST API base the tools call. */
  apiBaseUrl: 'https://app.beel.es/api',
  /** Machine-readable documentation source for the docs tools. */
  docsUrl: 'https://docs.beel.es',
  /** Upstream OAuth authorization server (issuer). */
  oauthIssuer: 'https://app.beel.es/api',
  /** Pre-registered OAuth client this server drives the upstream flow with. */
  oauthClientId: 'beel-mcp',
  /** Public URL of the hosted remote server. */
  publicUrl: 'https://mcp.beel.es',
} as const;

/** Paths appended to the OAuth issuer. Overridable individually via `ENV_VAR`. */
export const OAUTH_PATH = {
  authorize: '/oauth2/authorize',
  token: '/oauth2/token',
  revoke: '/oauth2/revoke',
  discovery: '/.well-known/oauth-authorization-server',
} as const;

/** API key prefixes, which also classify the environment a key belongs to. */
export const API_KEY_PREFIX = {
  test: 'beel_sk_test_',
  live: 'beel_sk_live_',
} as const;

/** BeeL-specific request headers. Standard ones live in `HttpHeader`. */
export const BEEL_HEADER = {
  activeCompany: 'Beel-Active-Company',
  idempotencyKey: 'Idempotency-Key',
} as const;

/** Names of every environment variable the server reads. */
export const ENV_VAR = {
  apiKey: 'BEEL_API_KEY',
  keyEnvironment: 'BEEL_ENV',
  apiBaseUrl: 'BEEL_BASE_URL',
  activeCompany: 'BEEL_ACTIVE_COMPANY',
  configDir: 'BEEL_CONFIG_DIR',
  docsUrl: 'BEEL_DOCS_URL',
  oauthIssuer: 'BEEL_OAUTH_ISSUER',
  oauthClientId: 'BEEL_OAUTH_CLIENT_ID',
  oauthClientSecret: 'BEEL_OAUTH_CLIENT_SECRET',
  oauthAuthorizeUrl: 'BEEL_OAUTH_AUTHORIZE_URL',
  oauthTokenUrl: 'BEEL_OAUTH_TOKEN_URL',
  oauthRevokeUrl: 'BEEL_OAUTH_REVOKE_URL',
  publicUrl: 'MCP_PUBLIC_URL',
  identityHmacKey: 'MCP_IDENTITY_HMAC_KEY',
  verifiedClients: 'MCP_VERIFIED_CLIENTS',
  pdfStorageHosts: 'BEEL_PDF_STORAGE_HOSTS',
  requestTimeoutMs: 'BEEL_REQUEST_TIMEOUT_MS',
  /** Escape hatch: set to '1' to skip the executable guardrails (see guardrails/validate.ts). */
  disablePreflight: 'BEEL_DISABLE_PREFLIGHT',
} as const;

/** Outbound HTTP behaviour for API calls. */
export const HTTP_DEFAULTS = {
  /** Hard ceiling on a single API call, so a tool call can never hang forever. */
  timeoutMs: 30_000,
  /** Retries for transient failures (429 / 5xx) on idempotent-safe requests. */
  maxRetries: 2,
  /** Base for the exponential backoff between those retries. */
  retryBaseDelayMs: 400,
} as const;

/** In-memory cache lifetimes, in milliseconds. */
export const CACHE_TTL_MS = {
  docs: 15 * 60 * 1000,
  scopeDiscovery: 15 * 60 * 1000,
} as const;
