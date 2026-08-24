/**
 * Upstream BeeL OAuth — the Worker acts as a full OAuth AS towards MCP clients
 * (via workers-oauth-provider) and as a plain OAuth *client* towards BeeL.
 * This module owns that second leg: authorize URL, PKCE, code exchange, refresh.
 */

import { ContentType, HttpHeader, basicAuthHeader } from '../shared/http.js';
import { BEEL_DEFAULTS, ENV_VAR, OAUTH_PATH } from '../shared/defaults.js';
import { readEnv, readEnvUrl, type EnvRecord } from '../shared/env.js';

export interface UpstreamConfig {
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
  /**
   * This server's own public origin, from configuration — never derived from the
   * incoming request.
   *
   * It is an identity, not a routing detail: the upstream authorization server
   * validates the redirect_uri built from it against what it has registered, and
   * the client-identity assertion is signed with it as issuer and bound to that
   * same redirect_uri. Taking it from the request URL would make all three vary
   * with whichever hostname the Worker happened to be reached through.
   */
  publicUrl: string;
}

/** Path the upstream authorization server redirects back to. */
export const CALLBACK_PATH = '/callback';

export interface UpstreamTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export function upstreamConfig(env: EnvRecord): UpstreamConfig {
  const issuer = readEnvUrl(env, ENV_VAR.oauthIssuer, BEEL_DEFAULTS.oauthIssuer);
  return {
    issuer,
    authorizeUrl: readEnv(env, ENV_VAR.oauthAuthorizeUrl) ?? `${issuer}${OAUTH_PATH.authorize}`,
    tokenUrl: readEnv(env, ENV_VAR.oauthTokenUrl) ?? `${issuer}${OAUTH_PATH.token}`,
    clientId: readEnv(env, ENV_VAR.oauthClientId) ?? BEEL_DEFAULTS.oauthClientId,
    clientSecret: readEnv(env, ENV_VAR.oauthClientSecret) ?? '',
    apiBaseUrl: readEnvUrl(env, ENV_VAR.apiBaseUrl, BEEL_DEFAULTS.apiBaseUrl),
    publicUrl: readEnvUrl(env, ENV_VAR.publicUrl, BEEL_DEFAULTS.publicUrl),
  };
}

/** The callback this server registers upstream. Derived from configuration only. */
export function callbackUrl(config: UpstreamConfig): string {
  return `${config.publicUrl}${CALLBACK_PATH}`;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE pair for the upstream leg (BeeL requires S256 for public clients). */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

let missingSecretWarned = false;
let rejectedSecretWarned = false;

/**
 * Marcadores estables al principio del mensaje. Son el asidero de una alerta: se busca
 * por ellos, no por una frase que cualquiera puede reescribir al editar el texto.
 */
export const OAUTH_MARKER = {
  missingSecret: 'OAUTH_CLIENT_SECRET_AUSENTE',
  rejectedSecret: 'OAUTH_CLIENT_SECRET_RECHAZADO',
} as const;

/**
 * Rearma los avisos de «una vez por proceso».
 *
 * Existe SOLO para las pruebas. El «una vez» es memoria de módulo, así que en un runner
 * que comparte proceso el primer caso consume el aviso y los siguientes verían silencio,
 * haciendo el resultado dependiente del orden. Producción nunca lo llama: allí el proceso
 * es el Worker y el aviso debe emitirse una vez, no en cada token exchange.
 */
export function resetOAuthWarningsForTests(): void {
  missingSecretWarned = false;
  rejectedSecretWarned = false;
}

/**
 * Sin `BEEL_OAUTH_CLIENT_SECRET` el puente cae a cliente público y el authorization
 * server deja de emitir refresh token: la sesión muere con el access token, a los 60
 * minutos, y el usuario tiene que volver a pasar por el consentimiento.
 *
 * Se emite como `error` y no como `warn` a propósito. Es una degradación permanente que
 * cuesta usuarios —quien se cansa de reconectar se va, sin abrir ninguna incidencia—, y
 * en `warn` se quedaba en unos logs que nadie mira. Como error, la instrumentación lo
 * manda a donde sí se mira.
 *
 * Una vez por proceso, no por petición: el dato es «falta la configuración», y repetirlo
 * en cada token exchange solo ahogaría el resto.
 */
function warnMissingClientSecret(): void {
  if (missingSecretWarned) return;
  missingSecretWarned = true;
  console.error(
    `${OAUTH_MARKER.missingSecret}: ${ENV_VAR.oauthClientSecret} sin definir. El puente ` +
      'autentica como cliente PÚBLICO y el authorization server no emite refresh token, ' +
      'así que la sesión caduca con el access token (60 min) y obliga a reconectar. ' +
      `Provisionar con \`wrangler secret put ${ENV_VAR.oauthClientSecret}\`.`,
  );
}

/**
 * El secreto está puesto y el authorization server lo rechaza. Las dos causas reales,
 * y las dos son nuestras:
 *
 *   1. El secreto no coincide con el registrado (rotado en un lado y no en el otro).
 *   2. El código desplegado es anterior al URL-encode de `client_secret_basic`, así que
 *      un secreto con `+` llega corrompido — ocurrió, y por eso se nombra aquí: poner
 *      el secreto ANTES de desplegar ese arreglo deja el puente sin poder autenticar.
 *
 * Lo grave no era el fallo, era que se veía igual que cualquier otro error de red.
 */
function reportRejectedClientSecret(status: number): void {
  if (rejectedSecretWarned) return;
  rejectedSecretWarned = true;
  console.error(
    `${OAUTH_MARKER.rejectedSecret}: el authorization server respondió ${status} ` +
      `invalid_client con ${ENV_VAR.oauthClientSecret} puesto. Se continúa como cliente ` +
      'PÚBLICO para no dejar a nadie sin conectar, al precio de perder el refresh token. ' +
      'Comprobar que el secreto coincide con el registrado y que el Worker desplegado ' +
      'incluye el URL-encode de client_secret_basic.',
  );
}

/**
 * Fallo del endpoint de token, con el motivo separado del ruido.
 *
 * Existía como `new Error(status + cuerpo)`, y eso hacía indistinguible «el destino
 * está caído» de «la credencial no vale», que es lo único que un operador puede
 * arreglar. `oauthError` trae el código del cuerpo OAuth (`invalid_client`,
 * `invalid_grant`…) para que quien lo lea sepa cuál de los dos tiene delante.
 */
export class TokenEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly oauthError: string | undefined,
    readonly usedClientSecret: boolean,
    detail: string,
  ) {
    super(detail);
    this.name = 'TokenEndpointError';
  }
}

/** El código de error OAuth del cuerpo, si el cuerpo es el JSON que manda la RFC. */
function oauthErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

async function tokenRequest(
  config: UpstreamConfig,
  params: URLSearchParams,
  options: { forcePublic?: boolean } = {},
): Promise<UpstreamTokens> {
  const headers: Record<string, string> = { [HttpHeader.ContentType]: ContentType.Form };
  if (config.clientSecret && !options.forcePublic) {
    // Confidential client: client_secret_basic (secret in the header, not the
    // body) — the method BeeL registers for this client. Sending it in the body
    // (client_secret_post) is rejected with 401. With Basic, the client_id
    // travels ONLY in the header.
    headers[HttpHeader.Authorization] = basicAuthHeader(config.clientId, config.clientSecret);
  } else {
    // Public client (no secret): PKCE (S256) is the protection.
    //
    // Y ADEMÁS la sesión durará lo que dure el access token: Spring Authorization Server
    // NO emite refresh token a un cliente que autentica con `none`
    // (OAuth2AuthorizationCodeAuthenticationProvider), así que a los 60 min hay que volver
    // a pasar por el consentimiento. Se percibe como «cada despliegue mata el token»,
    // porque los despliegues son más frecuentes que la hora.
    //
    // BeeL registra este cliente con los DOS métodos, así que esto es una degradación por
    // configuración ausente, no un diseño. Se avisa una vez por proceso —no por petición—
    // para que aparezca en los logs del Worker sin ahogarlos.
    warnMissingClientSecret();
    params.set('client_id', config.clientId);
  }
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers,
    body: params.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    const oauthError = oauthErrorCode(text);
    const usedSecret = Boolean(config.clientSecret) && !options.forcePublic;

    // `invalid_client` con secreto puesto es SIEMPRE un problema nuestro de
    // configuración, nunca del usuario que intenta conectar. Se degrada a cliente
    // público —el mismo cliente admite los dos métodos y PKCE sigue protegiendo—
    // para que un secreto malo cueste sesiones de una hora y no una caída: nadie
    // debería quedarse sin poder conectar porque una credencial esté rotada o
    // porque el código desplegado sea anterior al arreglo del URL-encode.
    if (usedSecret && oauthError === 'invalid_client') {
      reportRejectedClientSecret(response.status);
      return tokenRequest(config, params, { forcePublic: true });
    }

    // El cuerpo puede repetir parámetros de la petición: solo el estado y un
    // extracto acotado, nunca la respuesta entera.
    throw new TokenEndpointError(
      response.status,
      oauthError,
      usedSecret,
      `BeeL token endpoint returned ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  return JSON.parse(text) as UpstreamTokens;
}

export function exchangeCode(
  config: UpstreamConfig,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<UpstreamTokens> {
  return tokenRequest(
    config,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  );
}

export function refreshUpstream(config: UpstreamConfig, refreshToken: string): Promise<UpstreamTokens> {
  return tokenRequest(
    config,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
}

/**
 * Margin that makes THIS server's access token expire before BeeL's.
 *
 * The MCP client only refreshes when our token expires, and that refresh is the
 * only thing that drags the upstream token along (see `tokenExchangeCallback`).
 * So ours must always run out first: if the upstream token dies while ours is
 * still valid, every tool call 401s and nothing triggers a recovery until our
 * own token finally expires.
 */
const UPSTREAM_SKEW_SECONDS = 300;

/**
 * Our access token's lifetime, derived from the upstream token's `expires_in`.
 *
 * Called with no argument for the initial grant, where the upstream lifetime is
 * not yet available to us: `completeAuthorization` accepts no per-grant TTL, so
 * the first token necessarily runs on the provider-wide default. From the first
 * refresh onwards the real `expires_in` governs.
 */
export function workerAccessTokenTTL(expiresIn?: number): number {
  return Math.max(60, (expiresIn ?? 3600) - UPSTREAM_SKEW_SECONDS);
}

