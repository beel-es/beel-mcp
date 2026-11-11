/// <reference lib="dom" />
/** The frame around every view: logo, company, environment and the tabs. */
import logo from '../../../../assets/beel-app/logo.svg';
import type { BeelAppView } from '../../contract.js';
import { COPY } from '../copy.js';
import { h, svg } from '../dom.js';
import { isLive } from '../model.js';
import type { ViewEnv } from './env.js';
import { button, notice } from './parts.js';

const TABS: ReadonlyArray<[BeelAppView, string]> = [
  ['home', COPY.tabs.home],
  ['invoices', COPY.tabs.invoices],
  ['customers', COPY.tabs.customers],
];

function companyPicker({ state, ctl }: ViewEnv): HTMLElement | null {
  const companies = state.setup?.companies ?? [];
  if (companies.length === 0) return null;
  if (companies.length === 1) {
    return h(
      'span',
      { class: 'muted truncate' },
      companies[0]!.legal_name ?? companies[0]!.nif ?? '',
    );
  }
  return h(
    'select',
    {
      class: 'company-select',
      attrs: { 'aria-label': COPY.company.select },
      on: {
        change: (e) => void ctl.navigate({ company_id: (e.target as HTMLSelectElement).value }),
      },
    },
    companies.map((c) =>
      h(
        'option',
        { attrs: { value: c.company_id, selected: c.company_id === state.companyId } },
        c.legal_name ?? c.nif ?? c.company_id,
      ),
    ),
  );
}

export function shell(env: ViewEnv, body: HTMLElement): HTMLElement {
  const { state, ctl, host } = env;
  const environment = state.setup?.environment;
  // The list owns the invoice detail: its tab stays current there.
  const current = state.view === 'invoice' ? 'invoices' : state.view;
  return h(
    'div',
    { class: 'app' },
    h(
      'header',
      { class: 'topbar' },
      h(
        'div',
        { class: 'topbar-row' },
        h('span', { class: 'logo' }, svg(logo)),
        companyPicker(env),
        environment
          ? h(
              'span',
              { class: `badge ${isLive(state) ? 'mode-live' : 'mode-test'}` },
              isLive(state) ? COPY.app.live : COPY.app.test,
            )
          : null,
        h('span', { class: 'spacer' }),
        host.canExpand ? button(COPY.app.expand, host.expand, { small: true }) : null,
      ),
      h(
        'nav',
        { class: 'tabs' },
        TABS.map(([view, label]) =>
          h(
            'button',
            {
              class: 'tab',
              attrs: { type: 'button', 'aria-current': current === view ? 'page' : undefined },
              on: { click: () => void ctl.navigate({ view, search: '', filter: 'all' }) },
            },
            label,
          ),
        ),
      ),
    ),
    state.superseded
      ? h('div', { class: 'notice warn superseded' }, h('p', {}, COPY.superseded))
      : null,
    notice(state.feedback),
    body,
  );
}
