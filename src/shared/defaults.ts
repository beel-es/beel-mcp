/**
 * Single source of truth for every constant shared across the MCP server.
 *
 * Nothing here may be duplicated elsewhere in `src/`: an endpoint, a client id,
 * a header name or a TTL that appears twice eventually diverges, and the two
 * copies disagree where nothing is watching — an OAuth consent screen, a header
 * the API ignores. Every module reads from this file, and every deployment
 * detail that differs per install is an environment variable, never a literal.
 *
 * Values are the PUBLIC BeeL defaults — the same ones documented in the README.
 * Anything environment-specific (storage hosts, KV ids, HMAC keys) is absent by
 * design and must be provided through the variables named in `ENV_VAR`.
 */

import pkg from '../../package.json';

/**
 * MCP server identity, advertised in `initialize`. The version is read from
 * package.json rather than written here, so what a client is told and what npm
 * published are the same number by construction.
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
  discovery: '/.well-known/oauth-authorization-server',
} as const;

/** API key prefixes, which also classify the environment a key belongs to. */
export const API_KEY_PREFIX = {
  test: 'beel_sk_test_',
  live: 'beel_sk_live_',
} as const;

/**
 * The contract's security scheme for API-key auth. This server authenticates
 * with an API key and nothing else, so an operation that does not offer this
 * scheme is not callable from here at all.
 */
export const API_KEY_SECURITY_SCHEME = 'ApiKeyAuth';

/** BeeL-specific request headers. Standard ones live in `HttpHeader`. */
export const BEEL_HEADER = {
  idempotencyKey: 'Idempotency-Key',
} as const;

/** Names of every environment variable the server reads. */
export const ENV_VAR = {
  apiKey: 'BEEL_API_KEY',
  keyEnvironment: 'BEEL_ENV',
  apiBaseUrl: 'BEEL_BASE_URL',
  configDir: 'BEEL_CONFIG_DIR',
  docsUrl: 'BEEL_DOCS_URL',
  oauthIssuer: 'BEEL_OAUTH_ISSUER',
  oauthClientId: 'BEEL_OAUTH_CLIENT_ID',
  oauthClientSecret: 'BEEL_OAUTH_CLIENT_SECRET',
  oauthAuthorizeUrl: 'BEEL_OAUTH_AUTHORIZE_URL',
  oauthTokenUrl: 'BEEL_OAUTH_TOKEN_URL',
  /** Set to 'true' to let the OAuth bridge retry as a public client when its secret is rejected. */
  oauthAllowPublicFallback: 'BEEL_OAUTH_ALLOW_PUBLIC_FALLBACK',
  /** Set to 'true' to accept an http:// loopback API base URL (local development only). */
  allowInsecureBaseUrl: 'BEEL_ALLOW_INSECURE_BASE_URL',
  publicUrl: 'MCP_PUBLIC_URL',
  identityHmacKey: 'MCP_IDENTITY_HMAC_KEY',
  verifiedClients: 'MCP_VERIFIED_CLIENTS',
  pdfStorageHosts: 'BEEL_PDF_STORAGE_HOSTS',
  requestTimeoutMs: 'BEEL_REQUEST_TIMEOUT_MS',
  /** Escape hatch: set to '1' to skip the executable guardrails (see guardrails/validate.ts). */
  disablePreflight: 'BEEL_DISABLE_PREFLIGHT',
  /** Error-reporting destination, in the Sentry DSN format. Absent: nothing is sent. */
  sentryDsn: 'SENTRY_DSN',
  /** Label the error reports are filed under. */
  sentryEnvironment: 'SENTRY_ENVIRONMENT',
} as const;

/**
 * Headers that must never leave the process — not into an error report, not
 * into a log line. Lowercase, because a header name is case-insensitive on the
 * wire and a comparison that forgets it is a credential in a log.
 */
export const SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
];

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
