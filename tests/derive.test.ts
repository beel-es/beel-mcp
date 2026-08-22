import { describe, expect, it } from 'vitest';
import { pathParams, snakeCase, toolName, words } from '../src/spec/derive.js';
import { buildApiTools } from '../src/tools/api-tools.js';
import { MAX_TOOL_NAME_LENGTH } from '../src/spec/derive.js';
import { docsTools } from '../src/tools/docs-tools.js';
import { workflowTools } from '../src/tools/workflow-tools.js';

describe('derive', () => {
  it('splits camelCase and acronyms into lowercase words', () => {
    expect(words('downloadInvoicesPdfBulk')).toEqual(['download', 'invoices', 'pdf', 'bulk']);
    expect(words('getVeriFactuConfiguration')).toEqual(['get', 'veri', 'factu', 'configuration']);
  });

  it('snake_cases operationIds', () => {
    expect(snakeCase('createInvoice')).toBe('create_invoice');
    expect(snakeCase('listInvoices')).toBe('list_invoices');
  });

  it('prefixes tool names with beel_', () => {
    expect(toolName('createInvoice')).toBe('beel_create_invoice');
    expect(toolName('markInvoicePaid')).toBe('beel_mark_invoice_paid');
  });

  it('extracts path params in order', () => {
    expect(pathParams('/v1/invoices/{invoice_id}/corrective')).toEqual(['invoice_id']);
    expect(pathParams('/v1/companies/{company_id}/api-keys/{key_id}')).toEqual([
      'company_id',
      'key_id',
    ]);
  });
});

describe('the derived tool surface stays valid as the contract grows', () => {
  const allTools = [
    ...buildApiTools().tools.map((t) => t.tool.name),
    ...docsTools.map((t) => t.name),
    ...workflowTools.map((t) => t.name),
  ];

  it('produces no duplicate tool names', () => {
    // derive.ts asserts names are "unique by construction" because operationIds
    // are. That holds only while snake_casing stays injective: getNIFStatus and
    // getNifStatus would both become get_nif_status. Nothing enforces it but this.
    const seen = new Map<string, number>();
    for (const name of allTools) seen.set(name, (seen.get(name) ?? 0) + 1);
    const duplicates = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
    expect(duplicates).toEqual([]);
  });

  it('produces names every MCP client will accept', () => {
    // Hosts and portals prepend their own server and connector names, and warn
    // past 40 characters. A name that gets truncated or rejected is a tool the
    // model cannot call at all, so this is a hard ceiling rather than a style
    // preference — and it is what the shortening in derive.ts exists to respect.
    const tooLong = allTools.filter((name) => name.length > MAX_TOOL_NAME_LENGTH);
    expect(tooLong).toEqual([]);

    const malformed = allTools.filter((name) => !/^[a-z][a-z0-9_]*$/.test(name));
    expect(malformed).toEqual([]);
  });

  it('shortens only the names that need it', () => {
    // Losing a word costs the model a hint, so it must buy something. Any name
    // missing its "recurring invoice" noun should have been over the limit with it.
    const shortened = buildApiTools().tools.filter((t) => t.tool.name.includes('recurring_next'));
    for (const tool of shortened) {
      const withNoun = tool.tool.name.replace('recurring_', 'recurring_invoice_');
      expect(withNoun.length, tool.tool.name).toBeGreaterThan(MAX_TOOL_NAME_LENGTH);
    }
  });

  it('prefixes every tool, so the namespace is unmistakably ours', () => {
    expect(allTools.filter((name) => !name.startsWith('beel_'))).toEqual([]);
  });
});
