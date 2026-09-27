import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, SERVER_INSTRUCTIONS } from '../src/server.js';
import { FISCAL_ERROR_HINT } from '../src/guardrails/enrich.js';
import { buildApiTools } from '../src/tools/api-tools.js';
import { RULES_GET, RULES_LIST, rulesTools } from '../src/tools/rules-tools.js';

/**
 * The agent consults the fiscal rules only if something tells it when to. These
 * are the texts that do: the server instructions, the first sentence of the rules
 * tools, and the last line of every invoice tool that can fail on a rule.
 */
describe('when the agent is told to consult the fiscal rules', () => {
  it('the client receives the instructions on initialize', async () => {
    const server = createServer({ name: 'test', version: '0' }, { quiet: true });
    const client = new Client({ name: 'test-client', version: '0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    await client.close();
  });

  it('the instructions say when to consult the rules, when not to, and what integrator means', () => {
    expect(SERVER_INSTRUCTIONS).toContain(RULES_LIST);
    expect(SERVER_INSTRUCTIONS).toContain(RULES_GET);
    expect(SERVER_INSTRUCTIONS).toMatch(/designing or implementing an integration flow/);
    expect(SERVER_INSTRUCTIONS).toMatch(/before proposing code/);
    expect(SERVER_INSTRUCTIONS).toMatch(/4xx .*error_code/s);
    expect(SERVER_INSTRUCTIONS).toMatch(/enforced_by "integrator"/);
    expect(SERVER_INSTRUCTIONS).toMatch(/Skip the rules for usage questions/);
  });

  it('the rules tools open with when to use them', () => {
    const byName = new Map(rulesTools.map((t) => [t.name, t]));
    expect(byName.get(RULES_LIST)?.description).toMatch(/^Use before designing or coding any flow/);
    expect(byName.get(RULES_GET)?.description).toMatch(/^Use when a BeeL\. call fails/);
    expect(Object.keys(byName.get(RULES_LIST)?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['domain', 'enforced_by']),
    );
    expect(Object.keys(byName.get(RULES_GET)?.inputSchema.properties ?? {})).toContain(
      'error_code',
    );
  });

  it('every invoice tool that can fail on a fiscal rule says how to look the rule up', () => {
    const operations = [
      'createCompanyInvoice',
      'issueCompanyInvoice',
      'voidCompanyInvoice',
      'createCompanyCorrectiveInvoice',
      'createCompanySimplifiedExchange',
    ];
    const { tools } = buildApiTools();
    for (const operationId of operations) {
      const tool = tools.find((t) => t.operation.operationId === operationId);
      expect(tool, operationId).toBeDefined();
      expect(tool?.tool.description, operationId).toContain(FISCAL_ERROR_HINT);
    }
  });
});
