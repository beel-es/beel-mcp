import { describe, expect, it } from 'vitest';
import { getSetupStatus, isWorkflowTool, workflowTools, SETUP_STATUS } from '../src/tools/workflow-tools.js';
import type { OperationCaller } from '../src/tools/workflow-tools.js';
import type { ResolvedConfig } from '../src/config.js';

const config: ResolvedConfig = {
  apiKey: 'beel_sk_test_x',
  env: 'test',
  baseUrl: 'https://app.beel.es/api',
};

/** A fake API caller that answers each operationId from a fixture map. */
function fakeCaller(
  responses: Record<string, unknown>,
  fail: Set<string> = new Set(),
): OperationCaller {
  return async (operationId) => {
    if (fail.has(operationId)) throw new Error(`boom ${operationId}`);
    return responses[operationId];
  };
}

describe('beel_get_setup_status', () => {
  it('is registered as a workflow tool with an output schema', () => {
    expect(isWorkflowTool(SETUP_STATUS)).toBe(true);
    const tool = workflowTools.find((t) => t.name === SETUP_STATUS);
    expect(tool).toBeDefined();
    expect(tool?.outputSchema).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('aggregates identity, companies and per-NIF readiness into a checklist', async () => {
    const caller = fakeCaller({
      getMyIdentity: { account_id: 'acc-1', name: 'Ada', email: 'ada@example.com' },
      listCompanies: { data: [{ id: 'co-1', nif: 'B1', legal_name: 'One SL' }] },
      getCompanyIssuingReadiness: { ready: false, blockers: ['SERIES_DEFAULT_NOT_FOUND'] },
      getCompanyDefaultSeries: [
        { document_type: 'F1', exists: false },
        { document_type: 'F2', exists: true },
      ],
      getCompanyVeriFactuConfiguration: { enabled: false, apply_by_default: false },
      listCompanyPaymentConnections: { data: [] },
    });

    const status = await getSetupStatus(config, {}, caller);

    expect(status.account.account_id).toBe('acc-1');
    expect(status.companies).toHaveLength(1);
    const co = status.companies[0]!;
    expect(co.nif).toBe('B1');
    expect(co.ready).toBe(false);
    expect(co.blockers).toContain('SERIES_DEFAULT_NOT_FOUND');
    expect(co.default_series).toEqual({ all_configured: false, missing: ['F1'] });
    expect(co.verifactu).toEqual({ enabled: false, apply_by_default: false });
    expect(co.next_action).toContain('beel_set_company_default_series');
    expect(status.next_action).toContain('B1');
  });

  it('marks a fully-configured NIF as ready', async () => {
    const caller = fakeCaller({
      getMyIdentity: { account_id: 'acc-1' },
      listCompanies: { data: [{ id: 'co-1', nif: 'B9' }] },
      getCompanyIssuingReadiness: { ready: true, blockers: [] },
      getCompanyDefaultSeries: [{ document_type: 'F1', exists: true }],
      getCompanyVeriFactuConfiguration: { enabled: true, apply_by_default: true },
      listCompanyPaymentConnections: { data: [{ status: 'ACTIVE' }] },
    });

    const status = await getSetupStatus(config, {}, caller);
    const co = status.companies[0]!;
    expect(co.ready).toBe(true);
    expect(co.payment_connection).toEqual({ count: 1, active: true });
    expect(status.next_action).toContain('beel_create_company_invoice');
  });

  it('degrades gracefully when a sub-call fails', async () => {
    const caller = fakeCaller(
      {
        getMyIdentity: { account_id: 'acc-1' },
        listCompanies: { data: [{ id: 'co-1', nif: 'B1' }] },
        getCompanyIssuingReadiness: { ready: false, blockers: ['NIF_NOT_REGISTERED'] },
        getCompanyDefaultSeries: [{ document_type: 'F1', exists: true }],
        listCompanyPaymentConnections: { data: [] },
      },
      new Set(['getCompanyVeriFactuConfiguration']),
    );

    const status = await getSetupStatus(config, {}, caller);
    const co = status.companies[0]!;
    expect(co.verifactu).toBeNull(); // failed sub-call degrades to null, not a throw
    expect(co.ready).toBe(false);
    expect(co.blockers).toContain('NIF_NOT_REGISTERED');
    expect(co.default_series?.all_configured).toBe(true);
  });

  it('reports a missing identity without throwing', async () => {
    const caller = fakeCaller({}, new Set(['getMyIdentity']));
    const status = await getSetupStatus(config, {}, caller);
    expect(status.account.error).toBeDefined();
    expect(status.companies).toHaveLength(0);
    expect(status.next_action).toContain('BEEL_API_KEY');
  });

  it('respects the company_id filter', async () => {
    const caller = fakeCaller({
      getMyIdentity: { account_id: 'acc-1' },
      listCompanies: { data: [{ id: 'co-1', nif: 'B1' }, { id: 'co-2', nif: 'B2' }] },
      getCompanyIssuingReadiness: { ready: true, blockers: [] },
      getCompanyDefaultSeries: [{ document_type: 'F1', exists: true }],
      getCompanyVeriFactuConfiguration: { enabled: true, apply_by_default: false },
      listCompanyPaymentConnections: { data: [] },
    });

    const status = await getSetupStatus(config, { company_id: 'co-2' }, caller);
    expect(status.companies).toHaveLength(1);
    expect(status.companies[0]!.company_id).toBe('co-2');
  });
});
