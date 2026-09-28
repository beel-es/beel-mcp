/**
 * Load the catalogue of official SDKs from the docs site: a fresh copy, then a
 * stale one, then the snapshot bundled at build time (see
 * `src/docs/catalogue.ts`). The snapshot is written only by `npm run sync:sdks`
 * and is never the primary source.
 */

import { createCatalogueLoader, type LoadedCatalogue } from '../docs/catalogue.js';
import { CACHE_TTL_MS, SDKS_SOURCE } from '../shared/defaults.js';
import type { EnvRecord } from '../shared/env.js';
import { parseSdkCatalog, type SdkCatalog } from './catalog.js';
import snapshot from './snapshot.json';

const sdks = createCatalogueLoader<SdkCatalog>({
  ...SDKS_SOURCE,
  ttlMs: CACHE_TTL_MS.sdks,
  parse: parseSdkCatalog,
  snapshot,
});

/** Drop the cache. Tests use it to observe fetches in isolation. */
export function clearSdksCache(): void {
  sdks.clear();
}

/** The snapshot bundled with this build, parsed once. */
export function snapshotSdkCatalog(): SdkCatalog {
  return sdks.snapshot();
}

export function sdksUrl(env?: EnvRecord): string {
  return sdks.url(env);
}

/** The SDK catalogue. Never throws: the bundled snapshot answers when nothing else does. */
export function loadSdks(env?: EnvRecord): Promise<LoadedCatalogue<SdkCatalog>> {
  return sdks.load(env);
}
