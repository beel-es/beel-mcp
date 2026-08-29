import { loadSpec, type SpecNode } from '../src/spec/load.js';

/**
 * The error codes and enum values the contract actually names.
 *
 * Read by walking the parsed document rather than searching the file as text.
 * A substring search over the YAML answers yes to any code that happens to sit
 * inside a longer one — `COMPANY_NOT_ACCESSIBLE` inside
 * `ACTIVE_COMPANY_NOT_ACCESSIBLE` — so it confirms codes the API never emits.
 */

const CODE = /^[A-Z][A-Z0-9_]{3,}$/;
const QUOTED_CODE = /`([A-Z][A-Z0-9_]{3,})`/g;

function collect(node: unknown, out: Set<string>): void {
  if (typeof node === 'string') {
    for (const match of node.matchAll(QUOTED_CODE)) out.add(match[1]!);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as SpecNode;
  if (Array.isArray(record.enum)) {
    for (const value of record.enum)
      if (typeof value === 'string' && CODE.test(value)) out.add(value);
  }
  for (const value of Object.values(record)) collect(value, out);
}

let cached: ReadonlySet<string> | null = null;

/** Every error code the contract names: enum members, plus codes quoted in prose. */
export function specErrorCodes(): ReadonlySet<string> {
  if (cached) return cached;
  const out = new Set<string>();
  collect(loadSpec(), out);
  cached = out;
  return out;
}

/**
 * The enum of reasons `EMISSION_NOT_READY` nests in `details.blockers[]`,
 * gathered from every `blockers` array the contract declares.
 */
export function specIssuingBlockers(): ReadonlySet<string> {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as SpecNode;
    const blockers = record.blockers as SpecNode | undefined;
    const items = blockers?.items as SpecNode | undefined;
    if (Array.isArray(items?.enum)) {
      for (const value of items.enum) if (typeof value === 'string') out.add(value);
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(loadSpec());
  return out;
}
