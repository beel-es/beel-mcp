import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ResolvedConfig } from '../config.js';
import { buildApiTools, executeApiTool } from './api-tools.js';
import type { OperationSpec } from '../spec/manifest.js';

/**
 * Synthetic workflow tools that are NOT derived from the OpenAPI spec. They call
 * several API operations and synthesise a compact, actionable answer that no
 * single endpoint gives. Registered alongside the docs tools in the server.
 */

export const SETUP_STATUS = 'beel_get_setup_status';

/** Calls one API operation by operationId; used so tests can inject a fake caller. */
export type OperationCaller = (operationId: string, args: Record<string, unknown>) => Promise<unknown>;

/** Blocker → single recommended next action, phrased around the tool that resolves it. */
const BLOCKER_ACTION: Record<string, string> = {
  COMPANY_HAS_NO_NIF: 'Set the NIF on this company before it can issue.',
  SERIES_DEFAULT_NOT_FOUND: 'Set a default series with beel_set_company_default_series.',
  ENV_MISMATCH:
    'Resolve the environment mismatch (test vs live); see beel_docs_search ["environment"].',
  NIF_NOT_REGISTERED:
    'Register the NIF with AEAT/VeriFactu; see beel_get_company_veri_factu_configuration.',
  NIF_REPRESENTATION_REQUIRED:
    'Generate the VeriFactu representation with beel_generate_company_representation.',
};

export const workflowTools: Tool[] = [
  {
    name: SETUP_STATUS,
    description:
      'Read-only setup status across your account: for each NIF (company) it reports whether ' +
      'it can issue Live, exactly what is missing (issuing-readiness blockers, default series, ' +
      'VeriFactu, payment connection) and the single recommended next action. Use this to drive ' +
      'onboarding instead of guessing. Aggregates several endpoints; degrades gracefully on ' +
      'partial failures.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Optional: restrict the report to a single company (NIF) id.',
        },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'object',
          description: 'The authenticated account, or an error note if identity could not be read.',
          properties: {
            account_id: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string' },
            error: { type: 'string' },
          },
        },
        companies: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              company_id: { type: 'string' },
              nif: { type: 'string' },
              legal_name: { type: 'string' },
              ready: { type: 'boolean', description: 'Can issue Live (no blockers).' },
              blockers: { type: 'array', items: { type: 'string' } },
              default_series: {
                type: 'object',
                properties: {
                  all_configured: { type: 'boolean' },
                  missing: { type: 'array', items: { type: 'string' } },
                },
              },
              verifactu: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  apply_by_default: { type: 'boolean' },
                },
              },
              payment_connection: {
                type: 'object',
                properties: {
                  count: { type: 'integer' },
                  active: { type: 'boolean' },
                },
              },
              missing: {
                type: 'array',
                items: { type: 'string' },
                description: 'Human-readable list of what is missing to issue Live.',
              },
              next_action: { type: 'string', description: 'Single recommended next action.' },
            },
            required: ['company_id', 'ready', 'missing', 'next_action'],
          },
        },
        next_action: {
          type: 'string',
          description: 'Single recommended next action across the whole account.',
        },
      },
      required: ['account', 'companies', 'next_action'],
    },
    annotations: { title: 'Setup status', readOnlyHint: true, openWorldHint: true },
  },
];

export function isWorkflowTool(name: string): boolean {
  return name === SETUP_STATUS;
}

/** Build a caller bound to the resolved config, resolving operations from the spec. */
function defaultCaller(config: ResolvedConfig): OperationCaller {
  const { tools } = buildApiTools();
  const byId = new Map<string, OperationSpec>(tools.map((t) => [t.operation.operationId, t.operation]));
  return async (operationId, args) => {
    const op = byId.get(operationId);
    if (!op) throw new Error(`Unknown operation: ${operationId}`);
    return executeApiTool(config, op, args);
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Run a sub-call, swallowing failures so one bad endpoint never sinks the report. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

interface CompanyReport {
  company_id: string;
  nif?: string;
  legal_name?: string;
  ready: boolean;
  blockers: string[];
  default_series: { all_configured: boolean; missing: string[] } | null;
  verifactu: { enabled: boolean; apply_by_default: boolean } | null;
  payment_connection: { count: number; active: boolean } | null;
  missing: string[];
  next_action: string;
}

async function reportForCompany(call: OperationCaller, company: Record<string, unknown>): Promise<CompanyReport> {
  const companyId = String(company.id ?? '');

  const readiness = asRecord(
    await safe(() => call('getCompanyIssuingReadiness', { company_id: companyId })),
  );
  const blockers = asArray(readiness.blockers).map(String);
  const ready = typeof readiness.ready === 'boolean' ? readiness.ready : blockers.length === 0;

  const seriesData = await safe(() => call('getCompanyDefaultSeries', { company_id: companyId }));
  const seriesList = asArray(seriesData);
  const missingSeries = seriesList
    .map(asRecord)
    .filter((s) => s.exists === false)
    .map((s) => String(s.document_type ?? 'unknown'));
  const default_series = seriesData === null
    ? null
    : { all_configured: missingSeries.length === 0, missing: missingSeries };

  const vfData = await safe(() => call('getCompanyVeriFactuConfiguration', { company_id: companyId }));
  const vf = asRecord(vfData);
  const verifactu = vfData === null
    ? null
    : { enabled: vf.enabled === true, apply_by_default: vf.apply_by_default === true };

  const pcData = await safe(() => call('listCompanyPaymentConnections', { company_id: companyId }));
  const connections = asArray(pcData).map(asRecord);
  const payment_connection = pcData === null
    ? null
    : {
        count: connections.length,
        active: connections.some((c) => String(c.status ?? '').toUpperCase() === 'ACTIVE'),
      };

  const missing: string[] = [];
  for (const b of blockers) missing.push(BLOCKER_ACTION[b] ?? `Resolve blocker ${b}.`);
  if (verifactu && !verifactu.enabled) {
    missing.push(
      'VeriFactu is disabled; enable it with beel_update_company_veri_factu_configuration if this NIF must reach AEAT.',
    );
  }
  if (payment_connection && !payment_connection.active) {
    missing.push('No active payment connection; run beel_initiate_payment_connection to get paid.');
  }

  const next_action = ready
    ? missing[0] ?? 'Ready to issue Live. Issue a first invoice with beel_create_company_invoice.'
    : BLOCKER_ACTION[blockers[0] ?? ''] ?? missing[0] ?? 'Check beel_get_company_issuing_readiness.';

  return {
    company_id: companyId,
    nif: company.nif ? String(company.nif) : undefined,
    legal_name: company.legal_name ? String(company.legal_name) : undefined,
    ready,
    blockers,
    default_series,
    verifactu,
    payment_connection,
    missing,
    next_action,
  };
}

export interface SetupStatus {
  account: { account_id?: string; name?: string; email?: string; error?: string };
  companies: CompanyReport[];
  next_action: string;
}

/**
 * Aggregate identity, companies and per-NIF readiness into a compact checklist.
 * `caller` defaults to the spec-derived API caller; tests inject a fake.
 */
export async function getSetupStatus(
  config: ResolvedConfig,
  args: Record<string, unknown>,
  caller?: OperationCaller,
): Promise<SetupStatus> {
  const call = caller ?? defaultCaller(config);
  const filterId = args.company_id ? String(args.company_id) : undefined;

  const identity = asRecord(await safe(() => call('getMyIdentity', {})));
  const accountId = identity.account_id ? String(identity.account_id) : undefined;
  const account = accountId
    ? {
        account_id: accountId,
        name: identity.name ? String(identity.name) : undefined,
        email: identity.email ? String(identity.email) : undefined,
      }
    : { error: 'Could not resolve identity; check the API key.' };

  let companies: CompanyReport[] = [];
  if (accountId) {
    const listData = await safe(() => call('listCompanies', { account_id: accountId }));
    const items = asArray(asRecord(listData).data).map(asRecord);
    const scoped = filterId ? items.filter((c) => String(c.id ?? '') === filterId) : items;
    companies = await Promise.all(scoped.map((c) => reportForCompany(call, c)));
  }

  const notReady = companies.find((c) => !c.ready);
  const next_action = !accountId
    ? 'Set a valid BEEL_API_KEY, then re-run beel_get_setup_status.'
    : companies.length === 0
      ? 'No NIFs yet. Add one with beel_create_company (scope companies:write).'
      : notReady
        ? `${notReady.nif ?? notReady.company_id}: ${notReady.next_action}`
        : 'All NIFs can issue Live. Issue an invoice with beel_create_company_invoice.';

  return { account, companies, next_action };
}
