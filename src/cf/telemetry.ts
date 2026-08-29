/**
 * Error reporting for the Worker.
 *
 * What this exists to catch is the OAuth handshake, not tool failures: a tool
 * error travels back to the model, the user sees it and says so. A `/authorize`
 * or `/token` that breaks while someone connects their client produces no failed
 * call and no complaint — only a connection that never happened.
 *
 * With no DSN configured nothing is sent, so deploying before the secret exists
 * is inert rather than broken.
 */

import type { CloudflareOptions } from '@sentry/cloudflare';
import { ENV_VAR, SENSITIVE_HEADERS, SERVER_INFO } from '../shared/defaults.js';
import { readEnv, type EnvRecord } from '../shared/env.js';
import { upstreamConfig } from './upstream.js';

/** Header names never worth reporting, whatever case the runtime used. */

/**
 * The minimum shape of a Sentry event this scrubber touches. Declared here
 * rather than imported so the redaction can be tested without the SDK.
 */
export interface ScrubbableEvent {
  request?: {
    headers?: Record<string, string>;
    query_string?: unknown;
    data?: unknown;
  };
  breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }>;
}

/**
 * Strip every carrier of a credential from an event before it leaves the Worker.
 *
 * Three of them, and each one holds a different secret: request headers carry the
 * client's bearer, the query string of `/authorize` and `/token` carries `code`
 * and `state`, and the request body of a token exchange carries the client secret
 * and the refresh token. The path alone is enough to know which phase failed.
 *
 * Breadcrumbs are dropped whenever they mention a sensitive URL, because a
 * breadcrumb for the upstream token call records its request and response.
 */
export function scrubSentryEvent<E extends ScrubbableEvent>(event: E, sensitiveUrls: string[]): E {
  const scrubbed: ScrubbableEvent = event;
  const request = scrubbed.request;
  if (request) {
    if (request.headers) {
      for (const name of Object.keys(request.headers)) {
        if (SENSITIVE_HEADERS.includes(name.toLowerCase())) delete request.headers[name];
      }
    }
    delete request.query_string;
    delete request.data;
  }
  if (scrubbed.breadcrumbs) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.filter((crumb) => {
      const haystack = `${crumb.message ?? ''} ${JSON.stringify(crumb.data ?? {})}`;
      return !sensitiveUrls.some((url) => url && haystack.includes(url));
    });
  }
  return event;
}

export function sentryOptions(env: EnvRecord): CloudflareOptions {
  const { tokenUrl } = upstreamConfig(env);
  return {
    dsn: readEnv(env, ENV_VAR.sentryDsn),
    environment: readEnv(env, ENV_VAR.sentryEnvironment) ?? 'production',
    release: SERVER_INFO.version,
    // Errors only. Performance traces answer no question asked of this server
    // today and would multiply the volume by every request it serves.
    tracesSampleRate: 0,
    // The upstream bearer lives in the grant props and in every API call: none of
    // it may leave the Worker even when an event happens to carry it.
    sendDefaultPii: false,
    beforeSend: (event) => scrubSentryEvent(event, [tokenUrl]),
  };
}
