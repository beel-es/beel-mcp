/**
 * Shared HTTP constants: header names, authentication schemes and content types
 * in one place. A mistyped header fails silently rather than loudly, which is
 * reason enough not to repeat the literals across the codebase.
 */

/** Canonical header names. HTTP treats them case-insensitively; we do not. */
export const HttpHeader = {
  Authorization: 'Authorization',
  ContentType: 'Content-Type',
  Accept: 'Accept',
} as const;

/** `Authorization` header schemes. */
export const AuthScheme = {
  Basic: 'Basic',
  Bearer: 'Bearer',
} as const;

/** Media types used across the server. */
export const ContentType = {
  Json: 'application/json',
  Form: 'application/x-www-form-urlencoded',
} as const;

/**
 * `Authorization: Basic base64(urlencode(clientId):urlencode(clientSecret))` —
 * client_secret_basic.
 *
 * RFC 6749 §2.3.1 requires both halves to be form-urlencoded before they are
 * joined and base64-encoded, and authorization servers URL-decode them again on
 * arrival. URL-decoding maps `+` to a space, so a secret containing `+` — every
 * base64 secret eventually does — only survives the round trip if it is encoded
 * here. `encodeURIComponent` leaves the unreserved characters alone, so a secret
 * without them is transmitted byte for byte as before.
 */
export function basicAuthHeader(clientId: string, clientSecret: string): string {
  const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `${AuthScheme.Basic} ${btoa(credentials)}`;
}

/** `Authorization: Bearer <token>`. */
export function bearerAuthHeader(token: string): string {
  return `${AuthScheme.Bearer} ${token}`;
}
