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
 * `Authorization: Basic base64(clientId:clientSecret)` — client_secret_basic.
 * The secret travels in the header rather than the body, which is the method
 * BeeL registers for this client.
 */
export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `${AuthScheme.Basic} ${btoa(`${clientId}:${clientSecret}`)}`;
}

/** `Authorization: Bearer <token>`. */
export function bearerAuthHeader(token: string): string {
  return `${AuthScheme.Bearer} ${token}`;
}
