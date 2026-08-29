/**
 * The tags the contract declares.
 *
 * Tags are how guardrails and the tool policy address a whole family of
 * operations at once. A tag that no longer exists matches nothing, so the family
 * it named is silently unguarded, or exposed, without anyone deciding it.
 */
import { loadSpec, type SpecNode } from './load.js';
import { specManifest } from './manifest.js';

let cached: ReadonlySet<string> | null = null;

/** Every tag used by an operation, plus those declared in the document's `tags` list. */
export function tags(): ReadonlySet<string> {
  if (cached) return cached;
  const names = new Set<string>();
  for (const op of specManifest()) for (const tag of op.tags) names.add(tag);
  const declared = (loadSpec() as SpecNode).tags;
  if (Array.isArray(declared)) {
    for (const entry of declared) {
      const name = (entry as SpecNode | null)?.name;
      if (typeof name === 'string') names.add(name);
    }
  }
  cached = names;
  return names;
}

/** Assert a tag exists in the contract, and return it unchanged. */
export function requireTag<T extends string>(tag: T): T {
  if (!tags().has(tag)) {
    throw new Error(`Unknown tag "${tag}": it is not declared in the OpenAPI contract.`);
  }
  return tag;
}
