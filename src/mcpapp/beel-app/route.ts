/**
 * Reading what the host and Claude send the app: the route a tool result opens
 * on, and the arguments of the tools the app registers.
 *
 * Both arrive unchecked. The host validates neither a result's structured
 * content nor the arguments of a tool registered with `oncalltool`, so they are
 * validated here, at the boundary, before anything acts on them.
 */
import { BEEL_APP_VIEWS, type BeelAppRoute, type BeelAppView } from '../contract.js';
import { filterFor, type InvoiceFilter } from './model.js';

const isView = (value: unknown): value is BeelAppView =>
  typeof value === 'string' && (BEEL_APP_VIEWS as readonly string[]).includes(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** The route in a tool result's structured content; `null` when there is none. */
export function parseRoute(content: unknown): BeelAppRoute | null {
  if (!content || typeof content !== 'object') return null;
  const c = content as Record<string, unknown>;
  if (!isView(c.view)) return null;
  const route: BeelAppRoute = { view: c.view };
  const company = optionalString(c.company_id);
  const invoice = optionalString(c.invoice_id);
  const search = typeof c.search === 'string' ? c.search : undefined;
  if (company) route.company_id = company;
  if (invoice) route.invoice_id = invoice;
  if (search !== undefined) route.search = search;
  return route;
}

/** Where to navigate: a route plus, for the list, the filter to apply. */
export interface NavigationTarget extends Partial<BeelAppRoute> {
  filter?: InvoiceFilter;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The statuses `show_view` accepts, each one a list filter or part of one. */
export const SHOW_VIEW_STATUSES = ['DRAFT', 'ISSUED', 'SENT', 'OVERDUE', 'PAID'] as const;

/** Arguments of the `show_view` app tool, validated against its input schema. */
export function parseShowViewArgs(
  args: Record<string, unknown> | undefined,
): Parsed<NavigationTarget> {
  const a = args ?? {};
  if (!isView(a.view)) {
    return { ok: false, error: `view must be one of: ${BEEL_APP_VIEWS.join(', ')}` };
  }
  for (const key of ['invoice_id', 'search'] as const) {
    if (a[key] !== undefined && typeof a[key] !== 'string') {
      return { ok: false, error: `${key} must be a string` };
    }
  }
  const invoiceId = optionalString(a.invoice_id);
  if (a.view === 'invoice' && !invoiceId) {
    return { ok: false, error: 'view "invoice" needs invoice_id' };
  }

  const target: NavigationTarget = { view: a.view, search: (a.search as string | undefined) ?? '' };
  if (invoiceId) target.invoice_id = invoiceId;

  if (a.status !== undefined) {
    if (
      !Array.isArray(a.status) ||
      !a.status.every((s) => (SHOW_VIEW_STATUSES as readonly unknown[]).includes(s))
    ) {
      return { ok: false, error: `status must be a list of: ${SHOW_VIEW_STATUSES.join(', ')}` };
    }
    const filter = filterFor(a.status as string[]);
    if (!filter) {
      return {
        ok: false,
        error: 'status must match one filter: [DRAFT], [ISSUED, SENT, OVERDUE], [PAID] or []',
      };
    }
    target.filter = filter;
  } else if (a.view === 'invoices') {
    target.filter = 'all';
  }
  return { ok: true, value: target };
}
