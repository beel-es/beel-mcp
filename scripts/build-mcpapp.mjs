#!/usr/bin/env node
/**
 * Bundlea la MCP App del visor de factura (src/mcpapp/app.ts) a un HTML
 * self-contained servido como recurso ui://. pdf.js NO se bundlea: se importa por
 * URL desde cdnjs en runtime (import() externo), así el recurso queda diminuto.
 *
 * Salida: dist/mcpapp/invoice-pdf.html (worker.ts lo embebe como Text module).
 */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, 'dist/mcpapp/invoice-pdf.html');

/** Deja los imports http(s) como externos: pdf.js se carga en runtime, no se empaqueta. */
const externalHttps = {
  name: 'external-https',
  setup(b) {
    b.onResolve({ filter: /^https?:\/\// }, (args) => ({ path: args.path, external: true }));
  },
};

function htmlShell(script) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light dark" />
<title>Factura BeeL</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; font-family: var(--font-sans, system-ui, sans-serif); }
  body { display: flex; flex-direction: column; background: var(--background, Canvas); color: var(--foreground, CanvasText); }
  #bar { display: flex; align-items: center; gap: .75rem; padding: .6rem .9rem; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); font-size: .85rem; }
  #title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #open { margin-left: auto; display: none; align-items: center; gap: .3rem; text-decoration: none; padding: .3rem .6rem; border-radius: .4rem; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); color: inherit; font-size: .8rem; }
  #open:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
  /* Altura EXPLÍCITA: el host dimensiona el panel al contenido; sin altura fija el
     visor colapsaría. Contenedor scrollable de páginas (canvas de pdf.js). */
  #pages { height: 640px; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; align-items: center; gap: 12px; background: color-mix(in srgb, currentColor 6%, transparent); }
  #pages canvas { max-width: 100%; height: auto; background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.18); border-radius: 2px; }
  #status { display: flex; align-items: center; justify-content: center; text-align: center; padding: .5rem 1rem; opacity: .6; font-size: .85rem; }
</style>
</head>
<body>
  <header id="bar">
    <span id="title">Factura</span>
    <a id="open" target="_blank" rel="noopener noreferrer">Abrir ↗</a>
  </header>
  <div id="pages"></div>
  <div id="status">Esperando la factura…</div>
  <script>${script}</script>
</body>
</html>`;
}

const result = await build({
  entryPoints: [resolve(root, 'src/mcpapp/app.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  write: false,
  logLevel: 'warning',
  plugins: [externalHttps],
});

const script = result.outputFiles[0].text;
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, htmlShell(script), 'utf8');
console.error(`[build-mcpapp] src/mcpapp/app.ts -> ${OUT} (${(script.length / 1024).toFixed(0)} KB inlined, pdf.js externo)`);
