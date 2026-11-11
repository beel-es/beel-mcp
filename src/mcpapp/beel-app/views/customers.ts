/// <reference lib="dom" />
/**
 * Customers: find one, see their invoices, or ask Claude to invoice them. Adding
 * a customer goes through Claude, which collects the fiscal data and checks the
 * NIF against the AEAT census on the way.
 */
import { COPY } from '../copy.js';
import { h } from '../dom.js';
import type { ViewEnv } from './env.js';
import { searchForm } from './invoices.js';
import { button } from './parts.js';

export function customersView({ state, ctl }: ViewEnv): HTMLElement {
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    searchForm(state.search, COPY.customers.search, (q) => void ctl.navigate({ search: q })),
    button(COPY.customers.newCustomer, () => void ctl.askClaude(COPY.ask.newCustomer), {
      small: true,
      icon: 'newCustomer',
    }),
  );
  const rows = state.customers.map((c) => {
    const name = c.legal_name ?? c.trade_name ?? c.id;
    return h(
      'div',
      { class: 'customer dashed' },
      h(
        'div',
        { class: 'customer-main' },
        h('span', {}, name),
        h('span', { class: 'mono muted' }, [c.nif, c.email].filter(Boolean).join(' · ')),
      ),
      button(
        COPY.customers.invoice,
        () => void ctl.askClaude(COPY.ask.invoiceCustomer(name, c.id)),
        {
          small: true,
          variant: 'primary',
          icon: 'newInvoice',
        },
      ),
      button(
        COPY.customers.theirInvoices,
        () => void ctl.navigate({ view: 'invoices', search: c.nif ?? name, filter: 'all' }),
        { small: true, icon: 'search' },
      ),
    );
  });
  return h(
    'main',
    {},
    h(
      'div',
      { class: 'card' },
      toolbar,
      rows.length
        ? h('div', { class: 'stack' }, rows)
        : h('p', { class: 'empty' }, COPY.customers.empty),
    ),
  );
}
