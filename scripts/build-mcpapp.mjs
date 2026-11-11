#!/usr/bin/env node
/**
 * Bundles the MCP Apps into self-contained HTML documents served as `ui://`
 * resources: the invoice viewer (src/mcpapp/app.ts) and the BeeL. app
 * (src/mcpapp/beel-app/main.ts). pdf.js stays external: it is imported by URL
 * at runtime, so each resource stays small enough to travel inside the bundle.
 *
 * Output: dist/mcpapp/invoice-pdf.html and dist/mcpapp/beel-app.html, which
 * worker.ts embeds as text modules and the stdio server reads from disk.
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Keeps http(s) imports external: pdf.js is fetched at runtime, never bundled. */
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
  /* The height must be explicit: the host sizes its panel to the content, so a
     viewer without one collapses to nothing. Scrollable container of pdf.js canvases. */
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

/**
 * The BeeL. app's shell. Its stylesheet is the site's design system, kept as a
 * real CSS file (assets/beel-app/styles.css) and inlined here; the logo is
 * imported by the app itself.
 */
const BEEL_APP_CSS = await readFile(resolve(root, 'assets/beel-app/styles.css'), 'utf8');

function beelAppShell(script) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light dark" />
<title>BeeL.</title>
<style>${BEEL_APP_CSS}</style>
</head>
<body>
  <div id="root"></div>
  <script>${script}</script>
</body>
</html>`;
}

/** Bundle one app into an IIFE and write it inside its HTML shell. */
async function buildApp(entry, out, shell) {
  const result = await build({
    entryPoints: [resolve(root, entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    write: false,
    logLevel: 'warning',
    // The app's own SVG assets travel inside the bundle as text.
    loader: { '.svg': 'text' },
    plugins: [externalHttps],
  });

  // `write: false` makes esbuild hand the bundle back in memory; an empty result
  // would otherwise be written out as an HTML shell with no app inside it.
  const [output] = result.outputFiles;
  if (!output) {
    console.error(`esbuild produced no output for ${entry}.`);
    process.exit(1);
  }

  const script = output.text;
  const path = resolve(root, out);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, shell(script), 'utf8');
  console.log(
    `[build-mcpapp] ${entry} -> ${out} (${(script.length / 1024).toFixed(0)} KB inlined, pdf.js external)`,
  );
}

await buildApp('src/mcpapp/app.ts', 'dist/mcpapp/invoice-pdf.html', htmlShell);
await buildApp('src/mcpapp/beel-app/main.ts', 'dist/mcpapp/beel-app.html', beelAppShell);
