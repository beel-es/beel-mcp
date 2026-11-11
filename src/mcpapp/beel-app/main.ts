/// <reference lib="dom" />
/**
 * The BeeL. app (MCP App): entry point. Wires the host connection to the
 * controller and renders the store; behaviour lives in controller.ts, the
 * screens in views/, and every string in copy.ts.
 *
 * Bundled into an IIFE and inlined into dist/mcpapp/beel-app.html by
 * scripts/build-mcpapp.mjs.
 */
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_INFO } from '../../shared/defaults.js';
import { APP_TOOLS, createAppToolHandler } from './app-tools.js';
import { BeelClient } from './client.js';
import { Controller, type HostPort } from './controller.js';
import { COPY } from './copy.js';
import { installBrandFonts } from './fonts.js';
import { INITIAL_STATE, type AppState, type Invoice } from './model.js';
import { parseRoute } from './route.js';
import { Store } from './store.js';
import { watchForNewerInstance } from './supersede.js';
import { customersView } from './views/customers.js';
import type { ViewEnv } from './views/env.js';
import { homeView } from './views/home.js';
import { invoiceView } from './views/invoice.js';
import { invoicesView } from './views/invoices.js';
import { skeleton } from './views/parts.js';
import { shell } from './views/shell.js';

/** Claude leaves the dialog open as long as the user takes; ours waits ten minutes. */
const DOWNLOAD_TIMEOUT_MS = 600_000;

installBrandFonts();

const app = new App(
  { name: 'BeeL.', version: SERVER_INFO.version },
  { tools: { listChanged: true }, availableDisplayModes: ['inline', 'fullscreen'] },
);

const host: HostPort = {
  async sendMessage(text) {
    const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
    return !result.isError;
  },
  async updateModelContext(text, structuredContent) {
    if (!app.getHostCapabilities()?.updateModelContext) return;
    await app.updateModelContext({ content: [{ type: 'text', text }], structuredContent });
  },
  canDownload: () => Boolean(app.getHostCapabilities()?.downloadFile),
  async download(file) {
    const body = 'text' in file ? { text: file.text } : { blob: file.base64 };
    const result = await app.downloadFile(
      {
        contents: [
          {
            type: 'resource',
            resource: { uri: `file:///${file.name}`, mimeType: file.mimeType, ...body },
          },
        ],
      },
      { timeout: DOWNLOAD_TIMEOUT_MS },
    );
    return !result.isError;
  },
  async openLink(url) {
    await app.openLink({ url });
  },
  async fetchBytes(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
  },
};

const store = new Store<AppState>(INITIAL_STATE);
const ctl = new Controller(
  store,
  new BeelClient((name, args) => app.callServerTool({ name, arguments: args })),
  host,
);

const root = document.getElementById('root') as HTMLElement;

function render(state: AppState): void {
  const ctx = app.getHostContext();
  const canExpand =
    ctx?.displayMode === 'inline' && !!ctx.availableDisplayModes?.includes('fullscreen');
  const env: ViewEnv = {
    state,
    ctl,
    host: {
      compact: canExpand,
      canExpand,
      // Must run inside the click: the host refuses a mode change without a gesture.
      expand: () => void app.requestDisplayMode({ mode: 'fullscreen' }).catch(() => undefined),
      canDownload: host.canDownload(),
    },
  };
  const body =
    state.phase === 'connecting'
      ? skeleton()
      : state.view === 'home'
        ? homeView(env, new Date())
        : state.view === 'invoices'
          ? invoicesView(env)
          : state.view === 'invoice'
            ? invoiceView(env)
            : customersView(env);
  root.replaceChildren(shell(env, body));
}

/** The invoice a tool result carries as its JSON text, when it is the one routed to. */
function invoiceIn(result: CallToolResult, invoiceId: string): Invoice | undefined {
  const text = result.content?.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') return undefined;
  try {
    const data = JSON.parse(text.text) as Partial<Invoice>;
    return data.id === invoiceId ? (data as Invoice) : undefined;
  } catch {
    return undefined;
  }
}

function applyHostContext(ctx: McpUiHostContext): void {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  // The host's surface colour, so the panel sits in Claude; the brand's own
  // tokens are prefixed and these never override them.
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  // Full screen keeps the host's message box floating over the bottom of the
  // panel: the layout leaves it room, from the host's own insets when given.
  const root = document.documentElement;
  root.dataset.display = ctx.displayMode ?? 'inline';
  root.style.setProperty('--safe-bottom', `${ctx.safeAreaInsets?.bottom ?? 0}px`);
  render(store.get());
}

// Handlers are registered before connect(): the host may send the tool input
// and result as soon as the handshake completes.
app.onerror = (err) => console.error('[beel-app]', err);
app.onhostcontextchanged = applyHostContext;
app.ontoolinput = ({ arguments: args }) => {
  if (typeof args?.company_id === 'string') ctl.preferCompany(args.company_id);
};
app.ontoolresult = (result) => {
  if (result.isError) {
    store.set({ phase: 'ready', feedback: { tone: 'error', title: COPY.failed.chatAction } });
    return;
  }
  const route = parseRoute(result.structuredContent) ?? { view: 'home' };
  // Creating an invoice returns the invoice itself: show it without asking again.
  void ctl.navigate(route, route.invoice_id ? invoiceIn(result, route.invoice_id) : undefined);
};
app.ontoolcancelled = () => void ctl.navigate({ view: 'home' });

const handleAppTool = createAppToolHandler(ctl, store);
app.onlisttools = async () => ({ tools: APP_TOOLS });
app.oncalltool = async ({ name, arguments: args }) => handleAppTool(name, args);

store.subscribe(render);
watchForNewerInstance(() => ctl.markSuperseded());
render(store.get());

void app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) applyHostContext(ctx);
});
