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
import { Check, ChevronRight, Copy, KeyRound, Plug, type IconNode } from 'lucide';
import logo from '../../assets/beel-app/logo.svg';
import { WORKER_PATH } from './constants.js';
import { markSvg, type ClientMark } from './client-marks.js';
import { fontFaceCss } from '../mcpapp/beel-app/fonts.js';
import { API_KEY_PREFIX, BEEL_DEFAULTS, ENV_VAR } from '../shared/defaults.js';

/** The connector name a user sees in Claude's list. */
export const CONNECTOR_DISPLAY_NAME = 'BeeL.';

/** The short name the CLI clients register the server under. */
const CLI_SERVER_NAME = 'beel';

const REPOSITORY_URL = 'https://github.com/beel-es/beel-mcp';

/** Where a user creates the API key an autonomous agent sends instead of signing in. */
const API_KEYS_URL = `${new URL(BEEL_DEFAULTS.apiBaseUrl).origin}/ajustes/api-keys`;

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

/** A Lucide icon as markup: the page is a string, so Lucide's DOM renderer does not apply. */
function lucideSvg(icon: IconNode, size = 16): string {
  const children = icon
    .map(([tag, attrs]) => {
      const attributes = Object.entries(attrs)
        .map(([name, value]) => `${name}="${escapeHtml(String(value))}"`)
        .join(' ');
      return `<${tag} ${attributes}/>`;
    })
    .join('');
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`
  );
}

/** A copy button for the text of the element `targetId`; the script at the end wires it. */
const copyButton = (targetId: string): string =>
  `<button type="button" class="copy" data-copy="${targetId}">${lucideSvg(Copy, 14)}<span>Copiar</span></button>`;

/** A code block with its own copy button, titled like a terminal window. `id` is unique per page. */
function codeBlock(id: string, text: string, title: string): string {
  return (
    `<div class="block"><div class="block-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
    `<span class="block-title">${escapeHtml(title)}</span>${copyButton(id)}</div>` +
    `<pre id="${id}"><code>${escapeHtml(text)}</code></pre></div>`
  );
}

interface ClientSection {
  id: string;
  label: string;
  /** The tab's icon: a client's brand mark, or a Lucide icon for the generic tab. */
  icon: string;
  /** Trusted markup, built here from constants and the escaped server URL. */
  html: string;
}

const mark = (m: ClientMark) => markSvg(m);

function clientSections(serverUrl: string): ClientSection[] {
  const url = escapeHtml(serverUrl);
  return [
    {
      id: 'claude',
      label: 'Claude',
      icon: mark('claude'),
      html:
        `<a class="cta" href="${escapeHtml(claudeAddConnectorUrl(serverUrl))}" target="_blank" rel="noopener">` +
        `Añadir a Claude ${lucideSvg(ChevronRight)}</a>` +
        '<p>El enlace abre Claude con el conector ya rellenado. Pulsa <b>Continuar</b> e inicia sesión con tu cuenta de BeeL.</p>' +
        '<p>Para añadirlo a mano: <b>Configuración</b> → <b>Conectores</b> → <b>Añadir conector personalizado</b>, con estos datos:</p>' +
        `<ul><li><b>Nombre:</b> ${escapeHtml(CONNECTOR_DISPLAY_NAME)}</li><li><b>URL:</b> <code>${url}</code></li></ul>` +
        '<p>Para comprobar que funciona, pregúntale al asistente qué empresas tienes en BeeL.</p>',
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      icon: mark('claude'),
      html:
        '<p>Ejecuta esto en tu terminal:</p>' +
        codeBlock(
          'claude-code-command',
          `claude mcp add --transport http ${CLI_SERVER_NAME} ${serverUrl}`,
          'Terminal',
        ),
    },
    {
      id: 'chatgpt',
      label: 'ChatGPT',
      icon: mark('openai'),
      html: `<p>En ChatGPT: <b>Configuración</b> → <b>Conectores</b> → <b>Avanzado</b> → <b>Añadir conector personalizado</b>, e indica la URL <code>${url}</code>. Necesitas un plan con conectores.</p>`,
    },
    {
      id: 'codex',
      label: 'Codex',
      icon: mark('openai'),
      html:
        '<p>Ejecuta esto en tu terminal:</p>' +
        codeBlock(
          'codex-command',
          `codex mcp add ${CLI_SERVER_NAME} --url ${serverUrl}`,
          'Terminal',
        ),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      icon: mark('cursor'),
      html:
        '<p>Añade esto a <code>~/.cursor/mcp.json</code> (global) o a <code>.cursor/mcp.json</code> (por proyecto). Cursor te pedirá iniciar sesión con BeeL.</p>' +
        codeBlock(
          'cursor-config',
          JSON.stringify({ mcpServers: { [CLI_SERVER_NAME]: { url: serverUrl } } }, null, 2),
          'mcp.json',
        ),
    },
    {
      id: 'vscode',
      label: 'VS Code',
      icon: mark('copilot'),
      html:
        '<p>Añade esto a tu <code>settings.json</code>:</p>' +
        codeBlock(
          'vscode-config',
          JSON.stringify(
            { mcp: { servers: { [CLI_SERVER_NAME]: { type: 'http', url: serverUrl } } } },
            null,
            2,
          ),
          'settings.json',
        ),
    },
    {
      id: 'other',
      label: 'Otro',
      icon: lucideSvg(Plug),
      html: `<p>Cualquier cliente MCP con Streamable HTTP funciona: apúntalo a <code>${url}</code> e inicia sesión con OAuth.</p>`,
    },
  ];
}

const STYLES = `
:root{--bg:#fdfcfa;--surface:#fff;--ink:#1c1c1f;--muted:#5a6580;--line:#e6e9f0;--line-strong:#d4dae7;--primary:#224da9;--primary-dark:#173a88;--primary-soft:#e6ecf8;--on-primary:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121316;--surface:#1b1c20;--ink:#f1f2f4;--muted:#a3abbd;--line:#2a2d34;--line-strong:#3a3e47;--primary:#7d9ee6;--primary-dark:#a9bff0;--primary-soft:#1f2a44;--on-primary:#0e1526}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 "DM Sans",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:0 16px}
header{display:flex;align-items:center;justify-content:space-between;padding:24px 0;border-bottom:1px solid var(--line)}
header .logo{display:inline-flex;color:var(--primary)}
header .logo svg{height:24px;width:auto}
header nav{display:flex;gap:24px}
header nav a{color:var(--ink);text-decoration:none;font-size:15px}
header nav a:hover{color:var(--primary)}
main{padding:56px 0 24px}
.eyebrow{display:inline-block;background:var(--primary-soft);color:var(--primary);font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;border-radius:6px;padding:4px 10px;margin-bottom:16px}
h1{font-size:30px;line-height:1.2;font-weight:600;margin:0 0 12px;letter-spacing:-.01em}
h1 span{color:var(--muted);font-weight:500}
p{margin:0 0 12px}
.lead{color:var(--muted);font-size:17px;margin-bottom:28px}
code,pre{font-family:"Geist Mono",ui-monospace,monospace;font-size:14px}
:not(pre)>code{background:var(--primary-soft);color:var(--ink);border-radius:4px;padding:1px 6px}
.url{display:flex;gap:12px;align-items:center;justify-content:space-between;background:var(--surface);border:1px solid var(--line-strong);border-radius:8px;padding:12px 12px 12px 16px;margin-bottom:56px;box-shadow:0 1px 2px rgba(16,24,40,.05)}
.url code{background:none;padding:0;font-size:15px;overflow-x:auto;white-space:nowrap}
.copy{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:14px;background:var(--surface);color:var(--ink);border:1px solid var(--line-strong);border-radius:8px;padding:5px 12px;cursor:pointer;flex-shrink:0}
.copy:hover{border-color:var(--primary);color:var(--primary)}
h2{font-size:19px;font-weight:600;margin:0 0 16px}
.tabs{display:flex;flex-wrap:wrap;gap:4px 20px;border-bottom:1px solid var(--line);margin-bottom:24px}
.tabs a{display:inline-flex;align-items:center;gap:8px;color:var(--muted);text-decoration:none;padding:10px 0;border-bottom:2px solid transparent;margin-bottom:-1px;font-size:15px}
.tabs a:hover,.tabs a:focus-visible{color:var(--ink)}
section.client{display:none}
section.client:target,section.client#claude{display:block}
section.client:target~section.client#claude{display:none}
.client-head{display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:12px}
.cta{display:inline-flex;align-items:center;gap:6px;background:var(--primary);color:var(--on-primary);text-decoration:none;font-weight:500;border-radius:8px;padding:10px 16px 10px 20px;margin-bottom:20px}
.cta:hover,.cta:focus-visible{background:var(--primary-dark)}
ul{margin:0 0 16px;padding-left:22px}
li{margin-bottom:4px}
.block{background:var(--surface);border:1px solid var(--line-strong);border-radius:8px;margin:0 0 16px;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.05)}
.block-bar{display:flex;align-items:center;gap:12px;padding:8px 8px 8px 16px;border-bottom:1px solid var(--line)}
.dots{display:inline-flex;gap:6px}.dots i{width:10px;height:10px;border-radius:50%;background:var(--line-strong)}
.block-title{flex:1;color:var(--muted);font-family:"Geist Mono",ui-monospace,monospace;font-size:13px}
.block pre{margin:0;padding:16px;overflow-x:auto}
.agents{margin-top:56px}
.agents h2{display:flex;align-items:center;gap:8px}
a{color:var(--primary)}
footer{display:flex;flex-wrap:wrap;gap:12px 24px;justify-content:space-between;border-top:1px solid var(--line);margin-top:64px;padding:24px 0 40px;font-size:14px;color:var(--muted)}
footer nav{display:flex;flex-wrap:wrap;gap:8px 24px}
footer a{color:var(--muted);text-decoration:none}
footer a:hover{color:var(--ink)}
`;

/** Underlines the tab of the section in view: the URL's target, or Claude when there is none. */
function activeTabCss(sections: ClientSection[]): string {
  const selectors = sections.map((s) => `body:has(#${s.id}:target) .tabs a[href="#${s.id}"]`);
  selectors.push('body:not(:has(section.client:target)) .tabs a[href="#claude"]');
  return `${selectors.join(',')}{color:var(--ink);border-bottom-color:var(--primary);font-weight:500}`;
}

/** Copies the target's text and confirms it on the button for a moment. */
const COPY_SCRIPT = `document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;var t=document.getElementById(b.dataset.copy);if(!t)return;navigator.clipboard.writeText(t.textContent.trim()).then(function(){var l=b.querySelector('span'),o=l.textContent,i=b.querySelector('svg').outerHTML;b.querySelector('svg').outerHTML=${JSON.stringify(lucideSvg(Check, 14))};l.textContent='Copiado';setTimeout(function(){b.querySelector('svg').outerHTML=i;l.textContent=o},1500)})});`;

export function connectPageHtml(origin: string): string {
  const serverUrl = `${origin}${WORKER_PATH.api}`;
  const docs = `${BEEL_DEFAULTS.docsUrl}/mcp`;
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
    `<style>${fontFaceCss('')}${STYLES}${activeTabCss(sections)}</style></head><body><div class="wrap">` +
    `<header><a class="logo" href="https://beel.es">${logo}</a>` +
    `<nav><a href="${docs}">Docs</a><a href="${API_KEYS_URL}">API keys</a></nav></header>` +
    '<main><span class="eyebrow">Servidor MCP</span>' +
    '<h1>Servidor MCP de BeeL. <span>Toda tu facturación en tu asistente.</span></h1>' +
    '<p class="lead">Conecta Claude, ChatGPT, Codex, Cursor o cualquier cliente MCP e inicia sesión con tu cuenta de BeeL. El servidor está alojado: no hay nada que instalar.</p>' +
    `<div class="url"><code id="server-url">${escapeHtml(serverUrl)}</code>${copyButton('server-url')}</div>` +
    '<h2>Conecta tu cliente</h2>' +
    `<nav class="tabs" aria-label="Clientes">${sections.map((s) => `<a href="#${s.id}">${s.icon}${s.label}</a>`).join('')}</nav>` +
    ordered
      .map(
        (s) =>
          `<section class="client" id="${s.id}" aria-label="${s.label}">` +
          `<div class="client-head">${s.icon}${s.label}</div>${s.html}</section>`,
      )
      .join('') +
    `<section class="agents"><h2>${lucideSvg(KeyRound, 18)}API keys para agentes</h2>` +
    `<p>Un agente autónomo no tiene a nadie delante de un navegador para iniciar sesión. Envía una <a href="${API_KEYS_URL}">API key</a> como token bearer en su lugar:</p>` +
    codeBlock('agent-header', `Authorization: Bearer $${ENV_VAR.apiKey}`, 'Cabecera HTTP') +
    `<p>Usa una clave de Test (<code>${API_KEY_PREFIX.test}…</code>) hasta que quieras trabajar con datos reales.</p></section>` +
    '</main>' +
    `<footer><nav><a href="${docs}">Guía completa</a><a href="${docs}/tools">Herramientas</a>` +
    `<a href="${REPOSITORY_URL}">GitHub</a><a href="${REPOSITORY_URL}/blob/master/server.json">server.json</a></nav>` +
    '<span>© BeeL.</span></footer>' +
    `</div><script>${COPY_SCRIPT}</script></body></html>`
  );
}

export function connectPageHandler(c: Context): Response {
  return c.html(connectPageHtml(new URL(c.req.url).origin), 200, {
    'Cache-Control': 'public, max-age=300',
  });
}
