import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { UnsecuredJWT } from 'jose';
import { PostHog } from 'posthog-node';
import { createServer } from '../src/server.js';
import { subjectFromAccessToken } from '../src/cf/access-token.js';
import {
  createProductAnalytics,
  instrumentProductAnalytics,
  redactMcpEvent,
} from '../src/cf/product-analytics.js';
import { ENV_VAR } from '../src/shared/defaults.js';

const USER_ID = '2f1d6c1e-8b7a-4c3d-9e2f-1a2b3c4d5e6f';

function accessToken(claims: Record<string, unknown>): string {
  return new UnsecuredJWT(claims).encode();
}

describe('the access token names the person behind the session', () => {
  it('reads the user id claim', () => {
    expect(subjectFromAccessToken(accessToken({ user_id: USER_ID, sub: 'other' }))).toBe(USER_ID);
  });

  it('falls back to the subject', () => {
    expect(subjectFromAccessToken(accessToken({ sub: USER_ID }))).toBe(USER_ID);
  });

  it('is null for a token that is not a JWT', () => {
    expect(subjectFromAccessToken('opaque')).toBeNull();
  });
});

describe('events carry no fiscal data out of the Worker', () => {
  it('drops the tool arguments, the tool result and the error text', () => {
    const event = redactMcpEvent({
      event: '$mcp_tool_call',
      distinct_id: USER_ID,
      properties: {
        $mcp_tool_name: 'beel_create_customer',
        $mcp_parameters: { nif: 'B12345678' },
        $mcp_response: '{"legal_name":"ACME"}',
        $mcp_error_message: 'NIF B12345678 is not valid',
        $mcp_is_error: true,
      },
    });
    expect(event.properties).toEqual({
      $mcp_tool_name: 'beel_create_customer',
      $mcp_is_error: true,
    });
  });
});

describe('product analytics is off until it is configured', () => {
  it('returns no client without a project token', () => {
    expect(createProductAnalytics({})).toBeNull();
  });

  it('returns a client with one', async () => {
    const client = createProductAnalytics({ [ENV_VAR.posthogProjectToken]: 'phc_test' });
    expect(client).toBeInstanceOf(PostHog);
    await client?.shutdown();
  });
});

describe('an instrumented server', () => {
  let client: Client | undefined;
  let posthog: PostHog | undefined;
  afterEach(async () => {
    await client?.close();
    await posthog?.shutdown();
  });

  async function connect(token: string | undefined) {
    const sent: Array<{ event: string; distinct_id: string; properties: Record<string, unknown> }> =
      [];
    posthog = new PostHog('phc_test', {
      host: 'https://posthog.test',
      flushAt: 1,
      flushInterval: 0,
      disableCompression: true,
      fetch: async (_url, options) => {
        const body = JSON.parse(String(options.body)) as { batch: typeof sent };
        sent.push(...body.batch);
        return new Response('{}', { status: 200 });
      },
    });
    const server = createServer({ name: 'test', version: '0' }, { quiet: true });
    instrumentProductAnalytics(server, posthog, () => token);
    client = new Client({ name: 'test-client', version: '0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { client, sent };
  }

  it('records a tool call under the user id, without its arguments or result', async () => {
    const { client, sent } = await connect(accessToken({ user_id: USER_ID }));
    await client.callTool({ name: 'beel_schema_get', arguments: { names: ['Customer'] } });
    await posthog!.flush();

    const call = sent.find((e) => e.event === '$mcp_tool_call');
    expect(call?.distinct_id).toBe(USER_ID);
    expect(call?.properties.$mcp_tool_name).toBe('beel_schema_get');
    expect(call?.properties).not.toHaveProperty('$mcp_parameters');
    expect(call?.properties).not.toHaveProperty('$mcp_response');
  });

  it('adds no argument to any tool', async () => {
    // An injected argument would ask the agent for conversation content the
    // tool does not need, in every tool definition it reads.
    const { client } = await connect(accessToken({ user_id: USER_ID }));
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const properties = Object.keys(tool.inputSchema.properties ?? {});
      expect(properties, tool.name).not.toContain('context');
      expect(properties, tool.name).not.toContain('llm_model');
      expect(properties, tool.name).not.toContain('conversation_id');
    }
  });
});
