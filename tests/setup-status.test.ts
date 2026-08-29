import { describe, expect, it } from 'vitest';
import {
  getSetupStatus,
  isWorkflowTool,
  workflowTools,
  SETUP_STATUS,
} from '../src/tools/workflow-tools.js';
import type { OperationCaller } from '../src/tools/workflow-tools.js';
import { assertValidOutput } from '../src/tools/validate-args.js';
import { ApiError } from '../src/api/client.js';
import type { ResolvedConfig } from '../src/config.js';

const config: ResolvedConfig = {
  apiKey: 'beel_sk_test_x',
  env: 'test',
  baseUrl: 'https://app.beel.es/api',
  transport: 'stdio',
};

const setupTool = workflowTools.find((t) => t.name === SETUP_STATUS)!;

/** A fake API caller that answers each operationId from a fixture map. */
function fakeCaller(
  responses: Record<string, unknown>,
  fail: Map<string, unknown> = new Map(),
): OperationCaller {
  return async (operationId) => {
    if (fail.has(operationId)) throw fail.get(operationId);
    return responses[operationId];
  };
}

/** A healthy account with one fully configured company. */
const HEALTHY: Record<string, unknown> = {
  getMyIdentity: { account_id: 'acc-1', name: 'Ada', email: 'ada@example.com' },
  listCompanies: { companies: [{ id: 'co-1', nif: 'B1', legal_name: 'One SL' }] },
  getCompanyIssuingReadiness: { ready: true, blockers: [] },
  getCompanyDefaultSeries: { defaults: [{ document_type: 'F1', exists: true }] },
  getCompanyVeriFactuConfiguration: { enabled: true, apply_by_default: true },
  listCompanyPaymentConnections: { connections: [{ status: 'ACTIVE' }] },
};

describe('beel_get_setup_status', () => {
  it('is registered as a workflow tool with an output schema', () => {
    expect(isWorkflowTool(SETUP_STATUS)).toBe(true);
    expect(setupTool.outputSchema).toBeDefined();
    expect(setupTool.annotations?.readOnlyHint).toBe(true);
  });

  it('describes company_id as the company id, never as the NIF', () => {
    const schema = setupTool.inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    expect(schema.properties.company_id?.description).toMatch(/UUID/);
    expect(setupTool.description).not.toMatch(/each NIF/);
  });

  it('aggregates identity, companies and per-company readiness into a checklist', async () => {
    const caller = fakeCaller({
      ...HEALTHY,
      getCompanyIssuingReadiness: { ready: false, blockers: ['SERIES_DEFAULT_NOT_FOUND'] },
      getCompanyDefaultSeries: {
        defaults: [
          { document_type: 'F1', exists: false },
          { document_type: 'F2', exists: true },
        ],
      },
      getCompanyVeriFactuConfiguration: { enabled: false, apply_by_default: false },
      listCompanyPaymentConnections: { connections: [] },
    });

    const status = await getSetupStatus(config, {}, caller);
    assertValidOutput(setupTool, status);

    expect(status.account.account_id).toBe('acc-1');
    const co = status.companies[0]!;
    expect(co.nif).toBe('B1');
    expect(co.ready).toBe(false);
    expect(co.blockers).toContain('SERIES_DEFAULT_NOT_FOUND');
    expect(co.default_series).toEqual({ all_configured: false, missing: ['F1'] });
    expect(co.verifactu).toEqual({ enabled: false, apply_by_default: false });
    expect(co.next_action).toContain('beel_set_default_series');
    expect(status.next_action).toContain('B1');
  });

  it('marks a fully-configured company as ready', async () => {
    const status = await getSetupStatus(config, {}, fakeCaller(HEALTHY));
    assertValidOutput(setupTool, status);
    const co = status.companies[0]!;
    expect(co.ready).toBe(true);
    expect(co.payment_connection).toEqual({ count: 1, active: true });
    expect(status.next_action).toContain('beel_create_invoice');
  });

  it('reads the listing envelope the API actually returns', async () => {
    const caller = fakeCaller({
      ...HEALTHY,
      listCompanies: {
        companies: [{ id: 'co-1', nif: 'B1' }],
        pagination: { current_page: 1, total_items: 1 },
      },
      getCompanyDefaultSeries: { defaults: [{ document_type: 'F1', exists: false }] },
    });
    const status = await getSetupStatus(config, {}, caller);
    expect(status.companies).toHaveLength(1);
    expect(status.companies[0]!.default_series).toEqual({ all_configured: false, missing: ['F1'] });
    expect(status.companies[0]!.payment_connection).toEqual({ count: 1, active: true });
  });

  it('reports a listing that is not the contract envelope instead of an empty account', async () => {
    // A bare array is not what the contract declares. Accepting one means the
    // day the shape changes, an account with companies is reported as having
    // none — and "no companies" is an answer, not a failure.
    const status = await getSetupStatus(
      config,
      {},
      fakeCaller({ ...HEALTHY, listCompanies: [{ id: 'co-1', nif: 'B1' }] }),
    );
    assertValidOutput(setupTool, status);
    expect(status.companies).toEqual([]);
    expect(status.error).toMatch(/Could not list companies/);
    expect(status.next_action).not.toMatch(/No companies yet/);
  });
});

describe('a failure is never reported as a positive answer', () => {
  it('leaves readiness unknown rather than ready when the check fails', async () => {
    const caller = fakeCaller(
      HEALTHY,
      new Map([['getCompanyIssuingReadiness', new ApiError('Forbidden', 403, 'FORBIDDEN')]]),
    );
    const status = await getSetupStatus(config, {}, caller);
    assertValidOutput(setupTool, status);
    const co = status.companies[0]!;
    expect(co.ready).toBeNull();
    expect(co.error).toContain('FORBIDDEN');
    expect(co.next_action).toMatch(/unknown/i);
    expect(co.next_action).not.toMatch(/Ready to issue Live/);
    expect(status.next_action).not.toMatch(/All companies can issue Live/);
  });

  it('carries the reason on each section that could not be read', async () => {
    const failures = new Map<string, unknown>([
      ['getCompanyVeriFactuConfiguration', new ApiError('Nope', 403, 'FORBIDDEN')],
      ['getCompanyDefaultSeries', new Error('network down')],
      ['listCompanyPaymentConnections', new ApiError('Gone', 502)],
    ]);
    const status = await getSetupStatus(config, {}, fakeCaller(HEALTHY, failures));
    assertValidOutput(setupTool, status);
    const co = status.companies[0]!;
    expect(co.verifactu.error).toContain('FORBIDDEN');
    expect(co.verifactu.enabled).toBeUndefined();
    expect(co.default_series.error).toContain('network down');
    expect(co.default_series.all_configured).toBeUndefined();
    expect(co.payment_connection.error).toContain('HTTP 502');
    // A section that failed contributes no remedy: we do not know it is missing.
    expect(co.missing).toEqual([]);
  });

  it('reports a missing identity with the remedy that fits the transport', async () => {
    const failing = new Map<string, unknown>([['getMyIdentity', new Error('boom')]]);
    const stdio = await getSetupStatus(config, {}, fakeCaller({}, failing));
    expect(stdio.account.error).toContain('boom');
    expect(stdio.next_action).toContain('BEEL_API_KEY');

    const remote = await getSetupStatus(
      { ...config, transport: 'remote' },
      {},
      fakeCaller({}, failing),
    );
    // A remote caller has no environment to edit; they re-authorize.
    expect(remote.next_action).not.toContain('BEEL_API_KEY');
    expect(remote.next_action).toMatch(/authoriz/i);
  });

  it('reports an identity response that carries no account id', async () => {
    const status = await getSetupStatus(config, {}, fakeCaller({ getMyIdentity: { name: 'Ada' } }));
    expect(status.account.error).toMatch(/no account_id/);
  });
});

describe('the company_id filter', () => {
  const twoCompanies = {
    ...HEALTHY,
    listCompanies: {
      companies: [
        { id: 'co-1', nif: 'B1' },
        { id: 'co-2', nif: 'B2' },
      ],
    },
  };

  it('restricts the report to the requested company', async () => {
    const status = await getSetupStatus(config, { company_id: 'co-2' }, fakeCaller(twoCompanies));
    expect(status.companies).toHaveLength(1);
    expect(status.companies[0]!.company_id).toBe('co-2');
  });

  it('says the filter matched nothing instead of reporting an empty account', async () => {
    const status = await getSetupStatus(config, { company_id: 'B1' }, fakeCaller(twoCompanies));
    assertValidOutput(setupTool, status);
    expect(status.companies).toEqual([]);
    expect(status.error).toContain('company_id B1 not found in this account (2 companies visible)');
    expect(status.next_action).not.toMatch(/No companies yet/);
  });
});

describe('listing entries and fan-out', () => {
  it('skips a company with no id and says how many it skipped', async () => {
    const caller = fakeCaller({
      ...HEALTHY,
      listCompanies: { companies: [{ id: 'co-1', nif: 'B1' }, { nif: 'B2' }] },
    });
    const status = await getSetupStatus(config, {}, caller);
    assertValidOutput(setupTool, status);
    expect(status.companies.map((c) => c.company_id)).toEqual(['co-1']);
    expect(status.error).toContain('1 of 2 companies were skipped');
  });

  it('never calls an endpoint with an empty company id', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const caller: OperationCaller = async (operationId, args) => {
      seen.push(args);
      return (HEALTHY as Record<string, unknown>)[operationId];
    };
    await getSetupStatus(config, {}, async (operationId, args) => {
      if (operationId === 'listCompanies') return { companies: [{ nif: 'B2' }] };
      return caller(operationId, args);
    });
    expect(seen.every((args) => args.company_id !== '')).toBe(true);
  });

  it('keeps at most four companies in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const companies = Array.from({ length: 12 }, (_unused, i) => ({ id: `co-${i}`, nif: `B${i}` }));
    const caller: OperationCaller = async (operationId) => {
      if (operationId === 'getMyIdentity') return { account_id: 'acc-1' };
      if (operationId === 'listCompanies') return { companies };
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return (HEALTHY as Record<string, unknown>)[operationId];
    };
    const status = await getSetupStatus(config, {}, caller);
    expect(status.companies).toHaveLength(12);
    // Four companies, one sub-call each at any instant.
    expect(peak).toBeLessThanOrEqual(4);
  });
});
