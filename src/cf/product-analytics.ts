/**
 * Product analytics for the remote MCP server: which tools agents call, which
 * fail, from which client, and how long they take.
 *
 * With no project token configured nothing is sent, so deploying before the
 * secret exists is inert rather than broken. Error reporting stays in
 * `telemetry.ts`; this module never emits exceptions.
 */

import { instrument } from '@posthog/mcp';
import { PostHog } from 'posthog-node';
import { ENV_VAR } from '../shared/defaults.js';
import { readEnv, type EnvRecord } from '../shared/env.js';
import { subjectFromAccessToken } from './access-token.js';

/**
 * Properties that would carry the user's fiscal data — customers, NIFs, amounts —
 * out of the Worker: what the agent sent, what the API answered, and the error
 * text, which echoes the offending field. Which tool ran, whether it failed and
 * how long it took are enough to measure quality.
 */
const REDACTED_PROPERTIES = ['$mcp_parameters', '$mcp_response', '$mcp_error_message'];

/** The minimum shape of an event this redaction touches. */
export interface RedactableEvent {
  properties?: Record<string, unknown>;
}

export function redactMcpEvent<E extends RedactableEvent>(event: E): E {
  if (event.properties) {
    for (const name of REDACTED_PROPERTIES) delete event.properties[name];
  }
  return event;
}

/** A client that sends each event as it happens: a Worker has no idle loop to flush on. */
export function createProductAnalytics(env: EnvRecord): PostHog | null {
  const token = readEnv(env, ENV_VAR.posthogProjectToken);
  if (!token) return null;
  return new PostHog(token, {
    host: readEnv(env, ENV_VAR.posthogHost),
    flushAt: 1,
    flushInterval: 0,
  });
}

/**
 * Capture this server's MCP traffic under the id of the person whose token the
 * session holds — the same id the API attributes their actions to.
 *
 * No argument is injected into the tools. The SDK can add one asking the agent
 * why it called the tool, but that is conversation content the tool does not
 * need to do its job, and an instruction to the model in every tool definition
 * the agent reads on each turn. The model and conversation-id arguments are off
 * for the same reason; the session is already stable, since each one lives in
 * its own Durable Object.
 */
export function instrumentProductAnalytics(
  server: unknown,
  posthog: PostHog,
  getAccessToken: () => string | undefined,
): void {
  instrument(server, posthog, {
    identify: async () => {
      const token = getAccessToken();
      const distinctId = token ? subjectFromAccessToken(token) : null;
      return distinctId ? { distinctId } : null;
    },
    beforeSend: (event) => redactMcpEvent(event),
    enableExceptionAutocapture: false,
    context: false,
    captureModel: false,
    enableConversationId: false,
  });
}
