/**
 * The page at the root of the hosted server: how to connect each MCP client to it,
 * with an "Add to Claude" link that opens Claude's add-connector dialog already
 * filled in. Each client has its own anchor (`/#claude`, `/#cursor`…), so docs and
 * READMEs can link straight to one.
 *
 * The server URL is taken from the request rather than from `BEEL_DEFAULTS`, so a
 * staging deployment links to itself and not to production.
 */
import type { Context } from 'hono';
import { WORKER_PATH } from './constants.js';
import { fontFaceCss } from '../mcpapp/beel-app/fonts.js';
import { BEEL_DEFAULTS } from '../shared/defaults.js';

/** The connector name a user sees in Claude's list. */
export const CONNECTOR_DISPLAY_NAME = 'BeeL.';

/** The short name the CLI clients register the server under. */
const CLI_SERVER_NAME = 'beel';

/** Claude's own deep link: opens Settings → Connectors with the dialog filled in. */
export function claudeAddConnectorUrl(serverUrl: string): string {
  const url = new URL('https://claude.ai/customize/connectors');
  url.searchParams.set('modal', 'add-custom-connector');
  url.searchParams.set('connectorName', CONNECTOR_DISPLAY_NAME);
  url.searchParams.set('connectorUrl', serverUrl);
  return url.toString();
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface ClientSection {
  id: string;
  label: string;
  /** Trusted markup, built here from constants and the escaped server URL. */
  html: string;
}

const code = (text: string): string => `<pre><code>${escapeHtml(text)}</code></pre>`;

function clientSections(serverUrl: string): ClientSection[] {
  const url = escapeHtml(serverUrl);
  return [
    {
      id: 'claude',
      label: 'Claude',
      html:
        `<a class="cta" href="${escapeHtml(claudeAddConnectorUrl(serverUrl))}" target="_blank" rel="noopener">Añadir a Claude</a>` +
        '<p>El enlace abre Claude con el conector ya rellenado. Pulsa <b>Continuar</b> e inicia sesión con tu cuenta de BeeL.</p>' +
        '<p>Para añadirlo a mano: <b>Configuración</b> → <b>Conectores</b> → <b>Añadir conector personalizado</b>, con estos datos:</p>' +
        `<ul><li>Nombre: ${escapeHtml(CONNECTOR_DISPLAY_NAME)}</li><li>URL: <code>${url}</code></li></ul>`,
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      html:
        '<p>Ejecuta esto en tu terminal:</p>' +
        code(`claude mcp add --transport http ${CLI_SERVER_NAME} ${serverUrl}`),
    },
    {
      id: 'chatgpt',
      label: 'ChatGPT',
      html: '<p>En ChatGPT: <b>Configuración</b> → <b>Conectores</b> → <b>Avanzado</b> → <b>Añadir conector personalizado</b>, e indica la URL del servidor. Necesitas un plan con conectores.</p>',
    },
    {
      id: 'codex',
      label: 'Codex',
      html:
        '<p>Ejecuta esto en tu terminal:</p>' +
        code(`codex mcp add ${CLI_SERVER_NAME} --url ${serverUrl}`),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      html:
        '<p>Añade esto a <code>~/.cursor/mcp.json</code> (global) o a <code>.cursor/mcp.json</code> (por proyecto):</p>' +
        code(JSON.stringify({ mcpServers: { [CLI_SERVER_NAME]: { url: serverUrl } } }, null, 2)),
    },
    {
      id: 'vscode',
      label: 'VS Code',
      html:
        '<p>Añade esto a tu <code>settings.json</code>:</p>' +
        code(
          JSON.stringify(
            { mcp: { servers: { [CLI_SERVER_NAME]: { type: 'http', url: serverUrl } } } },
            null,
            2,
          ),
        ),
    },
    {
      id: 'other',
      label: 'Otro',
      html: `<p>Cualquier cliente MCP con Streamable HTTP funciona: apúntalo a <code>${url}</code> e inicia sesión con OAuth.</p>`,
    },
  ];
}

const STYLES = `
:root{--bg:#fdfcfa;--surface:#fff;--ink:#1c1c1f;--muted:#5a6580;--line:#e6e9f0;--primary:#224da9;--primary-dark:#173a88;--claude:#d97757}
@media (prefers-color-scheme:dark){:root{--bg:#141518;--surface:#1c1d21;--ink:#f1f2f4;--muted:#a3abbd;--line:#2c2f36;--primary:#7d9ee6;--primary-dark:#a9bff0}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 "DM Sans",system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:48px 16px}
h1{font-size:28px;line-height:1.2;margin:0 0 8px}
h1 span{color:var(--muted);font-weight:500}
p{margin:0 0 12px}
.lead{color:var(--muted);margin-bottom:24px}
code,pre{font-family:"Geist Mono",ui-monospace,monospace;font-size:14px}
.url{display:flex;gap:8px;align-items:center;justify-content:space-between;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin-bottom:40px;overflow-x:auto}
.url button{font:inherit;font-size:14px;background:none;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}
h2{font-size:18px;margin:0 0 12px}
nav{display:flex;flex-wrap:wrap;gap:4px 16px;border-bottom:1px solid var(--line);margin-bottom:24px}
nav a{color:var(--muted);text-decoration:none;padding:8px 0;border-bottom:2px solid transparent}
nav a:hover,nav a:focus-visible{color:var(--ink)}
section{display:none}
section:target,section#claude{display:block}
section:target~section#claude{display:none}
pre{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 16px;overflow-x:auto;margin:0 0 12px}
.cta{display:inline-block;background:var(--claude);color:#fff;text-decoration:none;font-weight:500;border-radius:8px;padding:10px 18px;margin-bottom:16px}
.cta:hover,.cta:focus-visible{filter:brightness(.92)}
a{color:var(--primary)}
footer{margin-top:48px;color:var(--muted);font-size:14px}
`;

/** Underlines the tab of the section in view: the URL's target, or Claude when there is none. */
function activeTabCss(sections: ClientSection[]): string {
  const selectors = sections.map((s) => `body:has(#${s.id}:target) nav a[href="#${s.id}"]`);
  selectors.push('body:not(:has(section:target)) nav a[href="#claude"]');
  return `${selectors.join(',')}{color:var(--ink);border-bottom-color:var(--claude)}`;
}

export function connectPageHtml(origin: string): string {
  const serverUrl = `${origin}${WORKER_PATH.api}`;
  const sections = clientSections(serverUrl);
  // Claude is shown when no client is picked: it goes last so `:target ~ #claude`
  // can hide it once another section is the target.
  const ordered = [
    ...sections.filter((s) => s.id !== 'claude'),
    ...sections.filter((s) => s.id === 'claude'),
  ];
  return (
    '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Servidor MCP de BeeL.</title>' +
    '<meta name="description" content="Conecta Claude, ChatGPT, Cursor o cualquier cliente MCP a BeeL. e inicia sesión con tu cuenta.">' +
    // Same-origin font URLs: this page is served by the server that hosts the fonts.
    `<style>${fontFaceCss('')}${STYLES}${activeTabCss(sections)}</style></head><body><main>` +
    '<h1>Servidor MCP de BeeL. <span>Toda la facturación en tu asistente.</span></h1>' +
    '<p class="lead">Conecta Claude, ChatGPT, Codex, Cursor o cualquier cliente MCP e inicia sesión con tu cuenta de BeeL. El servidor está alojado: no hay nada que instalar.</p>' +
    `<div class="url"><code id="server-url">${escapeHtml(serverUrl)}</code>` +
    '<button type="button" onclick="navigator.clipboard.writeText(document.getElementById(\'server-url\').textContent);this.textContent=\'Copiada\'">Copiar</button></div>' +
    '<h2>Conecta tu cliente</h2>' +
    `<nav aria-label="Clientes">${sections.map((s) => `<a href="#${s.id}">${s.label}</a>`).join('')}</nav>` +
    ordered
      .map((s) => `<section id="${s.id}" aria-label="${s.label}">${s.html}</section>`)
      .join('') +
    `<footer>Documentación: <a href="${BEEL_DEFAULTS.docsUrl}/mcp">${BEEL_DEFAULTS.docsUrl.replace('https://', '')}/mcp</a></footer>` +
    '</main></body></html>'
  );
}

export function connectPageHandler(c: Context): Response {
  return c.html(connectPageHtml(new URL(c.req.url).origin), 200, {
    'Cache-Control': 'public, max-age=300',
  });
}
