import { describe, expect, it } from 'vitest';
import {
  date,
  invoicesCsv,
  money,
  quarterToDate,
  statusBadge,
  verifactuBadge,
} from '../src/mcpapp/beel-app/format.js';
import { parseRoute, parseShowViewArgs } from '../src/mcpapp/beel-app/route.js';
import { contextSentence, viewState } from '../src/mcpapp/beel-app/context.js';
import { INITIAL_STATE, type AppState } from '../src/mcpapp/beel-app/model.js';
import { isNewer } from '../src/mcpapp/beel-app/supersede.js';
import { fontFaceCss } from '../src/mcpapp/beel-app/fonts.js';
import { BRAND_FONT_PATH } from '../src/mcpapp/contract.js';

describe('BeeL. app formatting', () => {
  it('writes amounts and dates the Spanish way, and a dash for what is missing', () => {
    // Intl separates the symbol with a no-break space.
    expect(money(1210)).toBe('1.210,00\u00a0€');
    expect(money(49)).toBe('49,00\u00a0€');
    expect(money(undefined)).toBe('—');
    expect(money(Number.NaN)).toBe('—');
    expect(date('2026-11-03')).toBe('03/11/2026');
    expect(date('2026-11-03T10:00:00Z')).toBe('03/11/2026');
    expect(date(undefined)).toBe('—');
    expect(date('not a date')).toBe('—');
  });

  it('summarises the calendar quarter to date, in local time', () => {
    expect(quarterToDate(new Date(2026, 10, 11))).toEqual({
      start: '2026-10-01',
      end: '2026-11-11',
      label: 'T4 2026',
    });
    expect(quarterToDate(new Date(2026, 0, 1)).start).toBe('2026-01-01');
  });

  it('shows each status with the web app label and estado tone', () => {
    // The same mapping as the BeeL web app.
    expect(statusBadge('ISSUED')).toEqual({ label: 'Emitida', tone: 'issued' });
    expect(statusBadge('SENT')).toEqual({ label: 'Enviada', tone: 'sent' });
    expect(statusBadge('PAID')).toEqual({ label: 'Cobrada', tone: 'paid' });
    expect(statusBadge('VOIDED')).toEqual({ label: 'Anulada', tone: 'cancelled' });
    expect(statusBadge('SOMETHING_NEW')).toEqual({ label: 'SOMETHING_NEW', tone: 'draft' });
  });

  it('shows VeriFactu as the web app does, and only past the draft', () => {
    const draft = { id: 'i', status: 'DRAFT', verifactu: { submission_status: 'NOT_SUBMITTED' } };
    const review = {
      id: 'i',
      status: 'ISSUED',
      verifactu: { submission_status: 'ACCEPTED_WITH_ERRORS' },
    };
    expect(verifactuBadge(draft)).toBeNull();
    expect(verifactuBadge(review)).toEqual({
      label: 'Por revisar',
      note: 'Por revisar',
      title: 'Registrada en la AEAT, con datos por revisar',
      tone: 'warn',
      shield: 'shieldReview',
      listMarker: 'icon',
    });
    // Pending is information, not a warning: blue, as on the web app.
    expect(
      verifactuBadge({ id: 'i', status: 'ISSUED', verifactu: { submission_status: 'PENDING' } }),
    ).toMatchObject({ tone: 'info', shield: 'shieldPending' });
    expect(
      verifactuBadge({ id: 'i', status: 'ISSUED', verifactu: { submission_status: 'ACCEPTED' } })
        ?.note,
    ).toBeUndefined();
    expect(
      verifactuBadge({ id: 'i', status: 'SENT', verifactu: { submission_status: 'REJECTED' } }),
    ).toMatchObject({ tone: 'danger', note: 'Rechazada', shield: 'shieldRejected' });
  });

  it('exports a CSV a Spanish spreadsheet opens: BOM, semicolons, decimal comma, quoting', () => {
    const csv = invoicesCsv([
      {
        id: 'i1',
        invoice_number: 'F-2026-0001',
        status: 'PAID',
        issue_date: '2026-11-03',
        recipient: { legal_name: 'Acme; "Software" S.L.', nif: 'B12345678' },
        totals: { taxable_base: 1000, total_vat: 210, invoice_total: 1210 },
      },
    ]);
    expect(csv.startsWith('﻿Número;Fecha;')).toBe(true);
    const row = csv.split('\r\n')[1];
    expect(row).toBe(
      'F-2026-0001;2026-11-03;"Acme; ""Software"" S.L.";B12345678;Cobrada;;1000,00;210,00;;1210,00',
    );
  });
});

describe('BeeL. app routing', () => {
  it('reads a route out of structured content, and nothing else', () => {
    expect(parseRoute({ view: 'invoice', invoice_id: 'i1', company_id: 'c1' })).toEqual({
      view: 'invoice',
      invoice_id: 'i1',
      company_id: 'c1',
    });
    expect(parseRoute({ view: 'settings' })).toBeNull();
    expect(parseRoute({ download_url: 'https://x' })).toBeNull();
    expect(parseRoute(undefined)).toBeNull();
  });

  it('validates show_view arguments, which the host does not', () => {
    expect(parseShowViewArgs({ view: 'invoices', status: ['ISSUED', 'SENT', 'OVERDUE'] })).toEqual({
      ok: true,
      value: { view: 'invoices', search: '', filter: 'unpaid' },
    });
    expect(parseShowViewArgs({ view: 'invoices' })).toEqual({
      ok: true,
      value: { view: 'invoices', search: '', filter: 'all' },
    });
    expect(parseShowViewArgs({ view: 'invoice' }).ok).toBe(false);
    expect(parseShowViewArgs({ view: 'nope' }).ok).toBe(false);
    expect(parseShowViewArgs({ view: 'invoices', search: 3 }).ok).toBe(false);
    expect(parseShowViewArgs({ view: 'invoices', status: ['VOIDED'] }).ok).toBe(false);
    // A subset of a filter is not a filter: the list would claim to show what it does not.
    expect(parseShowViewArgs({ view: 'invoices', status: ['SENT'] }).ok).toBe(false);
  });
});

describe('BeeL. app context for Claude', () => {
  const state: AppState = {
    ...INITIAL_STATE,
    phase: 'ready',
    view: 'invoice',
    setup: {
      environment: 'live',
      companies: [{ company_id: 'c1', legal_name: 'Honey Solutions S.L.' }],
    },
    companyId: 'c1',
    invoiceId: 'i1',
    invoice: {
      id: 'i1',
      status: 'DRAFT',
      recipient: { legal_name: 'Acme S.L.' },
      totals: { invoice_total: 121 },
    },
  };

  it('names the environment, the company and the invoice by id, in English', () => {
    const sentence = contextSentence(state);
    expect(sentence).toContain('(Live)');
    expect(sentence).toContain('company_id c1');
    expect(sentence).toContain('invoice_id i1');
    expect(sentence).toContain('status DRAFT');
  });

  it('carries the error on screen, so Claude does not report success', () => {
    const withError = viewState({
      ...state,
      feedback: { tone: 'error', title: 'No.', detail: 'Why.' },
    });
    expect(withError.error).toBe('No. Why.');
    expect(withError.invoice).toMatchObject({ invoice_id: 'i1', total: 121 });
  });
});

describe('BeeL. app instances and fonts', () => {
  it('lets exactly one copy win, ties broken by id', () => {
    expect(isNewer({ startedAt: 2, id: 'a' }, { startedAt: 1, id: 'z' })).toBe(true);
    expect(isNewer({ startedAt: 1, id: 'b' }, { startedAt: 1, id: 'a' })).toBe(true);
    expect(isNewer({ startedAt: 1, id: 'a' }, { startedAt: 1, id: 'b' })).toBe(false);
  });

  it('declares the brand fonts from the server origin and path', () => {
    const css = fontFaceCss('https://mcp.example.test');
    expect(css).toContain(`url("https://mcp.example.test${BRAND_FONT_PATH}/dm-sans-latin.woff2")`);
    expect(css).toContain('font-family:"Geist Mono"');
  });
});
