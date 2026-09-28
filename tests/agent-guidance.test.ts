import { describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createServer,
  INTEGRATION_GUIDE_PATH,
  SDK_PACKAGE,
  SERVER_INSTRUCTIONS,
} from '../src/server.js';
import { buildApiTools } from '../src/tools/api-tools.js';
import { DOCS_GET, DOCS_SEARCH, docsTools } from '../src/tools/docs-tools.js';
import { RULES_GET, RULES_LIST, rulesTools } from '../src/tools/rules-tools.js';
import { SETUP_STATUS, workflowTools } from '../src/tools/workflow-tools.js';
import { schemaTools } from '../src/tools/schema-tools.js';

/**
 * Everything the agent reads before it picks a tool. The rule of these texts:
 * guidance that applies to every tool — which family first, when not to, the
 * test key, idempotency, fiscal errors, citing rules — lives ONCE, in the server
 * instructions; a tool description says what the tool does and how it differs
 * from its neighbours, and its first sentence is enough to choose it.
 */

const SYNTHETIC: Tool[] = [...docsTools, ...rulesTools, ...schemaTools, ...workflowTools];
const API: Tool[] = buildApiTools().tools.map((t) => t.tool);

/** Up to the first full stop followed by a space or the end; "e.g." and "BeeL." are not one. */
function firstSentence(text: string): string {
  const masked = text
    .trim()
    .replace(/\be\.g\./g, 'e~g~')
    .replace(/BeeL\./g, 'BeeL~');
  const first = (/^[\s\S]*?[.!?](?=\s|$)/.exec(masked)?.[0] ?? masked).trim();
  return first.replace(/e~g~/g, 'e.g.').replace(/BeeL~/g, 'BeeL.');
}

/** A description this repository writes must fit in a glance. */
const MAX_SYNTHETIC_DESCRIPTION = 600;
/**
 * API tool descriptions come from the operation's own text in the public
 * contract. This is a ceiling against a runaway, not a style limit.
 */
const MAX_API_DESCRIPTION = 8_000;

describe('the server instructions', () => {
  it('reach the client on initialize', async () => {
    const server = createServer({ name: 'test', version: '0' }, { quiet: true });
    const client = new Client({ name: 'test-client', version: '0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(200);
    await client.close();
  });

  it('say which tool family to use, in order: rules, docs, API, then rules by error code', () => {
    const order = [RULES_LIST, DOCS_SEARCH, 'the API tool', 'error_code'].map((s) =>
      SERVER_INSTRUCTIONS.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(SERVER_INSTRUCTIONS).toContain(RULES_GET);
    expect(SERVER_INSTRUCTIONS).toContain(DOCS_GET);
  });

  it('hold the general rules: when not to, test key, idempotency, integrator rules, citing', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Skip the rules for questions/);
    expect(SERVER_INSTRUCTIONS).toMatch(/beel_sk_test_/);
    expect(SERVER_INSTRUCTIONS).toMatch(/Idempotency-Key/);
    expect(SERVER_INSTRUCTIONS).toMatch(/enforced_by "integrator"/);
    expect(SERVER_INSTRUCTIONS).toMatch(/cite its id with its link/);
  });

  it('keep the study short: a filtered list first, then only the rules relied on, in one call', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/beel_rules_list filtered/);
    expect(SERVER_INSTRUCTIONS).toMatch(/do not read every rule first/);
    expect(SERVER_INSTRUCTIONS).toMatch(
      /only the rules your answer relies on, all in one call with ids/,
    );
    expect(SERVER_INSTRUCTIONS).toMatch(
      /page\s+and section of the result that answers, not the whole page/,
    );
  });

  it('send integration work to the order-to-invoice guide and the setup report', () => {
    expect(INTEGRATION_GUIDE_PATH).toBe('/guides/order-to-invoice');
    expect(SERVER_INSTRUCTIONS).toContain(`beel_docs_get page "${INTEGRATION_GUIDE_PATH}"`);
    expect(SERVER_INSTRUCTIONS).toMatch(
      new RegExp(`series ids and tax\\s+defaults from ${SETUP_STATUS}`),
    );
  });

  it('send Node/TypeScript integrations to the official SDK, not hand-written HTTP calls', () => {
    expect(SDK_PACKAGE).toBe('@beel_es/sdk');
    expect(SERVER_INSTRUCTIONS).toContain(
      `in Node/TypeScript install the official SDK (npm install ${SDK_PACKAGE}) ` +
        'instead of hand-writing HTTP calls',
    );
    // The SDK clause comes with the guide, whose snippets are written against it.
    const line = SERVER_INSTRUCTIONS.split('\n').find((l) => l.includes(SDK_PACKAGE))!;
    expect(line).toContain(INTEGRATION_GUIDE_PATH);
  });

  it('ask for batched reads: sections, rules and schemas, each in one call', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/sections of one page in one beel_docs_get/);
    expect(SERVER_INSTRUCTIONS).toMatch(/rules in one beel_rules_get/);
    expect(SERVER_INSTRUCTIONS).toMatch(/schemas in one beel_schema_get/);
  });

  it('send field-level shapes to beel_schema_get rather than an SDK type file', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(
      /field-level shapes from beel_schema_get, not an SDK's type file/,
    );
  });

  it('stay short enough to be read whole', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2_000);
  });
});

describe('the tool descriptions', () => {
  it('open with a first sentence no other tool shares', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const tool of [...SYNTHETIC, ...API]) {
      const first = firstSentence(tool.description ?? '');
      const other = seen.get(first);
      if (other) clashes.push(`${other} / ${tool.name}: ${first}`);
      seen.set(first, tool.name);
    }
    expect(clashes).toEqual([]);
  });

  it('stay within a reasonable size', () => {
    const long = [
      ...SYNTHETIC.filter((t) => (t.description ?? '').length > MAX_SYNTHETIC_DESCRIPTION),
      ...API.filter((t) => (t.description ?? '').length > MAX_API_DESCRIPTION),
    ].map((t) => `${t.name}: ${t.description?.length}`);
    expect(long).toEqual([]);
  });

  it('do not repeat the general guidance of the instructions', () => {
    const general = [/Idempotency-Key/, /beel_sk_test_/, /If it fails with a fiscal error/];
    const repeats = [...SYNTHETIC, ...API]
      .filter(
        (t) => SYNTHETIC.includes(t) || /If it fails with a fiscal error/.test(t.description ?? ''),
      )
      .filter((t) => general.some((re) => re.test(t.description ?? '')))
      .map((t) => t.name);
    expect(repeats).toEqual([]);
  });

  it('tell the docs and the rules tools apart', () => {
    const byName = new Map(SYNTHETIC.map((t) => [t.name, t.description ?? '']));
    expect(firstSentence(byName.get(DOCS_SEARCH)!)).toMatch(/^Search the BeeL documentation/);
    expect(byName.get(DOCS_SEARCH)).toContain(DOCS_GET);
    expect(firstSentence(byName.get(RULES_LIST)!)).toMatch(/^List the Spanish invoicing rules/);
    expect(firstSentence(byName.get(RULES_GET)!)).toMatch(/error_code/);
    expect(
      Object.keys(rulesTools.find((t) => t.name === RULES_GET)!.inputSchema.properties ?? {}),
    ).toContain('error_code');
  });

  it('are written in English', () => {
    const spanish = SYNTHETIC.filter((t) =>
      /\b(para|factura|cuando|usar|regla)\b/i.test(t.description ?? ''),
    ).map((t) => t.name);
    expect(spanish).toEqual([]);
  });
});
