/**
 * Constantes y helpers HTTP compartidos: nombres de cabecera, esquemas de
 * autenticación y content-types en un único sitio. Evita repetir literales por
 * el código (una cabecera mal tecleada falla en silencio) y desacopla los
 * nombres de sus usos.
 */

/** Nombres canónicos de cabecera (case-insensitive en HTTP, pero uniformes aquí). */
export const HttpHeader = {
  Authorization: 'Authorization',
  ContentType: 'Content-Type',
  Accept: 'Accept',
} as const;

/** Esquemas del header `Authorization`. */
export const AuthScheme = {
  Basic: 'Basic',
  Bearer: 'Bearer',
} as const;

/** Media types usados por el worker. */
export const ContentType = {
  Json: 'application/json',
  Form: 'application/x-www-form-urlencoded',
} as const;

/**
 * `Authorization: Basic base64(clientId:clientSecret)` — client_secret_basic.
 * El secreto viaja en la cabecera (no en el cuerpo), que es lo que registra BeeL.
 */
export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `${AuthScheme.Basic} ${btoa(`${clientId}:${clientSecret}`)}`;
}

/** `Authorization: Bearer <token>`. */
export function bearerAuthHeader(token: string): string {
  return `${AuthScheme.Bearer} ${token}`;
}
