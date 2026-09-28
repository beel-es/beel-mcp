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
  createCompanySimplifiedExchange: ['simplified', 'records', 'verifactu-gates'],
  setCompanyInvoiceStatus: ['invoice-state-machine'],
  setCompanyInvoiceSchedule: ['lifecycle', 'invoice-state-machine'],
  // Removing a schedule touches no void or corrective rule, which the lifecycle tag would bring.
  deleteCompanyInvoiceSchedule: ['lifecycle', 'invoice-state-machine'],
  // Readiness is the VeriFactu and issuing gate, not the multi-NIF model its Company tag names.
  getCompanyIssuingReadiness: ['verifactu-gates'],
  // Only the operations that carry lines meet the simplified and tax rules; pausing,
  // skipping or deleting a recurring invoice does not, so its tag maps nothing.
  createCompanyRecurringInvoice: ['simplified', 'taxes'],
  patchCompanyRecurringInvoice: ['simplified', 'taxes'],
  createCompanyRecurringInvoiceDerivation: ['simplified', 'taxes'],
  generateCompanyRecurringInvoiceNow: ['simplified', 'taxes'],
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
 *
 * A read (GET) carries no footer: the server instructions skip the rules for
 * listing and reading, and a footer there would say the opposite.
 */
export function describeTool(op: OperationSpec): string {
  const base = op.description?.trim() || op.summary;
  const ids = op.method === 'GET' ? [] : guardrailIdsFor(op);
  if (ids.length === 0) {
    return `${base}\n\nEndpoint: ${op.method} ${op.path}`;
  }
  const domains = ids.filter((id) => !ONE_LINER[id]);
  const guides = ids
    .filter((id) => ONE_LINER[id])
    .map((id) => `- ${ONE_LINER[id]} (resource: ${guardrailUri(id)})`);
  const lines = [base, '', `Endpoint: ${op.method} ${op.path}`, '', 'Relevant rules:'];
  if (domains.length > 0) {
    lines.push(`- Fiscal rules, domains ${domains.join(', ')}: beel_rules_list with domain.`);
  }
  lines.push(...guides);
  // What to do on a fiscal error is general guidance and lives in the server
  // instructions, once, instead of at the end of every tool.
  return lines.join('\n');
}

/** The guardrail ids relevant to an operation (exposed for tests/introspection). */
export function guardrailsForOperation(op: OperationSpec): string[] {
  return guardrailIdsFor(op);
}
