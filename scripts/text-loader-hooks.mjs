/**
 * Node ESM loader that resolves `import text from './x.md'` to the file's
 * contents, matching what tsup, wrangler and vitest each provide through their
 * own loaders. Without it, anything run straight through tsx (`npm run dev`, the
 * catalogue generator) fails on the guardrail prose imports.
 *
 * Usage: node --import ./scripts/text-loader.mjs ...  (or via tsx's --import)
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const TEXT_EXTENSIONS = ['.md'];

export async function load(url, context, nextLoad) {
  if (TEXT_EXTENSIONS.some((ext) => url.endsWith(ext))) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(source)};`,
    };
  }
  return nextLoad(url, context);
}
