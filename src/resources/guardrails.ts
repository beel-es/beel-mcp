import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import {
  GUARDRAILS,
  GUARDRAIL_URI_PREFIX,
  findGuardrail,
  guardrailUri,
} from '../guardrails/rules.js';
import { ERROR_CATALOG, catalogCodes, docsUrlForCode } from '../guardrails/catalog.js';
import { BEEL_DEFAULTS } from '../shared/defaults.js';
import { loadRules } from '../rules/fetch.js';
import type { Rule, RuleDomain, RulesCatalog } from '../rules/catalog.js';

/**
 * The guardrails as MCP resources, so a client can pin or preload them and a
 * model can read a whole topic instead of the one-line hint in a tool
 * description.
 *
 * Four kinds of resource under `beel://guardrails`:
 *  - the index;
 *  - one per fiscal-rule domain (`beel://guardrails/corrective`, …), generated
 *    from the rules catalogue the docs site publishes — never written here;
 *  - one per API usage guide (`src/guardrails/rules/*.md`);
 *  - the error catalogue.
 *
 * URIs of guides that became rule domains keep resolving (see LEGACY_ALIASES),
 * since a client may have pinned them.
 */

const OVERVIEW_URI = 'beel://guardrails';
const ERRORS_URI = 'beel://guardrails/errors';

/**
 * Former guide URIs whose content now lives in the rules catalogue, mapped to the
 * domains that cover it. Readable, not listed.
 */
export const LEGACY_ALIASES: Record<string, string[]> = {
  'cancel-vs-rectify': ['void', 'corrective'],
  'invoice-types': ['simplified', 'corrective'],
  'regime-keys': ['taxes', 'surcharge'],
};

const staticResources: Resource[] = [
  {
    uri: OVERVIEW_URI,
    name: 'BeeL fiscal rules and API guides (index)',
    description:
      'Index of the fiscal rules BeeL. publishes, grouped by domain (lifecycle, voiding, ' +
      'correctives, numbering, contents, simplified invoices, taxes, dates, QR, VeriFactu ' +
      'records…), plus the API usage guides and the error catalogue.',
    mimeType: 'text/markdown',
  },
  {
    uri: ERRORS_URI,
    name: 'BeeL error codes and what to do about each',
    description:
      'The BeeL error codes this server can add a tool-call remedy or retry advice to, ' +
      'each linked to its canonical documentation page. Consult it when a call fails.',
    mimeType: 'text/markdown',
  },
  ...GUARDRAILS.map((g): Resource => ({
    uri: guardrailUri(g.id),
    name: g.title,
    description: g.summary,
    mimeType: 'text/markdown',
  })),
];

function domainResource(domain: RuleDomain): Resource {
  return {
    uri: guardrailUri(domain.slug),
    name: `Fiscal rules: ${domain.title}`,
    description: domain.description,
    mimeType: 'text/markdown',
  };
}

/** Every resource: the static ones plus one per rule domain of the current catalogue. */
export async function listGuardrailResources(): Promise<Resource[]> {
  const { catalog } = await loadRules();
  const [overview, ...rest] = staticResources;
  return [overview!, ...catalog.domains.map(domainResource), ...rest];
}

function overviewBody(catalog: RulesCatalog): string {
  return [
    '# BeeL fiscal rules and API guides',
    '',
    'Spanish invoicing has invariants that are not visible in a request schema. Find the',
    'rule that applies with `beel_rules_list` and read it with `beel_rules_get` before',
    'mutating fiscal data; `beel_docs_search` covers guides and worked examples.',
    '',
    '## Fiscal rules, by domain',
    '',
    ...catalog.domains.map(
      (d) =>
        `- **${d.title}** (${d.prefix}, ${d.rules.length} rules) — ${d.description}\n` +
        `  \`${guardrailUri(d.slug)}\``,
    ),
    '',
    '## API usage guides',
    '',
    ...GUARDRAILS.map((g) => `- **${g.title}** — ${g.summary}\n  \`${guardrailUri(g.id)}\``),
    '',
    '## Error codes',
    '',
    `\`${ERRORS_URI}\` explains every error code this API answers with, and what each one`,
    'calls for. A subset is checked before the request is even sent, so those arrive as a',
    'refusal from this server rather than as an API error.',
  ].join('\n');
}

function ruleSection(rule: Rule): string {
  const lines = [`## ${rule.id} · ${rule.severity} · ${rule.title}`, '', rule.statement];
  if (rule.error_codes.length > 0) {
    lines.push('', `Error codes: ${rule.error_codes.map((e) => `\`${e.code}\``).join(', ')}`);
  }
  lines.push(`Enforced by: ${rule.enforced_by} · ${rule.url}`);
  return lines.join('\n');
}

function domainBody(catalog: RulesCatalog, domain: RuleDomain): string {
  const rules = catalog.rules.filter((r) => r.domain === domain.slug);
  return [
    `# ${domain.title}`,
    '',
    domain.description,
    '',
    'Each rule in full (why, legal basis, examples): `beel_rules_get` with its id.',
    '',
    ...rules.map(ruleSection).join('\n\n').split('\n'),
    '',
    '---',
    '',
    `Canonical documentation: ${domain.url}`,
  ].join('\n');
}

function errorsBody(): string {
  const byActor: Record<string, string[]> = {
    request: ['## Fix the request and retry', ''],
    configuration: ['## Account configuration — a human must change something', ''],
    access: ['## Access or quota — retrying unchanged will not help', ''],
    benign: ['## Not a failure — the operation already happened, or is in flight', ''],
  };

  for (const code of catalogCodes()) {
    const entry = ERROR_CATALOG[code]!;
    const parts = [`- **\`${code}\`** — ${docsUrlForCode(code)}`];
    if (entry.remedy) parts.push(`  ${entry.remedy}`);
    if (entry.guardrail) parts.push(`  Background: \`${guardrailUri(entry.guardrail)}\``);
    byActor[entry.actor]!.push(parts.join('\n'));
  }

  return [
    '# BeeL error codes',
    '',
    'Every BeeL error carries its own documentation link as the RFC 7807 `type` field, and',
    `every code has a page under \`${BEEL_DEFAULTS.docsUrl}/errors/<CODE>\`. That is the`,
    'canonical explanation of what a code means, in the language you asked for. The fiscal',
    'rules a code enforces: `beel_rules_get` with `error_code`.',
    '',
    'Listed here are only the codes this server can add something to: the tool call that',
    'resolves them, and whether retrying is worth attempting. A code missing from this list',
    "is not an omission — it means the API's own message says everything worth saying.",
    '',
    ...Object.values(byActor).flat(),
  ].join('\n');
}

/** Resolve a guardrail resource URI to its Markdown; null if unknown. */
export async function readGuardrailResource(uri: string): Promise<string | null> {
  if (uri === ERRORS_URI) return errorsBody();
  if (uri !== OVERVIEW_URI && !uri.startsWith(GUARDRAIL_URI_PREFIX)) return null;

  const id = uri.slice(GUARDRAIL_URI_PREFIX.length);
  const guide = findGuardrail(id);
  if (guide) {
    return `# ${guide.title}\n\n${guide.body}\n\n---\n\nCanonical documentation: ${guide.docPath}`;
  }

  const { catalog } = await loadRules();
  if (uri === OVERVIEW_URI) return overviewBody(catalog);

  const domain = catalog.domains.find((d) => d.slug === id);
  if (domain) return domainBody(catalog, domain);

  const aliased = LEGACY_ALIASES[id]
    ?.map((slug) => catalog.domains.find((d) => d.slug === slug))
    .filter((d): d is RuleDomain => d !== undefined);
  if (aliased && aliased.length > 0) {
    return [
      `> This topic is now covered by the fiscal rules catalogue: ${aliased
        .map((d) => `\`${guardrailUri(d.slug)}\``)
        .join(' and ')}.`,
      '',
      ...aliased.map((d) => domainBody(catalog, d)),
    ].join('\n\n');
  }
  return null;
}
