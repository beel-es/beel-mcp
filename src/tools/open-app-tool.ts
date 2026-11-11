import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  BEEL_APP_URI,
  BEEL_APP_VIEWS,
  type BeelAppRoute,
  type BeelAppView,
} from '../mcpapp/contract.js';
import { readString } from '../shared/guards.js';

/**
 * `beel_open_app`: opens the BeeL. app, the panel where the user works with their
 * invoices without leaving the conversation.
 *
 * It is also the app's global entry point: hosts that list apps (Claude's
 * Artifacts page) open it with no arguments, so every argument is optional and
 * `{}` lands on the home view.
 */
export const OPEN_APP = 'beel_open_app';

/** Shown where the host lists the app; at most 60 characters. */
const OPEN_APP_TITLE = 'BeeL. Facturación';

export const openAppTool: Tool = {
  name: OPEN_APP,
  title: OPEN_APP_TITLE,
  description:
    'Open the BeeL. app in a panel: setup status and the quarter at a glance, the invoice ' +
    'list, one invoice with its actions (issue, send, mark paid, download the PDF) and the ' +
    'customers. Use it when the user wants to see or review invoices or customers rather than ' +
    'read them as text, and to show a draft so they can check it and issue it themselves. ' +
    'What the user does in the panel reaches you as context or as a message.',
  inputSchema: {
    type: 'object',
    properties: {
      view: {
        type: 'string',
        enum: [...BEEL_APP_VIEWS],
        description:
          'The view to open: home (default), invoices (the list, filtered by `search`), ' +
          'invoice (one invoice, needs invoice_id) or customers.',
      },
      company_id: {
        type: 'string',
        description: 'The company to show (a UUID, not the NIF). Defaults to the primary one.',
      },
      invoice_id: { type: 'string', description: 'The invoice to open, for view=invoice.' },
      search: {
        type: 'string',
        description: 'Text to search for in the invoices or customers view.',
      },
    },
    additionalProperties: false,
  },
  annotations: {
    title: OPEN_APP_TITLE,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: {
    ui: { resourceUri: BEEL_APP_URI },
    // Lists the app on the host's apps page, opened with no arguments.
    'openai/ui': { entrypoints: [{ type: 'global' }] },
  },
};

const VIEW_LABEL: Record<BeelAppView, string> = {
  home: 'the home view',
  invoices: 'the invoice list',
  invoice: 'the invoice',
  customers: 'the customers',
};

/** The route the app opens on, from arguments already validated against the schema. */
export function openAppRoute(args: Record<string, unknown>): BeelAppRoute {
  const invoiceId = readString(args, 'invoice_id');
  const requested = readString(args, 'view') as BeelAppView | undefined;
  // An invoice id with no view means that invoice; a view=invoice with no id has
  // nothing to show, so it falls back to the list.
  const view = requested ?? (invoiceId ? 'invoice' : 'home');
  const route: BeelAppRoute = { view: view === 'invoice' && !invoiceId ? 'invoices' : view };
  const companyId = readString(args, 'company_id');
  const search = readString(args, 'search');
  if (companyId) route.company_id = companyId;
  if (invoiceId) route.invoice_id = invoiceId;
  if (search) route.search = search;
  return route;
}

export function openAppResult(args: Record<string, unknown>): CallToolResult {
  const route = openAppRoute(args);
  return {
    content: [
      {
        type: 'text',
        text:
          `The BeeL. app is open on ${VIEW_LABEL[route.view]}. The user sees it and can act ` +
          'there; do not repeat its contents as text.',
      },
    ],
    structuredContent: { ...route },
  };
}
