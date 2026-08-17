#!/usr/bin/env node
/**
 * Bundle the MCP App UIs into self-contained HTML files served as `ui://` resources.
 *
 * Each app TS entry is bundled (with the @modelcontextprotocol/ext-apps client) into
 * a single IIFE and inlined into an HTML shell, so the server can return one string
 * with no external script loads (sandboxed iframes can't fetch arbitrary scripts).
 *
 * Output: dist/ui/<name>.html. Run before/after tsup (tsup cleans dist, so the
 * build script runs tsup first, then this). Also run by the dev scripts.
 */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** One entry per MCP App. */
const APPS = [
  {
    entry: 'src/ui/invoice-pdf-app.ts',
    out: 'dist/ui/invoice-pdf.html',
    title: 'Factura BeeL',
  },
];

function htmlShell(title, script) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light dark" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  /* Altura EXPLÍCITA: el host dimensiona el panel al contenido, así que flex:1
     sobre height:100% colapsaría el visor a 0px. Fijamos la zona del PDF. */
  html, body { margin: 0; font-family: var(--font-sans, system-ui, sans-serif); }
  body { display: flex; flex-direction: column; background: var(--background, Canvas); color: var(--foreground, CanvasText); }
  #bar { display: flex; align-items: center; gap: .75rem; padding: .6rem .9rem; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); font-size: .85rem; }
  #title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #meta { opacity: .6; white-space: nowrap; }
  #open { margin-left: auto; display: none; align-items: center; gap: .3rem; text-decoration: none; padding: .3rem .6rem; border-radius: .4rem; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); color: inherit; font-size: .8rem; }
  #open:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
  #frame-wrap { height: 640px; }
  #pdf { display: none; width: 100%; height: 640px; border: 0; }
  #empty { height: 640px; display: flex; align-items: center; justify-content: center; opacity: .55; font-size: .9rem; }
</style>
</head>
<body>
  <header id="bar">
    <span id="title">${title}</span>
    <span id="meta"></span>
    <a id="open" target="_blank" rel="noopener noreferrer">Abrir ↗</a>
  </header>
  <div id="frame-wrap">
    <iframe id="pdf" title="Factura PDF"></iframe>
  </div>
  <div id="empty">Esperando la factura…</div>
  <script>${script}</script>
</body>
</html>`;
}

for (const app of APPS) {
  const result = await build({
    entryPoints: [resolve(root, app.entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    write: false,
    logLevel: 'warning',
  });
  const script = result.outputFiles[0].text;
  const outPath = resolve(root, app.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, htmlShell(app.title, script), 'utf8');
  console.error(`[build-ui] ${app.entry} -> ${app.out} (${(script.length / 1024).toFixed(0)} KB inlined)`);
}
