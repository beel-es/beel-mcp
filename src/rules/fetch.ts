/**
 * Load the fiscal rules catalogue from the docs site: a fresh copy, then a
 * stale one, then the snapshot bundled at build time (see
 * `src/docs/catalogue.ts`). The snapshot is written only by
 * `npm run sync:rules` and is never the primary source.
 */

import { createCatalogueLoader, type CatalogueOrigin } from '../docs/catalogue.js';
import { CACHE_TTL_MS, RULES_SOURCE } from '../shared/defaults.js';
import type { EnvRecord } from '../shared/env.js';
import { parseRulesCatalog, type RulesCatalog } from './catalog.js';
import snapshot from './snapshot.json';

/** Where the catalogue in hand came from. */
export type RulesOrigin = CatalogueOrigin;

export interface LoadedRules {
  catalog: RulesCatalog;
  origin: RulesOrigin;
}

const rules = createCatalogueLoader<RulesCatalog>({
  ...RULES_SOURCE,
  ttlMs: CACHE_TTL_MS.rules,
  parse: parseRulesCatalog,
  snapshot,
});

/** Drop the cache. Tests use it to observe fetches in isolation. */
export function clearRulesCache(): void {
  rules.clear();
}

/** The snapshot bundled with this build, parsed once. */
export function snapshotCatalog(): RulesCatalog {
  return rules.snapshot();
}

export function rulesUrl(env?: EnvRecord): string {
  return rules.url(env);
}

/**
 * The rules catalogue. Never throws: when the network and every cached copy
 * fail, the bundled snapshot answers, and `origin` says so.
 */
export function loadRules(env?: EnvRecord): Promise<LoadedRules> {
  return rules.load(env);
}
