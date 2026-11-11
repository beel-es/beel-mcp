/// <reference lib="dom" />
/** The invoice list: search, the status filters, the ledger and the CSV export. */
import { COPY } from '../copy.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { INVOICE_FILTERS, type InvoiceFilter } from '../model.js';
import type { ViewEnv } from './env.js';
import { button, ledger } from './parts.js';

export function searchForm(
  value: string,
  placeholder: string,
  submit: (q: string) => void,
): HTMLElement {
  const input = h('input', {
    attrs: { type: 'search', name: 'q', value, placeholder, 'aria-label': placeholder },
  });
  return h(
    'form',
    {
      class: 'search',
      attrs: { role: 'search' },
      on: {
        submit: (e) => {
          e.preventDefault();
          submit(input.value.trim());
        },
      },
    },
    input,
    h(
      'button',
      { class: 'btn small', attrs: { type: 'submit' } },
      icon('search'),
      COPY.invoices.searchAction,
    ),
  );
}

export function invoicesView({ state, ctl, host }: ViewEnv): HTMLElement {
  const filters = (Object.keys(INVOICE_FILTERS) as InvoiceFilter[]).map((f) =>
    h(
      'button',
      {
        class: 'filter',
        attrs: { type: 'button', 'aria-pressed': state.filter === f ? 'true' : 'false' },
        on: { click: () => void ctl.navigate({ filter: f }) },
      },
      COPY.invoices.filters[f],
    ),
  );
  const footer = h(
    'div',
    { class: 'table-foot' },
    state.totalInvoices !== undefined
      ? h(
          'span',
          { class: 'mono muted' },
          COPY.invoices.shown(state.invoices.length, state.totalInvoices),
        )
      : null,
    h('span', { class: 'spacer' }),
    host.canDownload && state.invoices.length > 0
      ? button(COPY.invoices.exportCsv, () => void ctl.exportCsv(), {
          small: true,
          icon: 'download',
          busy: state.pending === 'csv',
        })
      : null,
  );
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    searchForm(state.search, COPY.invoices.search, (q) => void ctl.navigate({ search: q })),
    h('div', { class: 'filters' }, filters),
  );
  return h(
    'main',
    {},
    ledger(state.invoices, (i) => void ctl.navigate({ view: 'invoice', invoice_id: i.id }), {
      toolbar,
      footer,
    }),
  );
}
