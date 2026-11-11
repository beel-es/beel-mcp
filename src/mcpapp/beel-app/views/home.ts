/// <reference lib="dom" />
/** Home: is the company ready to issue, the quarter so far, the latest invoices. */
import { COPY } from '../copy.js';
import { h } from '../dom.js';
import { money, quarterToDate } from '../format.js';
import { activeCompany, isLive, type Invoice } from '../model.js';
import type { ViewEnv } from './env.js';
import { button, COMPACT_ROWS, eyebrow, ledger } from './parts.js';

function companyStatus({ state, ctl }: ViewEnv): HTMLElement | null {
  const company = activeCompany(state);
  if (!company) return null;
  const blockers = company.blockers ?? [];
  const env = isLive(state) ? COPY.app.live : COPY.app.test;
  return h(
    'section',
    { class: 'card card-pad' },
    h(
      'div',
      { class: 'company' },
      h('span', { class: 'title' }, company.legal_name ?? ''),
      h('span', { class: 'mono muted' }, company.nif ?? ''),
    ),
    company.ready
      ? h('p', { class: 'muted' }, COPY.home.ready(env))
      : blockers.length
        ? h(
            'div',
            { class: 'notice warn' },
            h('p', {}, COPY.home.blocked),
            h(
              'ul',
              {},
              blockers.map((b) => h('li', {}, b)),
            ),
            h(
              'div',
              { class: 'actions' },
              button(
                COPY.home.fixWithClaude,
                () =>
                  void ctl.askClaude(
                    COPY.ask.fixSetup(company.legal_name ?? company.company_id, blockers),
                  ),
                { icon: 'askClaude' },
              ),
            ),
          )
        : null,
  );
}

function stat(label: string, value: string): HTMLElement {
  return h(
    'div',
    { class: 'stat' },
    h('span', { class: 'stat-label' }, label),
    h('span', { class: 'stat-value' }, value),
  );
}

export function homeView(env: ViewEnv, now: Date): HTMLElement {
  const { state, ctl, host } = env;
  const s = state.summary;
  const open = (i: Invoice) => void ctl.navigate({ view: 'invoice', invoice_id: i.id }, i);
  if (host.compact) {
    // The card in the conversation: the quarter at a glance and the last three.
    return h(
      'main',
      {},
      h(
        'div',
        { class: 'card stats stats-3' },
        stat(COPY.home.taxableBase, money(s?.total_taxable_base)),
        stat(COPY.home.vat, money(s?.total_vat)),
        stat(COPY.home.count, s?.total_invoices !== undefined ? String(s.total_invoices) : '—'),
      ),
      ledger(state.recent.slice(0, COMPACT_ROWS), open),
    );
  }
  return h(
    'main',
    {},
    companyStatus(env),
    eyebrow(COPY.home.quarter(quarterToDate(now).label)),
    h(
      'div',
      { class: 'card stats' },
      stat(COPY.home.taxableBase, money(s?.total_taxable_base)),
      stat(COPY.home.vat, money(s?.total_vat)),
      stat(COPY.home.irpf, money(s?.total_irpf_withheld)),
      stat(COPY.home.count, s?.total_invoices !== undefined ? String(s.total_invoices) : '—'),
    ),
    h(
      'div',
      { class: 'actions' },
      button(COPY.home.newInvoice, () => void ctl.askClaude(COPY.ask.newInvoice), {
        variant: 'primary',
        icon: 'newInvoice',
      }),
      button(
        COPY.home.unpaid,
        () => void ctl.navigate({ view: 'invoices', filter: 'unpaid', search: '' }),
        { icon: 'markPaid' },
      ),
    ),
    eyebrow(COPY.home.recent),
    ledger(state.recent, open),
  );
}
