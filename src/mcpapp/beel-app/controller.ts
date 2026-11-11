/**
 * The BeeL. app's behaviour: navigation, loading and the user's actions. It
 * owns every write to the store and talks to the host through `HostPort`, so it
 * runs, and is tested, without a host or a DOM.
 */
import { proxiedPdfUrl } from '../pdf-render.js';
import type { BeelClient } from './client.js';
import { contextSentence, viewState } from './context.js';
import { COPY } from './copy.js';
import { invoicesCsv, isoDate, quarterToDate } from './format.js';
import {
  INVOICE_FILTERS,
  isLive,
  type ActionId,
  type AppState,
  type Feedback,
  type Invoice,
} from './model.js';
import type { NavigationTarget } from './route.js';
import type { Store } from './store.js';

/** What the app needs from its host; the App instance in production. */
export interface HostPort {
  /** Hand a message to Claude in the user's voice; resolves whether it was accepted. */
  sendMessage(text: string): Promise<boolean>;
  updateModelContext(text: string, structured: Record<string, unknown>): Promise<void>;
  canDownload(): boolean;
  /** Save a file on the user's device; resolves whether the download started. */
  download(
    file: { name: string; mimeType: string } & ({ text: string } | { base64: string }),
  ): Promise<boolean>;
  openLink(url: string): Promise<void>;
  fetchBytes(url: string): Promise<ArrayBuffer>;
}

/** Rows a list asks for: one screen's worth, not an export. */
const PAGE_SIZE = { recent: 5, invoices: 25, customers: 50 } as const;

/** A failure whose message is already written for the user (from COPY). */
class UserFacingError extends Error {
  override name = 'UserFacingError';
}

/**
 * The feedback for a failed load or action. A message written for the user
 * stands alone; anything else (the server's explanation, a network error) is
 * the detail under the action's own headline.
 */
function failureFeedback(headline: string, err: unknown): Feedback {
  if (err instanceof UserFacingError) return { tone: 'error', title: err.message };
  const detail = err instanceof Error ? err.message : undefined;
  return { tone: 'error', title: headline, detail };
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // In chunks: spreading a large array into fromCharCode overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export class Controller {
  private setupLoaded: Promise<void> | null = null;
  private requestedCompany: string | undefined;
  /** Bumped on every load, so a slow answer for a view already left is dropped. */
  private loadSeq = 0;

  constructor(
    private readonly store: Store<AppState>,
    private readonly client: BeelClient,
    private readonly host: HostPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── Navigation ─────────────────────────────────────────────────────────────

  /** Remember the company a tool call named, before its result routes the view. */
  preferCompany(companyId: string): void {
    this.requestedCompany = companyId;
  }

  /**
   * Go to a view. `preload` is the invoice when the caller already holds it (a
   * row of the list, the result of creating it): it is shown at once and
   * refreshed behind it, instead of waiting a round trip on a blank panel.
   */
  navigate(target: NavigationTarget, preload?: Invoice): Promise<void> {
    const s = this.store.get();
    const patch: Partial<AppState> = { confirmingIssue: false, feedback: undefined };
    if (target.view) patch.view = target.view;
    if (target.invoice_id && target.invoice_id !== s.invoice?.id) {
      patch.invoiceId = target.invoice_id;
      // Never show one invoice under another's id while the right one loads.
      patch.invoice = preload?.id === target.invoice_id ? preload : undefined;
    }
    if (target.search !== undefined) patch.search = target.search;
    if (target.filter) patch.filter = target.filter;
    if (target.company_id) {
      this.requestedCompany = target.company_id;
      if (s.setup?.companies?.some((c) => c.company_id === target.company_id)) {
        patch.companyId = target.company_id;
      }
    }
    // An invoice view with no invoice has nothing to show: the list does.
    if ((patch.view ?? s.view) === 'invoice' && !(patch.invoiceId ?? s.invoiceId)) {
      patch.view = 'invoices';
    }
    this.store.set(patch);
    return this.load();
  }

  /** Reload everything, the account's companies included. */
  refresh(): Promise<void> {
    this.setupLoaded = null;
    return this.load();
  }

  private ensureSetup(): Promise<void> {
    this.setupLoaded ??= this.client.setup().then(
      (setup) => {
        const companies = setup.companies ?? [];
        const preferred = companies.find((c) => c.company_id === this.requestedCompany);
        this.store.set({ setup, companyId: (preferred ?? companies[0])?.company_id });
      },
      (err: unknown) => {
        // Not cached: the next load retries instead of replaying the failure.
        this.setupLoaded = null;
        throw err;
      },
    );
    return this.setupLoaded;
  }

  /**
   * Load the current view. What is on screen stays there meanwhile (the views
   * mark it as refreshing), so moving around never blanks the panel.
   */
  private async load(): Promise<void> {
    const seq = ++this.loadSeq;
    // The first load waits for the account only when it has to: a company the
    // tool call already named lets the view and the account load side by side.
    if (!this.store.get().companyId && this.requestedCompany) {
      this.store.set({ companyId: this.requestedCompany });
    }
    this.store.set({ phase: this.store.get().phase === 'connecting' ? 'connecting' : 'loading' });
    let patch: Partial<AppState>;
    try {
      const companyId = this.store.get().companyId;
      if (companyId) {
        const [, view] = await Promise.all([this.ensureSetup(), this.fetchView(this.store.get())]);
        // The account may have settled on another company than the one assumed.
        patch =
          this.store.get().companyId === companyId ? view : await this.fetchView(this.store.get());
      } else {
        await this.ensureSetup();
        patch = await this.fetchView(this.store.get());
      }
    } catch (err) {
      patch = { feedback: failureFeedback(COPY.failed.load, err) };
    }
    if (seq !== this.loadSeq) return;
    this.store.set({ ...patch, phase: 'ready' });
    this.shareContext();
  }

  private async fetchView(s: AppState): Promise<Partial<AppState>> {
    const companyId = s.companyId;
    if (!companyId) return { feedback: { tone: 'error', title: COPY.failed.noCompany } };
    switch (s.view) {
      case 'home': {
        const q = quarterToDate(this.now());
        const [summary, recent] = await Promise.all([
          // The figures are a summary: without them the home view still works.
          this.client.fiscalSummary(companyId, q.start, q.end).catch(() => undefined),
          this.client.invoices(companyId, { limit: PAGE_SIZE.recent }),
        ]);
        return { summary, recent: recent.invoices };
      }
      case 'invoices': {
        const page = await this.client.invoices(companyId, {
          search: s.search || undefined,
          status: INVOICE_FILTERS[s.filter],
          limit: PAGE_SIZE.invoices,
        });
        return { invoices: page.invoices, totalInvoices: page.total };
      }
      case 'invoice':
        return { invoice: await this.client.invoice(companyId, s.invoiceId!) };
      case 'customers':
        return {
          customers: await this.client.customers(
            companyId,
            s.search || undefined,
            PAGE_SIZE.customers,
          ),
        };
    }
  }

  // ── Talking to Claude ──────────────────────────────────────────────────────

  /** Tell Claude what is on screen, so "issue it" or "send it" needs no explaining. */
  shareContext(): void {
    const s = this.store.get();
    if (s.superseded || s.phase !== 'ready') return;
    void this.host.updateModelContext(contextSentence(s), viewState(s)).catch(() => undefined);
  }

  /** Hand a request that needs judgement (correct, void, a new invoice) to Claude. */
  async askClaude(text: string): Promise<void> {
    if (this.store.get().superseded) return;
    const accepted = await this.host.sendMessage(text).catch(() => false);
    this.store.set({
      feedback: accepted
        ? { tone: 'ok', title: COPY.done.toClaude }
        : { tone: 'error', title: COPY.failed.toClaude },
    });
  }

  markSuperseded(): void {
    this.store.set({ superseded: true, confirmingIssue: false });
  }

  // ── Actions on the open invoice ────────────────────────────────────────────

  requestIssue(): void {
    this.store.set({ confirmingIssue: true, feedback: undefined });
  }

  cancelIssue(): void {
    this.store.set({ confirmingIssue: false });
  }

  issue(): Promise<void> {
    return this.onInvoice('issue', COPY.failed.issue, async (companyId, invoiceId) => {
      const invoice = await this.client.issue(companyId, invoiceId);
      const number = invoice.invoice_number ?? '';
      const title = isLive(this.store.get())
        ? COPY.done.issuedLive(number)
        : COPY.done.issuedTest(number);
      return { invoice, confirmingIssue: false, feedback: { tone: 'ok', title } };
    });
  }

  send(): Promise<void> {
    return this.onInvoice('send', COPY.failed.send, async (companyId, invoiceId) => {
      const sent = await this.client.send(companyId, invoiceId);
      const invoice = await this.client.invoice(companyId, invoiceId);
      const to = (sent.sent_to?.length ? sent.sent_to : [invoice.recipient?.email ?? '']).join(
        ', ',
      );
      return { invoice, feedback: { tone: 'ok', title: COPY.done.sent(to) } };
    });
  }

  markPaid(): Promise<void> {
    return this.onInvoice('paid', COPY.failed.paid, async (companyId, invoiceId) => {
      const invoice = await this.client.markPaid(companyId, invoiceId, isoDate(this.now()));
      return { invoice, feedback: { tone: 'ok', title: COPY.done.paid } };
    });
  }

  downloadPdf(): Promise<void> {
    return this.onInvoice('pdf', COPY.failed.pdf, async (companyId, invoiceId) => {
      const pdf = await this.client.pdf(companyId, invoiceId);
      if (!pdf.download_url && !pdf.base64) throw new UserFacingError(COPY.failed.noPdf);
      const name = pdf.file_name ?? `${this.store.get().invoice?.invoice_number ?? invoiceId}.pdf`;
      if (!this.host.canDownload()) {
        if (!pdf.download_url) throw new UserFacingError(COPY.failed.noPdf);
        await this.host.openLink(proxiedPdfUrl(pdf.download_url));
        return { feedback: { tone: 'ok', title: COPY.done.openedPdf } };
      }
      const base64 =
        pdf.base64 ?? toBase64(await this.host.fetchBytes(proxiedPdfUrl(pdf.download_url!)));
      return this.downloadFeedback(
        await this.host.download({ name, mimeType: 'application/pdf', base64 }),
        name,
      );
    });
  }

  /** The PDF's bytes, for the view to render inline. */
  async pdfBytes(): Promise<ArrayBuffer> {
    const { companyId, invoice } = this.store.get();
    if (!companyId || !invoice) throw new UserFacingError(COPY.failed.noPdf);
    const pdf = await this.client.pdf(companyId, invoice.id);
    if (!pdf.download_url) throw new UserFacingError(COPY.failed.noPdf);
    return this.host.fetchBytes(proxiedPdfUrl(pdf.download_url));
  }

  // ── Actions on the list ────────────────────────────────────────────────────

  exportCsv(): Promise<void> {
    return this.run('csv', COPY.failed.download, async () => {
      const name = COPY.invoices.csvFile(isoDate(this.now()));
      const text = invoicesCsv(this.store.get().invoices);
      return this.downloadFeedback(
        await this.host.download({ name, mimeType: 'text/csv', text }),
        name,
      );
    });
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  private downloadFeedback(started: boolean, name: string): Partial<AppState> {
    return {
      feedback: started
        ? { tone: 'ok', title: COPY.done.downloaded(name) }
        : { tone: 'error', title: COPY.failed.download },
    };
  }

  private onInvoice(
    id: ActionId,
    failure: string,
    act: (companyId: string, invoiceId: string) => Promise<Partial<AppState>>,
  ): Promise<void> {
    return this.run(id, failure, async () => {
      const { companyId, invoice } = this.store.get();
      if (!companyId || !invoice) throw new UserFacingError(COPY.invoice.notFound);
      return act(companyId, invoice.id);
    });
  }

  /** One action at a time; a superseded panel acts on nothing. */
  private async run(
    id: ActionId,
    failure: string,
    act: () => Promise<Partial<AppState>>,
  ): Promise<void> {
    const s = this.store.get();
    if (s.pending || s.superseded) return;
    this.store.set({ pending: id, feedback: undefined });
    let patch: Partial<AppState>;
    try {
      patch = await act();
    } catch (err) {
      patch = { feedback: failureFeedback(failure, err) };
    }
    this.store.set({ ...patch, pending: undefined });
    this.shareContext();
  }
}
