import { OAUTH_PATH } from '../shared/defaults.js';
import { WORKER_PATH } from './constants.js';

/**
 * The `agent_auth` block of the auth.md convention (workos.com/auth-md),
 * appended to the RFC 8414 metadata: where an agent registers and revokes,
 * which identity types exist, and the skill that walks it through.
 *
 * Registration is anonymous (RFC 7591) and the user claims it on the consent
 * screen; there is no identity-assertion registration, so it is not listed.
 */
export const AGENT_AUTH_SKILL = 'https://beel.es/auth.md';

export function agentAuthBlock(origin: string) {
  return {
    skill: AGENT_AUTH_SKILL,
    register_uri: `${origin}${WORKER_PATH.register}`,
    revocation_uri: `${origin}${WORKER_PATH.token}`,
    identity_types_supported: ['anonymous'],
    anonymous: {
      registration: 'rfc7591',
      credential_types_supported: ['access_token', 'refresh_token'],
      claim: 'authorization_code_pkce',
    },
  };
}

/** Appends `agent_auth` to a successful authorization-server metadata response. */
export async function withAgentAuth(request: Request, response: Response): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== OAUTH_PATH.discovery || !response.ok) return response;
  let metadata: Record<string, unknown>;
  try {
    metadata = (await response.clone().json()) as Record<string, unknown>;
  } catch {
    return response;
  }
  const body = JSON.stringify({ ...metadata, agent_auth: agentAuthBlock(url.origin) });
  return new Response(body, { status: response.status, headers: response.headers });
}
