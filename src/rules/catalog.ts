/**
 * The fiscal rules catalogue, as the documentation site publishes it at
 * `/api/rules.json`.
 *
 * This file only describes and checks the shape. Every word of a rule comes from
 * the published catalogue — nothing fiscal is written here — so the server and
 * the documentation cannot disagree about what a rule says.
 *
 * The parser is strict about the fields the tools read and ignores the rest: a
 * field added upstream must not break the server, while a field the tools rely
 * on going missing must fail loudly rather than render as "undefined".
 */

export type Severity = 'MUST' | 'MUST_NOT' | 'SHOULD' | string;

export interface RuleDomain {
  slug: string;
  prefix: string;
  title: string;
  description: string;
  url: string;
  rules: string[];
}

export interface RuleErrorCode {
  code: string;
  url: string;
}

export interface LegalBasis {
  type: string;
  norm: string;
  article?: string;
  quote?: string;
  url?: string;
}

export interface RuleExample {
  text: string;
  lang?: string;
  code?: string;
}

export interface Rule {
  id: string;
  title: string;
  domain: string;
  severity: Severity;
  impact: string;
  kind: string;
  enforced_by: string;
  statement: string;
  why: string;
  applies_to: Record<string, unknown>;
  error_codes: RuleErrorCode[];
  legal_basis: LegalBasis[];
  decision: unknown[];
  examples: { correct?: RuleExample; incorrect?: RuleExample };
  related: string[];
  docs: string[];
  facts: unknown[];
  since: string;
  url: string;
  markdown: string;
}

export interface RulesCatalog {
  version: number;
  schema: string;
  source: string;
  text_format: string;
  /** Terms of use of the catalogue, as published. Passed through untouched. */
  license?: unknown;
  domains: RuleDomain[];
  rules: Rule[];
}

/** Raised when a document does not have the catalogue's shape. */
export class RulesCatalogError extends Error {
  constructor(problems: string[]) {
    super(`Not a valid rules catalogue: ${problems.slice(0, 5).join('; ')}`);
    this.name = 'RulesCatalogError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const STRING_FIELDS = [
  'id',
  'title',
  'domain',
  'severity',
  'impact',
  'kind',
  'enforced_by',
  'statement',
  'why',
  'since',
  'url',
  'markdown',
] as const;

const ARRAY_FIELDS = [
  'error_codes',
  'legal_basis',
  'decision',
  'related',
  'docs',
  'facts',
] as const;

function ruleProblems(rule: unknown, index: number): string[] {
  if (!isRecord(rule)) return [`rules[${index}] is not an object`];
  const where = `rules[${index}]${typeof rule.id === 'string' ? ` (${rule.id})` : ''}`;
  const problems: string[] = [];
  for (const field of STRING_FIELDS) {
    if (typeof rule[field] !== 'string') problems.push(`${where}.${field} is not a string`);
  }
  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(rule[field])) problems.push(`${where}.${field} is not an array`);
  }
  if (!isRecord(rule.applies_to)) problems.push(`${where}.applies_to is not an object`);
  if (!isRecord(rule.examples)) problems.push(`${where}.examples is not an object`);
  if (Array.isArray(rule.error_codes)) {
    rule.error_codes.forEach((entry, i) => {
      if (!isRecord(entry) || typeof entry.code !== 'string' || typeof entry.url !== 'string') {
        problems.push(`${where}.error_codes[${i}] lacks code/url`);
      }
    });
  }
  if (Array.isArray(rule.legal_basis)) {
    rule.legal_basis.forEach((entry, i) => {
      if (!isRecord(entry) || typeof entry.norm !== 'string') {
        problems.push(`${where}.legal_basis[${i}] lacks norm`);
      }
    });
  }
  return problems;
}

function domainProblems(domain: unknown, index: number): string[] {
  if (!isRecord(domain)) return [`domains[${index}] is not an object`];
  const problems: string[] = [];
  for (const field of ['slug', 'prefix', 'title', 'description', 'url'] as const) {
    if (typeof domain[field] !== 'string') problems.push(`domains[${index}].${field} is missing`);
  }
  if (!Array.isArray(domain.rules)) problems.push(`domains[${index}].rules is not an array`);
  return problems;
}

/** Check a parsed document and return it typed, or throw {@link RulesCatalogError}. */
export function parseRulesCatalog(doc: unknown): RulesCatalog {
  if (!isRecord(doc)) throw new RulesCatalogError(['the document is not an object']);
  const problems: string[] = [];
  if (typeof doc.version !== 'number') problems.push('version is not a number');
  if (!Array.isArray(doc.domains) || doc.domains.length === 0) problems.push('no domains');
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) problems.push('no rules');
  if (problems.length > 0) throw new RulesCatalogError(problems);

  (doc.domains as unknown[]).forEach((d, i) => problems.push(...domainProblems(d, i)));
  (doc.rules as unknown[]).forEach((r, i) => problems.push(...ruleProblems(r, i)));

  if (problems.length === 0) {
    const slugs = new Set((doc.domains as RuleDomain[]).map((d) => d.slug));
    for (const rule of doc.rules as Rule[]) {
      if (!slugs.has(rule.domain)) problems.push(`${rule.id}.domain "${rule.domain}" is unknown`);
    }
  }
  if (problems.length > 0) throw new RulesCatalogError(problems);
  return doc as unknown as RulesCatalog;
}
