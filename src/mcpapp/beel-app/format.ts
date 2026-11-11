/// <reference lib="es2023.intl" />
/**
 * Formatting for the BeeL. app: amounts, dates, status chips and the CSV export.
 * Pure functions, so the rules (Spanish formats, which state reads as what) are
 * tested without a browser.
 */
import { COPY } from './copy.js';
import type { IconName } from './icons.js';
import type { Invoice } from './model.js';

/**
 * `es-ES` leaves four-digit amounts ungrouped ("1210,00 €"); the brand writes
 * "1.210,00 €" everywhere, so grouping is forced.
 */
const EUR = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
  useGrouping: 'always',
});

/** An amount in euros, Spanish style ("1.210,00 €"); a dash when absent. */
export function money(amount: number | undefined): string {
  return typeof amount === 'number' && Number.isFinite(amount) ? EUR.format(amount) : '—';
}

/** "2026-11-03" (or a full timestamp) as "03/11/2026"; a dash when absent. */
export function date(iso: string | undefined): string {
  const match = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '—';
}

/** A local calendar date as YYYY-MM-DD, the API's date format. */
export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The current calendar quarter, to date: what the home view summarises. */
export function quarterToDate(now: Date): { start: string; end: string; label: string } {
  const quarter = Math.floor(now.getMonth() / 3);
  return {
    start: isoDate(new Date(now.getFullYear(), quarter * 3, 1)),
    end: isoDate(now),
    label: `T${quarter + 1} ${now.getFullYear()}`,
  };
}

/**
 * An invoice status in the BeeL web app's status palette: each API status maps
 * to the same tone and label the web app shows.
 */
export type StatusTone =
  'scheduled' | 'draft' | 'issued' | 'sent' | 'paid' | 'overdue' | 'rectified' | 'cancelled';

const STATUS_TONE: Record<string, StatusTone> = {
  SCHEDULED: 'scheduled',
  DRAFT: 'draft',
  ISSUED: 'issued',
  SENT: 'sent',
  PAID: 'paid',
  OVERDUE: 'overdue',
  RECTIFIED: 'rectified',
  VOIDED: 'cancelled',
};

export interface StatusBadge {
  label: string;
  tone: StatusTone;
}

export function statusBadge(status: string | undefined): StatusBadge {
  return {
    label: COPY.status[status ?? ''] ?? status ?? '—',
    // A status the web app has no tone for reads as a draft: neutral grey.
    tone: STATUS_TONE[status ?? ''] ?? 'draft',
  };
}

/** The semantic tones of the BeeL web app's badges. */
export type Tone = 'ok' | 'info' | 'warn' | 'danger' | 'neutral';

/** The VeriFactu state as the BeeL web app shows it. */
export interface VerifactuBadge {
  /** The state, as the list column says it. */
  label: string;
  /** What the invoice page's chip adds after "VeriFactu", when there is something to do. */
  note?: string;
  /** The longer sentence the chip's tooltip carries. */
  title: string;
  tone: Tone;
  shield: IconName;
  /** In a list the icon replaces the dot: the state to look at twice. */
  listMarker: 'dot' | 'icon';
}

const VERIFACTU: Record<string, Pick<VerifactuBadge, 'tone' | 'shield' | 'listMarker'>> = {
  PENDING: { tone: 'info', shield: 'shieldPending', listMarker: 'dot' },
  ACCEPTED: { tone: 'ok', shield: 'shieldAccepted', listMarker: 'dot' },
  ACCEPTED_WITH_ERRORS: { tone: 'warn', shield: 'shieldReview', listMarker: 'icon' },
  VOIDED: { tone: 'neutral', shield: 'shieldVoided', listMarker: 'dot' },
  REJECTED: { tone: 'danger', shield: 'shieldRejected', listMarker: 'dot' },
  NOT_SUBMITTED: { tone: 'warn', shield: 'shieldNotSubmitted', listMarker: 'dot' },
};

/** The VeriFactu state, for an invoice past the draft; `null` when there is none. */
export function verifactuBadge(invoice: Invoice): VerifactuBadge | null {
  const state = invoice.verifactu?.submission_status;
  if (!state || invoice.status === 'DRAFT') return null;
  const spec = VERIFACTU[state] ?? {
    tone: 'neutral',
    shield: 'shieldNotSubmitted',
    listMarker: 'dot',
  };
  const note = COPY.verifactu.note[state];
  return {
    label: COPY.aeat[state] ?? state,
    ...(note ? { note } : {}),
    title: COPY.verifactu.title[state] ?? COPY.aeat[state] ?? state,
    ...spec,
  };
}

/** Whether the AEAT returned something the user has to act on. */
export function aeatNeedsAttention(invoice: Invoice): boolean {
  const state = invoice.verifactu?.submission_status;
  return state === 'REJECTED' || state === 'ACCEPTED_WITH_ERRORS';
}

/**
 * The invoices shown, as a CSV a spreadsheet in Spanish opens directly:
 * semicolon-separated, a BOM so accents survive, decimal comma in amounts.
 */
export function invoicesCsv(invoices: readonly Invoice[]): string {
  const cell = (value: string): string =>
    /[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const amount = (n: number | undefined): string =>
    typeof n === 'number' ? n.toFixed(2).replace('.', ',') : '';
  const header = [
    'Número',
    'Fecha',
    'Cliente',
    'NIF',
    'Estado',
    'AEAT',
    'Base',
    'IVA',
    'IRPF',
    'Total',
  ];
  const rows = invoices.map((i) => [
    i.invoice_number ?? COPY.invoices.draftNumber,
    i.issue_date?.slice(0, 10) ?? '',
    i.recipient?.legal_name ?? '',
    i.recipient?.nif ?? '',
    COPY.status[i.status ?? ''] ?? i.status ?? '',
    i.verifactu?.submission_status ?? '',
    amount(i.totals?.taxable_base),
    amount(i.totals?.total_vat),
    amount(i.totals?.total_irpf),
    amount(i.totals?.invoice_total),
  ]);
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
}
