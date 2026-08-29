import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KeyEnv, ResolvedConfig, Transport } from '../config.js';
import { buildApiTools, executeApiTool } from './api-tools.js';
import type { OperationSpec } from '../spec/manifest.js';
import { explainCode } from '../guardrails/explain.js';
import { ApiError } from '../api/client.js';
import { compact, isRecord, readBoolean, readString, stringItems } from '../shared/guards.js';
import { pLimit } from '../shared/fetch.js';

/**
 * Synthetic workflow tools that are NOT derived from the OpenAPI spec. They call
 * several API operations and synthesise a compact, actionable answer that no
 * single endpoint gives. Registered alongside the docs tools in the server.
 */

export const SETUP_STATUS = 'beel_get_setup_status';

/**
 * How many companies are reported on at once.
 *
 * Each company costs four API calls, so an unbounded fan-out over a large
 * account opens hundreds of connections at the same instant and earns a 429 for
 * every one of them.
 */
const MAX_COMPANIES_IN_FLIGHT = 4;

/** Calls one API operation by operationId; used so tests can inject a fake caller. */
export type OperationCaller = (
  operationId: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** A section that could not be read reports why, and never a default value. */
const errorSchema = {
  type: 'string',
  description: 'Why this section could not be read. Present only on failure.',
} as const;

export const workflowTools: Tool[] = [
  {
    name: SETUP_STATUS,
    description:
      'Read-only setup status across your account: for each company it reports whether it can ' +
      'issue Live, exactly what is missing (issuing-readiness blockers, default series, ' +
      'VeriFactu, payment connection) and the single recommended next action. Use this to drive ' +
      'onboarding instead of guessing. Aggregates several endpoints; a section that could not ' +
      'be read carries an `error` and never a default, so an unknown is never reported as ready.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description:
            'Optional: restrict the report to a single company, by its company id (a UUID). ' +
            'This is not the NIF; the NIF is reported as a field of each company.',
        },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        environment: {
          type: 'string',
          enum: ['test', 'live'],
          description:
            'Which BeeL environment this session operates on. `live` means every ' +
            'invoice issued is a real fiscal document.',
        },
        account: {
          type: 'object',
          description: 'The authenticated account, or an error note if identity could not be read.',
          properties: {
            account_id: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string' },
            error: errorSchema,
          },
        },
        error: {
          type: 'string',
          description:
            'Why the report is incomplete: the company listing failed, a filter matched ' +
            'nothing, or entries were unusable. Present only when something went wrong.',
        },
        companies: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              company_id: { type: 'string', description: 'The company id (a UUID), not the NIF.' },
              nif: { type: 'string' },
              legal_name: { type: 'string' },
              ready: {
                type: ['boolean', 'null'],
                description:
                  'Can issue Live (no blockers). `null` means readiness could not be read — ' +
                  'see `error`; it does not mean not ready, and it does not mean ready.',
              },
              blockers: { type: 'array', items: { type: 'string' } },
              error: errorSchema,
              default_series: {
                type: 'object',
                properties: {
                  all_configured: { type: 'boolean' },
                  missing: { type: 'array', items: { type: 'string' } },
                  error: errorSchema,
                },
              },
              verifactu: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  apply_by_default: { type: 'boolean' },
                  error: errorSchema,
                },
              },
              payment_connection: {
                type: 'object',
                properties: {
                  count: { type: 'integer' },
                  active: { type: 'boolean' },
                  error: errorSchema,
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
      required: ['environment', 'account', 'companies', 'next_action'],
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
  const byId = new Map<string, OperationSpec>(
    tools.map((t) => [t.operation.operationId, t.operation]),
  );
  return async (operationId, args) => {
    const op = byId.get(operationId);
    if (!op) throw new Error(`Unknown operation: ${operationId}`);
    return executeApiTool(config, op, args);
  };
}

/** The outcome of a sub-call: a value, or the reason there is none. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** `CODE: message` for an API error, so a section's note is diagnosable. */
function describeFailure(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.code ?? `HTTP ${err.status}`}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run a sub-call so that one failing endpoint does not sink the whole report —
 * without ever turning that failure into an answer. The caller must handle both
 * branches, which is the point: a swallowed 403 that becomes `ready: true` tells
 * an agent it may issue a real fiscal document.
 */
async function attempt<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: describeFailure(err) };
  }
}

/**
 * The array a listing response carries under its own key (`{ companies: [...] }`,
 * `{ defaults: [...] }`, `{ connections: [...] }`) — `executeApiTool` unwraps
 * `data`, not the key inside it.
 *
 * A response that is not that envelope yields `undefined`, never `[]`: an empty
 * list is a positive answer ("this account has no companies") and must only ever
 * come from the API actually saying so.
 */
function listOf(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return Array.isArray(nested) ? nested : undefined;
}

interface SeriesSection {
  all_configured?: boolean;
  missing?: string[];
  error?: string;
}

interface VerifactuSection {
  enabled?: boolean;
  apply_by_default?: boolean;
  error?: string;
}

interface PaymentSection {
  count?: number;
  active?: boolean;
  error?: string;
}

interface CompanyReport {
  company_id: string;
  nif?: string;
  legal_name?: string;
  /** `null` when readiness could not be read: unknown, which is neither yes nor no. */
  ready: boolean | null;
  blockers: string[];
  error?: string;
  default_series: SeriesSection;
  verifactu: VerifactuSection;
  payment_connection: PaymentSection;
  missing: string[];
  next_action: string;
}

const MALFORMED_LISTING = 'the response was not the listing envelope the contract declares';

function seriesSection(outcome: Outcome<unknown>): SeriesSection {
  if (!outcome.ok) return { error: outcome.error };
  const entries = listOf(outcome.value, 'defaults');
  if (!entries) return { error: MALFORMED_LISTING };
  const missing = entries
    .filter((entry) => readBoolean(entry, 'exists') === false)
    .map((entry) => readString(entry, 'document_type') ?? 'unknown');
  return { all_configured: missing.length === 0, missing };
}

function verifactuSection(outcome: Outcome<unknown>): VerifactuSection {
  if (!outcome.ok) return { error: outcome.error };
  return {
    enabled: readBoolean(outcome.value, 'enabled') === true,
    apply_by_default: readBoolean(outcome.value, 'apply_by_default') === true,
  };
}

function paymentSection(outcome: Outcome<unknown>): PaymentSection {
  if (!outcome.ok) return { error: outcome.error };
  const entries = listOf(outcome.value, 'connections');
  if (!entries) return { error: MALFORMED_LISTING };
  return {
    count: entries.length,
    active: entries.some((entry) => (readString(entry, 'status') ?? '').toUpperCase() === 'ACTIVE'),
  };
}

/** What still stands between this company and a Live invoice, in plain words. */
function missingFor(
  blockers: string[],
  verifactu: VerifactuSection,
  payment: PaymentSection,
): string[] {
  const missing: string[] = [];
  // Blocker remedies come from the shared error catalogue rather than a local
  // map, so this report and a failed call always phrase the fix the same way.
  for (const blocker of blockers) missing.push(explainCode(blocker));
  if (verifactu.enabled === false) {
    missing.push(
      'VeriFactu is disabled; enable it with beel_update_verifactu_configuration if this company must reach AEAT.',
    );
  }
  if (payment.active === false) {
    missing.push('No active payment connection; run beel_initiate_payment_connection to get paid.');
  }
  return missing;
}

/**
 * The one action to take next.
 *
 * Unknown readiness never produces an invitation to issue: the agent is told to
 * establish readiness first, because "we could not check" and "you are clear to
 * issue a real fiscal document" are not the same answer.
 */
function nextActionFor(report: Omit<CompanyReport, 'next_action'>): string {
  if (report.ready === null) {
    return (
      `Issuing readiness is unknown (${report.error ?? 'the check did not answer'}); ` +
      're-run beel_get_issuing_readiness before issuing anything Live.'
    );
  }
  if (report.ready) {
    return (
      report.missing[0] ?? 'Ready to issue Live. Issue a first invoice with beel_create_invoice.'
    );
  }
  const firstBlocker = report.blockers[0];
  if (firstBlocker) return explainCode(firstBlocker);
  return report.missing[0] ?? 'Check beel_get_issuing_readiness.';
}

async function reportForCompany(
  call: OperationCaller,
  companyId: string,
  company: unknown,
): Promise<CompanyReport> {
  const args = { company_id: companyId };
  const readiness = await attempt(() => call('getCompanyIssuingReadiness', args));
  const series = seriesSection(await attempt(() => call('getCompanyDefaultSeries', args)));
  const verifactu = verifactuSection(
    await attempt(() => call('getCompanyVeriFactuConfiguration', args)),
  );
  const payment = paymentSection(await attempt(() => call('listCompanyPaymentConnections', args)));

  const blockers = readiness.ok
    ? stringItems(isRecord(readiness.value) ? readiness.value.blockers : undefined)
    : [];
  const declaredReady = readiness.ok ? readBoolean(readiness.value, 'ready') : undefined;
  const ready = readiness.ok ? (declaredReady ?? blockers.length === 0) : null;

  const partial = compact({
    company_id: companyId,
    nif: readString(company, 'nif'),
    legal_name: readString(company, 'legal_name'),
    ready,
    blockers,
    error: readiness.ok ? undefined : readiness.error,
    default_series: series,
    verifactu,
    payment_connection: payment,
    missing: missingFor(blockers, verifactu, payment),
  });
  return { ...partial, next_action: nextActionFor(partial) };
}

export interface SetupStatus {
  /**
   * The environment this session acts on. Computed in exactly one place (see
   * policy/scopes.ts) and surfaced here so the agent can tell whether it is
   * about to touch live fiscal data.
   */
  environment: KeyEnv;
  account: { account_id?: string; name?: string; email?: string; error?: string };
  /** Why the report is incomplete, when it is. */
  error?: string;
  companies: CompanyReport[];
  next_action: string;
}

/** How the caller fixes an unusable credential, which depends on how they connected. */
function credentialRemedy(transport: Transport | undefined): string {
  return transport === 'remote'
    ? 'This session is not authorized against BeeL. Re-run the authorization, then re-run beel_get_setup_status.'
    : 'Set a valid BEEL_API_KEY in the MCP server environment, then re-run beel_get_setup_status.';
}

/** Read the account listing, or say why there is none. Never an empty list on failure. */
async function listCompanies(
  call: OperationCaller,
  accountId: string,
): Promise<Outcome<unknown[]>> {
  const outcome = await attempt(() => call('listCompanies', { account_id: accountId }));
  if (!outcome.ok) return { ok: false, error: `Could not list companies — ${outcome.error}` };
  const entries = listOf(outcome.value, 'companies');
  if (!entries) return { ok: false, error: `Could not list companies — ${MALFORMED_LISTING}` };
  return { ok: true, value: entries };
}

/**
 * Aggregate identity, companies and per-company readiness into a compact checklist.
 * `caller` defaults to the spec-derived API caller; tests inject a fake.
 */
export async function getSetupStatus(
  config: ResolvedConfig,
  args: Record<string, unknown>,
  caller?: OperationCaller,
): Promise<SetupStatus> {
  const call = caller ?? defaultCaller(config);
  const filterId = readString(args, 'company_id');

  const identity = await attempt(() => call('getMyIdentity', {}));
  const accountId = identity.ok ? readString(identity.value, 'account_id') : undefined;
  if (!accountId) {
    const reason = identity.ok ? 'the response carried no account_id' : identity.error;
    return {
      environment: config.env,
      account: { error: `Could not resolve identity — ${reason}` },
      companies: [],
      next_action: credentialRemedy(config.transport),
    };
  }
  const account = compact({
    account_id: accountId,
    name: identity.ok ? readString(identity.value, 'name') : undefined,
    email: identity.ok ? readString(identity.value, 'email') : undefined,
  });

  return companiesReport(call, config, account, filterId);
}

/** The per-company half of the report, once identity is known. */
async function companiesReport(
  call: OperationCaller,
  config: ResolvedConfig,
  account: SetupStatus['account'],
  filterId: string | undefined,
): Promise<SetupStatus> {
  const accountId = account.account_id!;
  const listing = await listCompanies(call, accountId);
  if (!listing.ok) {
    return {
      environment: config.env,
      account,
      error: listing.error,
      companies: [],
      next_action: listing.error,
    };
  }

  const { withId, note } = usableEntries(listing.value);
  const scoped = filterId ? withId.filter((entry) => readString(entry, 'id') === filterId) : withId;
  if (filterId && scoped.length === 0) {
    const error =
      `company_id ${filterId} not found in this account (${withId.length} companies visible). ` +
      'Note that company_id is the company id (a UUID), not the NIF; list them with beel_list_companies.';
    return { environment: config.env, account, error, companies: [], next_action: error };
  }

  const companies = await pLimit(
    MAX_COMPANIES_IN_FLIGHT,
    scoped.map((entry) => () => reportForCompany(call, readString(entry, 'id')!, entry)),
  );

  const notReady = companies.find((c) => c.ready === false);
  const unknown = companies.find((c) => c.ready === null);
  const label = (c: CompanyReport): string => c.nif ?? c.company_id;
  const next_action =
    companies.length === 0
      ? 'No companies yet. Add one with beel_create_company (scope companies:write).'
      : notReady
        ? `${label(notReady)}: ${notReady.next_action}`
        : unknown
          ? `${label(unknown)}: ${unknown.next_action}`
          : 'All companies can issue Live. Issue an invoice with beel_create_invoice.';

  return compact({ environment: config.env, account, error: note, companies, next_action });
}

/**
 * Keep the listing entries that can actually be reported on.
 *
 * A company with no id has no handle: every per-company endpoint is addressed by
 * it, and an empty one addresses a different endpoint entirely. Dropping such an
 * entry is only acceptable if the report says it happened.
 */
function usableEntries(entries: unknown[]): { withId: unknown[]; note?: string } {
  const withId = entries.filter((entry) => readString(entry, 'id') !== undefined);
  const skipped = entries.length - withId.length;
  return {
    withId,
    note:
      skipped > 0
        ? `${skipped} of ${entries.length} companies were skipped: the listing gave them no id.`
        : undefined,
  };
}
