/**
 * Filtering and rendering of the rules catalogue for a model to read.
 *
 * Output is plain text sized for a context window: a list is one line per rule,
 * and a single rule carries everything the catalogue says about it only when
 * `detailed` is asked for. No wording is added to a rule; the lines here are
 * labels and navigation.
 */

import type { Rule, RuleDomain, RulesCatalog } from './catalog.js';

export type ResponseFormat = 'concise' | 'detailed';

export interface RuleFilters {
  domain?: string;
  enforced_by?: string;
  severity?: string;
  query?: string;
}

/** Longest statement a concise list line carries before it is cut. */
export const CONCISE_STATEMENT_CHARS = 160;
/** Default and ceiling for how many rules a list returns. */
export const LIST_LIMIT = { default: 20, min: 1, max: 200 } as const;

/** Raised for a filter or lookup the catalogue cannot answer; the message says how to fix it. */
export class RulesQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesQueryError';
  }
}

function distinct(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Split a free-text query into lowercase words; every word must match. */
function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

function assertKnown(value: string, known: string[], field: string): void {
  if (!known.includes(value)) {
    throw new RulesQueryError(
      `Unknown ${field} "${value}". Use one of: ${known.join(', ')}. ` +
        `Omit ${field} to list every value.`,
    );
  }
}

/** Rules matching every filter given, in catalogue order. */
export function filterRules(catalog: RulesCatalog, filters: RuleFilters): Rule[] {
  const { domain, enforced_by, severity, query } = filters;
  if (domain)
    assertKnown(
      domain,
      catalog.domains.map((d) => d.slug),
      'domain',
    );
  if (enforced_by) {
    assertKnown(enforced_by, distinct(catalog.rules.map((r) => r.enforced_by)), 'enforced_by');
  }
  const wantedSeverity = severity?.toUpperCase();
  if (wantedSeverity) {
    assertKnown(wantedSeverity, distinct(catalog.rules.map((r) => r.severity)), 'severity');
  }
  const words = query ? queryWords(query) : [];

  return catalog.rules.filter((rule) => {
    if (domain && rule.domain !== domain) return false;
    if (enforced_by && rule.enforced_by !== enforced_by) return false;
    if (wantedSeverity && rule.severity !== wantedSeverity) return false;
    if (words.length > 0) {
      const haystack = `${rule.id} ${rule.title} ${rule.statement}`.toLowerCase();
      if (!words.every((w) => haystack.includes(w))) return false;
    }
    return true;
  });
}

/**
 * How strong a rule is. MUST and MUST_NOT both read «required»: the title and
 * the statement already say what to do or not to do, and a «MUST_NOT» in front
 * of a title written as an instruction («Keep invoicing when AEAT is
 * unreachable») reads as its opposite. The `severity` filter still takes the
 * catalogue's values.
 */
export function strength(rule: Rule): string {
  return rule.severity === 'SHOULD' ? 'recommended' : 'required';
}

export function listLine(rule: Rule, format: ResponseFormat): string {
  const statement =
    format === 'detailed' ? rule.statement : truncate(rule.statement, CONCISE_STATEMENT_CHARS);
  return `${rule.id} · ${strength(rule)} · ${statement} · ${rule.enforced_by}`;
}

function domainLine(domain: RuleDomain): string {
  return `- ${domain.slug} (${domain.prefix}, ${domain.rules.length}) — ${domain.title}`;
}

export function renderDomainList(catalog: RulesCatalog): string {
  return ['Domains (filter with domain=<slug>):', ...catalog.domains.map(domainLine)].join('\n');
}

export function renderRuleList(
  catalog: RulesCatalog,
  filters: RuleFilters,
  format: ResponseFormat,
  limit: number,
): string {
  const matches = filterRules(catalog, filters);
  const unfiltered = !filters.domain && !filters.enforced_by && !filters.severity && !filters.query;
  const parts: string[] = [];

  if (unfiltered) parts.push(renderDomainList(catalog), '');

  if (matches.length === 0) {
    parts.push(
      'No rule matches these filters. Drop a filter, or use fewer query words ' +
        '(every word must appear in the rule id, title or statement).',
    );
    return parts.join('\n');
  }

  const shown = matches.slice(0, limit);
  parts.push(
    `${matches.length} rule${matches.length === 1 ? '' : 's'} (ID · SEVERITY · statement · enforced_by):`,
  );
  parts.push(...shown.map((rule) => listLine(rule, format)));
  if (matches.length > shown.length) {
    parts.push(
      `… ${matches.length - shown.length} more. Narrow with domain, severity or query, or raise limit.`,
    );
  }
  parts.push('', 'Full rule: beel_rules_get with id.');
  return parts.join('\n');
}

function renderExample(
  label: string,
  example: { text: string; code?: string } | undefined,
): string[] {
  if (!example) return [];
  return [`${label}: ${example.text}`, ...(example.code ? [example.code] : [])];
}

/** One rule. `concise` is statement, why and link; `detailed` is everything the catalogue holds. */
export function renderRule(rule: Rule, format: ResponseFormat): string {
  const lines = [
    `${rule.id} · ${rule.title} (${strength(rule)})`,
    `Domain: ${rule.domain} · enforced by: ${rule.enforced_by} · impact: ${rule.impact}`,
    '',
    rule.statement,
    '',
    `Why: ${rule.why}`,
  ];

  if (rule.error_codes.length > 0) {
    lines.push('', `Error codes: ${rule.error_codes.map((e) => e.code).join(', ')}`);
  }

  if (format === 'detailed') {
    if (rule.legal_basis.length > 0) {
      lines.push('', 'Legal basis:');
      for (const basis of rule.legal_basis) {
        const cite = [basis.norm, basis.article].filter(Boolean).join(', ');
        lines.push(`- ${cite}${basis.url ? ` — ${basis.url}` : ''}`);
        if (basis.quote) lines.push(`  «${basis.quote}»`);
      }
    }
    const examples = [
      ...renderExample('Incorrect', rule.examples.incorrect),
      ...renderExample('Correct', rule.examples.correct),
    ];
    if (examples.length > 0) lines.push('', ...examples);
    if (rule.related.length > 0) lines.push('', `Related: ${rule.related.join(', ')}`);
    if (rule.docs.length > 0) lines.push(`Guides: ${rule.docs.join(' · ')}`);
  } else if (rule.legal_basis.length > 0) {
    lines.push(
      `Legal basis: ${rule.legal_basis.map((b) => [b.norm, b.article].filter(Boolean).join(' ')).join('; ')}`,
    );
  }

  lines.push(`Docs: ${rule.url}`);
  return lines.join('\n');
}

export function findRuleById(catalog: RulesCatalog, id: string): Rule {
  const wanted = id.trim().toUpperCase();
  const rule = catalog.rules.find((r) => r.id === wanted);
  if (rule) return rule;
  const prefix = wanted.split('-')[0] ?? '';
  const domain = catalog.domains.find((d) => d.prefix === prefix);
  throw new RulesQueryError(
    `No rule "${id}". ` +
      (domain
        ? `${domain.prefix} rules are ${domain.rules[0]} to ${domain.rules[domain.rules.length - 1]}; `
        : `Ids look like ${catalog.rules[0]?.id ?? 'LIF-001'}; prefixes are ${catalog.domains.map((d) => d.prefix).join(', ')}. `) +
      'Call beel_rules_list to find the right one.',
  );
}

export function rulesCitingCode(catalog: RulesCatalog, code: string): Rule[] {
  const wanted = code.trim().toUpperCase();
  return catalog.rules.filter((rule) => rule.error_codes.some((e) => e.code === wanted));
}

export function renderRulesForCode(
  catalog: RulesCatalog,
  code: string,
  format: ResponseFormat,
): string {
  const rules = rulesCitingCode(catalog, code);
  if (rules.length === 0) {
    throw new RulesQueryError(
      `No rule cites the error code "${code}". That does not make it invalid: the API's own ` +
        `message and its page under /errors/${code.trim().toUpperCase()} explain it. ` +
        'Search the rules by topic with beel_rules_list and query.',
    );
  }
  return [
    `${rules.length} rule${rules.length === 1 ? '' : 's'} cite ${code.trim().toUpperCase()}:`,
    '',
    rules.map((rule) => renderRule(rule, format)).join('\n\n---\n\n'),
  ].join('\n');
}
