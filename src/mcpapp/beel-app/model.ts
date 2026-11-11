/**
 * The data the BeeL. app reads, as the API returns it. Only the fields the app
 * uses are named, and every one is optional: the view degrades to a dash rather
 * than failing on a field a payload leaves out.
 */
import type { BeelAppView } from '../contract.js';

export type Environment = 'test' | 'live';

export interface Company {
  company_id: string;
  nif?: string;
  legal_name?: string;
  ready?: boolean | null;
  blockers?: string[];
}

/** `beel_get_setup_status`. */
export interface Setup {
  environment?: Environment;
  companies?: Company[];
}

export interface InvoiceLine {
  description?: string;
  quantity?: number;
  unit_price?: number;
  main_tax?: { percentage?: number };
  taxable_base?: number;
}

export interface Invoice {
  id: string;
  invoice_number?: string;
  status?: string;
  issue_date?: string;
  due_date?: string;
  recipient?: { legal_name?: string; nif?: string; email?: string };
  lines?: InvoiceLine[];
  totals?: {
    taxable_base?: number;
    total_vat?: number;
    total_irpf?: number;
    invoice_total?: number;
  };
  verifactu?: { submission_status?: string; error_message?: string; error_code?: string };
}

export interface Customer {
  id: string;
  legal_name?: string;
  trade_name?: string;
  nif?: string;
  email?: string;
}

export interface FiscalSummary {
  total_taxable_base?: number;
  total_vat?: number;
  total_irpf_withheld?: number;
  total_invoices?: number;
}

/** The list filters, each a set of the API's invoice statuses. */
export const INVOICE_FILTERS = {
  all: [],
  drafts: ['DRAFT'],
  unpaid: ['ISSUED', 'SENT', 'OVERDUE'],
  paid: ['PAID'],
} as const satisfies Record<string, readonly string[]>;
export type InvoiceFilter = keyof typeof INVOICE_FILTERS;

/** The filter that is exactly these statuses, or `undefined` when none is. */
export function filterFor(statuses: readonly string[]): InvoiceFilter | undefined {
  const key = [...statuses].sort().join(',');
  return (Object.keys(INVOICE_FILTERS) as InvoiceFilter[]).find(
    (f) => [...INVOICE_FILTERS[f]].sort().join(',') === key,
  );
}

/** A user action that calls the API; at most one runs at a time. */
export type ActionId = 'issue' | 'send' | 'paid' | 'pdf' | 'csv';

export interface Feedback {
  tone: 'ok' | 'error';
  title: string;
  /** The server's own explanation, when there is one. */
  detail?: string;
}

export interface AppState {
  /** `connecting` until the host routes the view; `loading` while a view loads. */
  phase: 'connecting' | 'loading' | 'ready';
  view: BeelAppView;
  setup?: Setup;
  companyId?: string;
  invoiceId?: string;
  search: string;
  filter: InvoiceFilter;
  summary?: FiscalSummary;
  recent: Invoice[];
  invoices: Invoice[];
  totalInvoices?: number;
  invoice?: Invoice;
  customers: Customer[];
  pending?: ActionId;
  confirmingIssue: boolean;
  feedback?: Feedback;
  /** A newer panel was opened in this conversation; this one only shows. */
  superseded: boolean;
}

export const INITIAL_STATE: AppState = {
  phase: 'connecting',
  view: 'home',
  search: '',
  filter: 'all',
  recent: [],
  invoices: [],
  customers: [],
  confirmingIssue: false,
  superseded: false,
};

export const activeCompany = (s: AppState): Company | undefined =>
  s.setup?.companies?.find((c) => c.company_id === s.companyId);

export const isLive = (s: AppState): boolean => s.setup?.environment === 'live';
