import { describe, expect, it } from 'vitest';
import { pathParams, snakeCase, toolName, words } from '../src/spec/derive.js';
import { buildApiTools } from '../src/tools/api-tools.js';
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
    // Clients validate tool names, and several cap them at 64 characters. A new
    // deeply-nested operation could cross that and be silently dropped from the
    // tool list rather than fail loudly.
    const invalid = allTools.filter((name) => !/^[a-z][a-z0-9_]{0,63}$/.test(name));
    expect(invalid).toEqual([]);
  });

  it('prefixes every tool, so the namespace is unmistakably ours', () => {
    expect(allTools.filter((name) => !name.startsWith('beel_'))).toEqual([]);
  });
});
