/**
 * Tools the open app registers with the host, so Claude can drive the panel the
 * user is looking at ("show me the unpaid ones") and read what is on it.
 *
 * Registered through `onlisttools`/`oncalltool`, where the host does not check
 * arguments against the schema: `parseShowViewArgs` does, before acting.
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { BEEL_APP_VIEWS } from '../contract.js';
import { viewState } from './context.js';
import type { Controller } from './controller.js';
import type { AppState } from './model.js';
import { parseShowViewArgs, SHOW_VIEW_STATUSES } from './route.js';
import type { Store } from './store.js';

export const APP_TOOLS: Tool[] = [
  {
    name: 'show_view',
    title: 'Show in BeeL.',
    description:
      'Change what the open BeeL. app shows: home, invoices (filtered by search text and/or ' +
      'status: [DRAFT], [ISSUED, SENT, OVERDUE] for unpaid, [PAID]), one invoice by ' +
      'invoice_id, or customers (filtered by search).',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: [...BEEL_APP_VIEWS] },
        invoice_id: { type: 'string', description: 'Required for view "invoice".' },
        search: { type: 'string' },
        status: { type: 'array', items: { type: 'string', enum: [...SHOW_VIEW_STATUSES] } },
      },
      required: ['view'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_view_state',
    title: 'Read the BeeL. panel',
    description:
      'What the user sees in the open BeeL. app: the view, the company, and the invoice or ' +
      'the rows on screen, with their ids.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'refresh_view',
    title: 'Refresh the BeeL. panel',
    description: 'Reload the open BeeL. app, after you changed an invoice or a customer it shows.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

const text = (value: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: value }],
  isError,
});

export function createAppToolHandler(
  controller: Controller,
  store: Store<AppState>,
): (name: string, args: Record<string, unknown> | undefined) => Promise<CallToolResult> {
  return async (name, args) => {
    switch (name) {
      case 'show_view': {
        const parsed = parseShowViewArgs(args);
        if (!parsed.ok) return text(parsed.error, true);
        await controller.navigate(parsed.value);
        return text(JSON.stringify(viewState(store.get())));
      }
      case 'get_view_state':
        return text(JSON.stringify(viewState(store.get())));
      case 'refresh_view':
        await controller.refresh();
        return text(JSON.stringify(viewState(store.get())));
      default:
        return text(`Unknown tool: ${name}`, true);
    }
  };
}
