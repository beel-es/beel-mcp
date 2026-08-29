/**
 * The registration half of the text-module loader. Node's `register()` requires
 * the hooks to live in their own module, loaded by specifier, which is why this
 * is two files rather than one.
 *
 * It registers the hooks in text-loader-hooks.mjs so that
 * `import text from './x.md'` works under plain Node and tsx, matching the
 * loaders tsup, wrangler and vitest provide in their own pipelines.
 *
 * Usage: tsx --import ./scripts/text-loader.mjs <entry>
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./text-loader-hooks.mjs', pathToFileURL(import.meta.filename));
