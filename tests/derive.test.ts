import { describe, expect, it } from 'vitest';
import { pathParams, snakeCase, toolName, words } from '../src/spec/derive.js';

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
