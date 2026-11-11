/// <reference lib="dom" />
/**
 * The pieces every view uses, drawn as the BeeL web app draws them: status and
 * VeriFactu badges, buttons, the eyebrow label, the feedback notice and the
 * invoice ledger shared by two views.
 */
import { COPY } from '../copy.js';
import { h, type Child } from '../dom.js';
import { icon, type IconName } from '../icons.js';
import { date, money, statusBadge, verifactuBadge, type VerifactuBadge } from '../format.js';
import type { Feedback, Invoice } from '../model.js';

/** The invoice status badge: `badge-<tone>` is the web app's fill, text and hairline for that status. */
export function statusBadgeEl(status: string | undefined): HTMLElement {
  const b = statusBadge(status);
  return h('span', { class: `badge badge-${b.tone}` }, b.label);
}

/**
 * VeriFactu on the invoice page, as the web app shows it: an outline
 * badge with the state's shield, "VeriFactu", and a note when there is
 * something to do, both in the state's tone.
 */
export function verifactuChipEl(v: VerifactuBadge): HTMLElement {
  return h(
    'span',
    { class: 'badge badge-outline', attrs: { title: v.title } },
    h('span', { class: `tone-text-${v.tone}` }, icon(v.shield, 14)),
    h('span', {}, COPY.verifactu.name),
    v.note ? h('span', { class: `tone-text-${v.tone}` }, `· ${v.note}`) : null,
  );
}

/** VeriFactu as a list cell: a dot (or the icon, for what needs a second look) and the label. */
function verifactuCell(invoice: Invoice): HTMLElement {
  const v = verifactuBadge(invoice);
  if (!v) return h('span', { class: 'wide muted' }, '—');
  const marker =
    v.listMarker === 'icon'
      ? h('span', { class: `vf-icon tone-text-${v.tone}` }, icon('review', 14))
      : h('span', { class: `vf-dot tone-dot-${v.tone}` });
  return h(
    'span',
    { class: 'wide vf-cell', attrs: { title: v.title } },
    marker,
    h('span', {}, v.label),
  );
}

interface ButtonOptions {
  /**
   * One primary per screen: the next step. `danger-outline`, as in the web app,
   * for an action on a fiscal record that cannot be undone.
   */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline';
  small?: boolean;
  /** What the button does, the web app's icon for it; the label still names it. */
  icon?: IconName;
  /** Shows the working label and blocks a second click. */
  busy?: boolean;
  disabled?: boolean;
}

export function button(
  label: string,
  onClick: () => void,
  o: ButtonOptions = {},
): HTMLButtonElement {
  const cls = ['btn', o.variant !== 'secondary' && o.variant, o.small && 'small'].filter(Boolean);
  return h(
    'button',
    {
      class: cls.join(' '),
      attrs: { type: 'button', disabled: o.busy || o.disabled, 'aria-busy': o.busy },
      on: { click: onClick },
    },
    o.icon ? icon(o.icon) : null,
    o.busy ? COPY.invoice.working : label,
  );
}

export const eyebrow = (text: string): HTMLElement => h('h2', { class: 'eyebrow' }, text);

export function notice(feedback: Feedback | undefined): HTMLElement | null {
  if (!feedback) return null;
  return h(
    'div',
    {
      class: `notice ${feedback.tone}`,
      attrs: { role: feedback.tone === 'error' ? 'alert' : 'status' },
    },
    h('p', {}, feedback.title),
    feedback.detail ? h('p', { class: 'muted' }, feedback.detail) : null,
  );
}

/** The ledger: the invoice table, one grid for its header and rows. */
export function ledger(
  invoices: readonly Invoice[],
  open: (invoice: Invoice) => void,
  slots: { toolbar?: Child; footer?: Child } = {},
): HTMLElement {
  const cols = COPY.invoices.columns;
  const head = h(
    'div',
    { class: 'ledger-row ledger-head', attrs: { 'aria-hidden': true } },
    h('span', {}, cols.number),
    h('span', { class: 'wide' }, cols.customer),
    h('span', { class: 'wide right' }, cols.total),
    h('span', {}, cols.status),
    h('span', { class: 'wide' }, cols.verifactu),
  );
  const rows = invoices.map((invoice) =>
    h(
      'button',
      { class: 'ledger-row dashed', attrs: { type: 'button' }, on: { click: () => open(invoice) } },
      h(
        'span',
        { class: 'truncate' },
        invoice.invoice_number
          ? h('span', { class: 'mono' }, invoice.invoice_number)
          : h('span', { class: 'muted' }, COPY.invoices.draftNumber),
        h(
          'span',
          { class: 'ledger-sub mono' },
          `${money(invoice.totals?.invoice_total)} · ${date(invoice.issue_date)}`,
        ),
      ),
      h(
        'span',
        { class: 'wide truncate muted' },
        invoice.recipient?.legal_name ?? COPY.invoices.noCustomer,
      ),
      h('span', { class: 'wide right mono' }, money(invoice.totals?.invoice_total)),
      h('span', {}, statusBadgeEl(invoice.status)),
      verifactuCell(invoice),
    ),
  );
  return h(
    'div',
    { class: 'card' },
    slots.toolbar ?? null,
    head,
    rows.length
      ? h('div', { class: 'stack' }, rows)
      : h('p', { class: 'empty' }, COPY.invoices.empty),
    slots.footer ?? null,
  );
}
