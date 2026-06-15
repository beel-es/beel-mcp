import type { SpecNode } from './load.js';

/**
 * Minimal JSON-Pointer `$ref` resolution for the bundled spec. Redocly's bundle
 * keeps internal references (`#/components/...`) rather than inlining them, which
 * avoids the YAML-alias explosion that breaks dereferenced bundles. We resolve
 * those pointers on demand.
 */

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Follow a `#/a/b/c` pointer from the document root. Returns undefined if missing. */
export function resolvePointer(doc: SpecNode, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  const segments = ref.slice(2).split('/').map(decodePointerSegment);
  let node: unknown = doc;
  for (const segment of segments) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * If `node` is a `{ $ref }` object, follow it (chasing chained refs) and return
 * the target. Otherwise return the node unchanged. Cycle-safe.
 */
export function resolveRef(doc: SpecNode, node: unknown): SpecNode | undefined {
  let current = node;
  const seen = new Set<string>();
  while (current && typeof current === 'object' && typeof (current as SpecNode).$ref === 'string') {
    const ref = (current as SpecNode).$ref as string;
    if (seen.has(ref)) return undefined;
    seen.add(ref);
    current = resolvePointer(doc, ref);
  }
  return current && typeof current === 'object' ? (current as SpecNode) : undefined;
}
