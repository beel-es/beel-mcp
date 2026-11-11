/**
 * What the app tells Claude about the screen (`updateModelContext`) and answers
 * when Claude asks (`get_view_state`). Agent-facing, so in English like every
 * other string this server writes for a model; ids are always included, because
 * acting on what the user sees means calling a tool with them.
 */
import { activeCompany, isLive, type AppState, type Invoice } from './model.js';

const summary = (i: Invoice) => ({
  invoice_id: i.id,
  number: i.invoice_number ?? null,
  status: i.status,
  customer: i.recipient?.legal_name,
  total: i.totals?.invoice_total,
  aeat: i.verifactu?.submission_status,
});

/** The screen as data: the structured half of the context, and `get_view_state`. */
export function viewState(s: AppState): Record<string, unknown> {
  const company = activeCompany(s);
  const state: Record<string, unknown> = {
    view: s.view,
    environment: s.setup?.environment,
    company_id: s.companyId,
    company: company?.legal_name,
  };
  if (s.feedback?.tone === 'error') {
    state.error = [s.feedback.title, s.feedback.detail].filter(Boolean).join(' ');
  }
  if (s.view === 'invoice' && s.invoice) state.invoice = summary(s.invoice);
  if (s.view === 'invoices') {
    state.filter = s.filter;
    state.search = s.search || undefined;
    state.invoices = s.invoices.map(summary);
  }
  if (s.view === 'customers') {
    state.search = s.search || undefined;
    state.customers = s.customers.map((c) => ({
      customer_id: c.id,
      name: c.legal_name,
      nif: c.nif,
    }));
  }
  return state;
}

/** One sentence for the model: where the user is and what they are looking at. */
export function contextSentence(s: AppState): string {
  const company = activeCompany(s);
  const where =
    `The user has the BeeL. app open (${isLive(s) ? 'Live' : 'Test'})` +
    (company
      ? ` on ${company.legal_name ?? company.company_id} (company_id ${company.company_id})`
      : '');
  switch (s.view) {
    case 'invoice': {
      const i = s.invoice;
      if (!i) return `${where}, on an invoice that could not be loaded.`;
      return (
        `${where}, looking at invoice ${i.invoice_number ?? '(draft)'} (invoice_id ${i.id}), ` +
        `status ${i.status ?? 'unknown'}, customer ${i.recipient?.legal_name ?? 'none'}, ` +
        `total ${i.totals?.invoice_total ?? 'unknown'} EUR. "This invoice" means this one.`
      );
    }
    case 'invoices':
      return (
        `${where}, looking at the invoice list (filter ${s.filter}` +
        `${s.search ? `, search "${s.search}"` : ''}, ${s.invoices.length} shown).`
      );
    case 'customers':
      return `${where}, looking at the customer list (${s.customers.length} shown).`;
    default:
      return `${where}, on the home view.`;
  }
}
