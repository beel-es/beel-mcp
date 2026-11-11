/// <reference lib="dom" />
/**
 * One invoice: the document, its AEAT state and what can be done with it.
 * Issuing is the one irreversible action here, so it takes two clicks and says
 * which environment it lands in. Correcting and voiding need judgement about
 * what happened, so they go to Claude instead of a button that acts.
 */
import { renderPdf } from '../../pdf-render.js';
import { COPY } from '../copy.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { aeatNeedsAttention, date, money, verifactuBadge, type VerifactuBadge } from '../format.js';
import { isLive, type Invoice } from '../model.js';
import type { ViewEnv } from './env.js';
import { button, skeleton, statusBadgeEl, verifactuChipEl } from './parts.js';

const CLOSED = new Set(['VOIDED', 'RECTIFIED']);

/**
 * The rendered PDF outlives a re-render: marking the invoice paid while reading
 * it must not throw the pages away. Kept for the invoice on screen only.
 */
let pdfBox: { invoiceId: string; el: HTMLElement } | null = null;

function pdfBoxFor(invoiceId: string): HTMLElement {
  if (pdfBox?.invoiceId !== invoiceId) pdfBox = { invoiceId, el: h('div', { class: 'pdf' }) };
  return pdfBox.el;
}

function lines(invoice: Invoice): HTMLElement {
  const c = COPY.invoice.columns;
  return h(
    'table',
    { class: 'lines' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { attrs: { scope: 'col' } }, c.concept),
        h('th', { attrs: { scope: 'col' } }, c.quantity),
        h('th', { class: 'wide', attrs: { scope: 'col' } }, c.price),
        h('th', { attrs: { scope: 'col' } }, c.vat),
        h('th', { attrs: { scope: 'col' } }, c.amount),
      ),
    ),
    h(
      'tbody',
      { class: 'stack' },
      (invoice.lines ?? []).map((l) =>
        h(
          'tr',
          { class: 'dashed' },
          h('td', {}, l.description ?? ''),
          h('td', {}, l.quantity !== undefined ? String(l.quantity) : '—'),
          h('td', { class: 'wide' }, money(l.unit_price)),
          h('td', {}, l.main_tax?.percentage !== undefined ? `${l.main_tax.percentage} %` : '—'),
          h('td', {}, money(l.taxable_base)),
        ),
      ),
    ),
  );
}

function totals(invoice: Invoice): HTMLElement {
  const t = invoice.totals ?? {};
  return h(
    'dl',
    { class: 'totals' },
    h('dt', {}, COPY.invoice.taxableBase),
    h('dd', {}, money(t.taxable_base)),
    h('dt', {}, COPY.invoice.vat),
    h('dd', {}, money(t.total_vat)),
    t.total_irpf ? h('dt', {}, COPY.invoice.irpf) : null,
    t.total_irpf ? h('dd', {}, `−${money(t.total_irpf)}`) : null,
    h('dt', { class: 'grand' }, COPY.invoice.total),
    h('dd', { class: 'grand' }, money(t.invoice_total)),
  );
}

function aeatProblem({ ctl }: ViewEnv, invoice: Invoice): HTMLElement | null {
  if (!aeatNeedsAttention(invoice)) return null;
  const status = invoice.verifactu?.submission_status ?? '';
  const detail = invoice.verifactu?.error_message ?? invoice.verifactu?.error_code ?? '';
  return h(
    'div',
    { class: 'notice error', attrs: { role: 'alert' } },
    h('p', {}, `VeriFactu: ${COPY.aeat[status] ?? status}${detail ? `. ${detail}` : ''}`),
    h(
      'div',
      { class: 'actions' },
      button(
        COPY.invoice.aeatHelp,
        () =>
          void ctl.askClaude(
            COPY.ask.aeat(invoice.invoice_number ?? '', invoice.id, status, detail),
          ),
        { icon: 'askClaude' },
      ),
    ),
  );
}

function confirmIssue({ state, ctl }: ViewEnv): HTMLElement {
  const live = isLive(state);
  return h(
    'div',
    {
      class: live ? 'confirm live' : 'confirm',
      attrs: { role: 'group', 'aria-label': COPY.invoice.issue },
    },
    h('p', {}, live ? COPY.invoice.confirmLive : COPY.invoice.confirmTest),
    h(
      'div',
      { class: 'actions' },
      button(live ? COPY.invoice.issueLive : COPY.invoice.issueTest, () => void ctl.issue(), {
        variant: live ? 'danger' : 'primary',
        icon: 'issue',
        busy: state.pending === 'issue',
      }),
      button(COPY.invoice.cancel, () => ctl.cancelIssue(), { disabled: state.pending === 'issue' }),
    ),
  );
}

function actions(env: ViewEnv, invoice: Invoice, box: HTMLElement): HTMLElement {
  const { state, ctl } = env;
  const busy = (id: typeof state.pending) => state.pending === id;
  const locked = state.superseded || state.pending !== undefined;
  if (invoice.status === 'DRAFT') {
    return h(
      'div',
      { class: 'actions' },
      state.confirmingIssue
        ? null
        : button(COPY.invoice.issue, () => ctl.requestIssue(), {
            variant: 'primary',
            icon: 'issue',
            disabled: locked,
          }),
      h('span', { class: 'muted' }, COPY.invoice.draftHint),
    );
  }
  const open = !CLOSED.has(invoice.status ?? '');
  // The next step is the one primary button: send what was issued, then collect.
  // Not while the AEAT is asking for something: then the next step is fixing it,
  // and the notice above holds that action.
  const canSend = open && !!invoice.recipient?.email;
  const canCollect = open && invoice.status !== 'PAID';
  const next = aeatNeedsAttention(invoice)
    ? undefined
    : canSend && invoice.status === 'ISSUED'
      ? 'send'
      : canCollect
        ? 'paid'
        : undefined;
  const variant = (id: 'send' | 'paid') => (next === id ? 'primary' : 'secondary');
  return h(
    'div',
    { class: 'actions' },
    canSend
      ? button(
          invoice.status === 'SENT' ? COPY.invoice.resend : COPY.invoice.send,
          () => void ctl.send(),
          {
            variant: variant('send'),
            icon: 'send',
            busy: busy('send'),
            disabled: locked,
          },
        )
      : null,
    canCollect
      ? button(COPY.invoice.markPaid, () => void ctl.markPaid(), {
          variant: variant('paid'),
          icon: 'markPaid',
          busy: busy('paid'),
          disabled: locked,
        })
      : null,
    button(COPY.invoice.viewPdf, () => showPdf(env, box), { icon: 'view' }),
    button(COPY.invoice.downloadPdf, () => void ctl.downloadPdf(), {
      icon: 'download',
      busy: busy('pdf'),
      disabled: locked,
    }),
    open
      ? button(
          COPY.invoice.correct,
          () => void ctl.askClaude(COPY.ask.correct(invoice.invoice_number ?? '', invoice.id)),
          { variant: 'danger-outline', icon: 'correct' },
        )
      : null,
  );
}

function showPdf({ ctl }: ViewEnv, box: HTMLElement): void {
  box.replaceChildren(h('p', { class: 'muted' }, COPY.invoice.loadingPdf));
  ctl
    .pdfBytes()
    .then((bytes) => renderPdf(box, bytes))
    .catch((err: unknown) => {
      box.replaceChildren(
        h('p', { class: 'notice error' }, err instanceof Error ? err.message : COPY.failed.pdf),
      );
    });
}

function docHead(invoice: Invoice, vf: VerifactuBadge | null): HTMLElement {
  return h(
    'div',
    { class: 'doc-head' },
    h(
      'span',
      { class: invoice.invoice_number ? 'doc-number' : 'doc-number muted' },
      invoice.invoice_number ?? COPY.invoices.draftNumber,
    ),
    statusBadgeEl(invoice.status),
    vf ? verifactuChipEl(vf) : null,
    h('span', { class: 'doc-total' }, money(invoice.totals?.invoice_total)),
  );
}

export function invoiceView(env: ViewEnv): HTMLElement {
  const { state, ctl, host } = env;
  const invoice = state.invoice;
  const back = h(
    'button',
    {
      class: 'link',
      attrs: { type: 'button' },
      on: { click: () => void ctl.navigate({ view: 'invoices' }) },
    },
    icon('back'),
    COPY.invoice.back,
  );
  if (!invoice) {
    // Still on its way, or truly missing: only a finished load can say which.
    const body =
      state.phase === 'ready' ? h('p', { class: 'empty' }, COPY.invoice.notFound) : skeleton();
    return h('main', {}, host.compact ? null : back, body);
  }

  const box = pdfBoxFor(invoice.id);
  const vf = verifactuBadge(invoice);
  const r = invoice.recipient;
  const meta = [
    r?.legal_name ?? COPY.invoices.noCustomer,
    r?.nif,
    COPY.invoice.issued(date(invoice.issue_date)),
    invoice.due_date ? COPY.invoice.due(date(invoice.due_date)) : undefined,
  ].filter(Boolean);

  if (host.compact) {
    // The card in the conversation: what the invoice is, and issuing for a
    // draft (the step it was opened for); everything else is one click away.
    return h(
      'main',
      { class: 'invoice' },
      h(
        'article',
        { class: 'card card-pad' },
        docHead(invoice, vf),
        h('p', { class: 'doc-meta' }, meta.join(' · ')),
        aeatProblem(env, invoice),
      ),
      invoice.status === 'DRAFT' && state.confirmingIssue ? confirmIssue(env) : null,
      invoice.status === 'DRAFT' ? actions(env, invoice, box) : null,
    );
  }

  return h(
    'main',
    { class: 'invoice' },
    back,
    h(
      'article',
      { class: 'card card-pad' },
      docHead(invoice, vf),
      h('p', { class: 'doc-meta' }, meta.join(' · ')),
      aeatProblem(env, invoice),
      lines(invoice),
      totals(invoice),
    ),
    invoice.status === 'DRAFT' && state.confirmingIssue ? confirmIssue(env) : null,
    actions(env, invoice, box),
    box,
  );
}
