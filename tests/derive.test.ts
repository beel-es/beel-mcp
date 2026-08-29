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

  it('keeps the subject noun when the operation is addressed by id', () => {
    // `getCompanyById` names its subject with the very word the scope filter
    // removes. Dropping it leaves `get_by_id`: a verb, a preposition and the name
    // of a path parameter — nothing a model can map back to a resource. So the
    // `ById` suffix is what goes (the id is already a required input), and the
    // scope word stays, because here it IS the subject.
    expect(snakeCase('getCompanyById')).toBe('get_company');
    expect(snakeCase('patchCompanyById')).toBe('patch_company');
    expect(snakeCase('deleteCompanyById')).toBe('delete_company');
    expect(snakeCase('activateCompanyById')).toBe('activate_company');
    expect(snakeCase('deactivateCompanyById')).toBe('deactivate_company');
    expect(snakeCase('deleteCompanyLogoById')).toBe('delete_company_logo');
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

  it('names no tool after a path parameter', () => {
    // A name ending in `_by_id` says how the resource is addressed, never what it
    // is. Every tool takes ids as inputs, so the suffix distinguishes nothing.
    expect(allTools.filter((name) => /^beel_[a-z0-9_]+_by_id$/.test(name))).toEqual([]);
  });

  it('prefixes every tool, so the namespace is unmistakably ours', () => {
    expect(allTools.filter((name) => !name.startsWith('beel_'))).toEqual([]);
  });
});
