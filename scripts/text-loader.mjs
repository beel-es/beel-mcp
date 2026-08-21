/**
 * Registers the text-module loader hooks (see text-loader-hooks.mjs) so that
 * `import text from './x.md'` works under plain Node and tsx, matching the
 * loaders tsup, wrangler and vitest provide in their own pipelines.
 *
 * Usage: tsx --import ./scripts/text-loader.mjs <entry>
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./text-loader-hooks.mjs', pathToFileURL(import.meta.filename));
