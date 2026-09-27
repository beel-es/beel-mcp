import type { OperationSpec } from '../spec/manifest.js';
import { GUARDRAILS, guardrailUri } from './rules.js';

/**
 * Wire operations to what an agent must respect when calling them: API usage
 * guides (ids of `rules/*.md`) and fiscal-rule domains (slugs of the published
 * rules catalogue). Keyed first by exact operationId, then by tag as a fallback.
 * Guides get their one-line summary in the tool description; domains are named
 * with the tool call that lists their rules, so the rule text itself is never
 * copied into a description and cannot drift from the catalogue.
 *
 * `tests/guardrails.test.ts` asserts every entry is a guide or a domain of the
 * bundled catalogue.
 */
export const BY_OPERATION_ID: Record<string, string[]> = {
  createCompanyInvoice: [
    'simplified',
    'contents',
    'taxes',
    'surcharge',
    'invoice-lines',
    'nif-validation',
    'verifactu-gates',
    'series-and-numbering',
  ],
  patchCompanyInvoice: ['lifecycle', 'invoice-state-machine'],
  deleteCompanyInvoice: ['lifecycle', 'invoice-state-machine'],
  voidCompanyInvoice: ['void', 'lifecycle', 'invoice-state-machine'],
  createCompanyCorrectiveInvoice: [
    'corrective',
    'void',
    'invoice-lines',
    'invoice-state-machine',
    'series-and-numbering',
  ],
  issueCompanyInvoice: ['lifecycle', 'records', 'invoice-state-machine', 'verifactu-gates'],
  setCompanyInvoiceStatus: ['invoice-state-machine'],
  setCompanyInvoiceSchedule: ['lifecycle', 'invoice-state-machine'],
  validateNif: ['nif-validation'],
  createCompanyCustomer: ['nif-validation'],
  createCompanyCustomersBulk: ['nif-validation'],
  updateCompanyVeriFactuConfiguration: ['records', 'verifactu-gates'],
  getCompanyVeriFactuConfiguration: ['verifactu-gates'],
  createCompany: ['multi-nif', 'nif-validation', 'series-and-numbering'],
  createCompanySeries: ['numbering', 'series-and-numbering'],
  patchCompanySeries: ['numbering', 'series-and-numbering'],
  setCompanyDefaultSeries: ['numbering', 'series-and-numbering'],
  listCompanies: ['multi-nif'],
};

export const BY_TAG: Record<string, string[]> = {
  CompanySeries: ['numbering', 'series-and-numbering'],
  CompanyInvoices: ['lifecycle', 'invoice-state-machine'],
  CompanyInvoiceLifecycle: ['lifecycle', 'void', 'corrective', 'invoice-state-machine'],
  CompanyProforma: ['invoice-state-machine'],
  CompanyRecurringInvoices: ['simplified', 'taxes'],
  CompanyVeriFactuConfiguration: ['records', 'verifactu-gates'],
  Company: ['multi-nif'],
  PublicCompanyRepresentations: ['multi-nif'],
};

function guardrailIdsFor(op: OperationSpec): string[] {
  const fromId = BY_OPERATION_ID[op.operationId];
  if (fromId) return fromId;
  const ids = new Set<string>();
  for (const tag of op.tags) for (const id of BY_TAG[tag] ?? []) ids.add(id);
  return [...ids];
}

/** guide id → the one-line summary shown in the tool description footer. */
const ONE_LINER: Record<string, string> = Object.fromEntries(
  GUARDRAILS.map((g) => [g.id, g.summary]),
);

/**
 * Build the full tool description: the operation's own summary/description plus a
 * footer naming the fiscal-rule domains and the API usage guides that apply.
 */
export function describeTool(op: OperationSpec): string {
  const base = op.description?.trim() || op.summary;
  const ids = guardrailIdsFor(op);
  if (ids.length === 0) {
    return `${base}\n\nEndpoint: ${op.method} ${op.path}`;
  }
  const domains = ids.filter((id) => !ONE_LINER[id]);
  const guides = ids
    .filter((id) => ONE_LINER[id])
    .map((id) => `- ${ONE_LINER[id]} (resource: ${guardrailUri(id)})`);
  const lines = [base, '', `Endpoint: ${op.method} ${op.path}`, '', '⚠️ Read before calling:'];
  if (domains.length > 0) {
    lines.push(
      `- Fiscal rules, domains ${domains.join(', ')}: beel_rules_list with domain, or ` +
        `resource ${guardrailUri('<domain>')}.`,
    );
  }
  lines.push(...guides);
  lines.push(
    '',
    'After an error, beel_rules_get with error_code names the rule behind it; ' +
      'beel_docs_search has guides and worked examples.',
  );
  return lines.join('\n');
}

/** The guardrail ids relevant to an operation (exposed for tests/introspection). */
export function guardrailsForOperation(op: OperationSpec): string[] {
  return guardrailIdsFor(op);
}
