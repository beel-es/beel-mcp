import { describe, expect, it } from 'vitest';
import { agentAuthBlock, withAgentAuth } from '../src/cf/agent-auth.js';

const ORIGIN = 'https://mcp.beel.es';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('agent_auth metadata block', () => {
  it('names the real registration and revocation endpoints and the skill', () => {
    const block = agentAuthBlock(ORIGIN);
    expect(block.register_uri).toBe(`${ORIGIN}/register`);
    expect(block.revocation_uri).toBe(`${ORIGIN}/token`);
    expect(block.identity_types_supported).toEqual(['anonymous']);
    expect(block.skill).toBe('https://beel.es/auth.md');
  });

  it('is appended to the authorization-server metadata only', async () => {
    const request = new Request(`${ORIGIN}/.well-known/oauth-authorization-server`);
    const response = await withAgentAuth(request, json({ issuer: ORIGIN }));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ORIGIN);
    expect((body.agent_auth as { register_uri: string }).register_uri).toBe(`${ORIGIN}/register`);

    const other = json({ resource: `${ORIGIN}/mcp` });
    expect(
      await withAgentAuth(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`), other),
    ).toBe(other);
    const failed = json({ error: 'x' }, 500);
    expect(await withAgentAuth(request, failed)).toBe(failed);
  });
});
