import { describe, expect, it } from 'vitest';
import { loadSpec } from '../src/spec/load.js';
import { buildManifest } from '../src/spec/manifest.js';
import { applyToolPolicy } from '../src/policy/tool-policy.js';
import { requiredScopes } from '../src/policy/scopes.js';
import { DEFAULT_EXCLUDED_TAGS } from '../src/policy/tool-policy.js';
import { tags as specTags } from '../src/spec/tags.js';

const manifest = buildManifest(loadSpec());
const { tools, excluded } = applyToolPolicy(manifest);

const includedIds = new Set(tools.map((t) => t.operationId));
const reasonFor = (id: string) => excluded.find((e) => e.op.operationId === id)?.reason;

describe('tool policy', () => {
  it('includes the core company-scoped invoicing operations', () => {
    for (const id of [
      'createCompanyInvoice',
      'listCompanyInvoices',
      'voidCompanyInvoice',
      'validateNif',
    ]) {
      expect(includedIds.has(id)).toBe(true);
    }
  });

  it('excludes deprecated legacy operations superseded by the company-scoped API', () => {
    for (const id of ['createInvoice', 'listInvoices', 'voidInvoice', 'issueInvoice']) {
      expect(reasonFor(id)).toBe('deprecated');
    }
  });

  it('names the tag an exclusion matched, rather than one reason for all of them', () => {
    // A single reason standing for every excluded family would misreport the
    // next tag added to DEFAULT_EXCLUDED_TAGS as webhook plumbing.
    expect(reasonFor('createWebhookSubscription')).toBe('excluded-tag:Webhooks');
    expect(reasonFor('listWebhookDeliveries')).toBe('excluded-tag:Webhooks');
  });

  it('excludes every tag it means to, because each one exists in the contract', () => {
    // A tag renamed upstream stops excluding anything, and the operations it
    // covered appear as tools without anyone deciding they should.
    const unknown = [...DEFAULT_EXCLUDED_TAGS].filter((tag) => !specTags().has(tag));
    expect(unknown).toEqual([]);
  });

  it('excludes operations this server cannot authenticate', () => {
    // The server holds an API key and nothing else. An operation offering only a
    // session cookie could answer nothing but 401, so exposing it as a tool
    // spends the model's attention on a call that cannot work.
    expect(reasonFor('putAccountOwner')).toBe('session-only');
  });

  it('excludes binary downloads', () => {
    expect(reasonFor('createCompanyInvoiceExport')).toBe('binary-response');
    expect(reasonFor('previewCompanyInvoicePdf')).toBe('binary-response');
  });

  it('excludes multipart uploads', () => {
    expect(reasonFor('createCompanyCustomerImport')).toBe('multipart-upload');
    expect(reasonFor('submitCompanyRepresentation')).toBe('multipart-upload');
  });

  it('every operation is either included or excluded, never both', () => {
    expect(tools.length + excluded.length).toBe(manifest.length);
    for (const e of excluded) expect(includedIds.has(e.op.operationId)).toBe(false);
  });

  it('requiredScopes is the union of scopes across exposed tools, least-privilege', () => {
    const scopes = requiredScopes(manifest);
    // Resources the MCP genuinely operates on must be requestable...
    for (const s of [
      'invoices:read',
      'invoices:write',
      'products:read',
      'companies:list',
      'nif:validate',
    ]) {
      expect(scopes).toContain(s);
    }
    // ...and it must not invent scopes no exposed tool declares.
    const declared = new Set(tools.flatMap((t) => t.scopes));
    for (const s of scopes) expect(declared.has(s)).toBe(true);
  });

  it('honours explicit include overrides', () => {
    const forced = applyToolPolicy(manifest, {
      includedOperationIds: new Set(['exportInvoicesExcel']),
    });
    expect(forced.tools.some((t) => t.operationId === 'exportInvoicesExcel')).toBe(true);
  });
});
