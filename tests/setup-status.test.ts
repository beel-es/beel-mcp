import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { clearSdksCache, snapshotSdkCatalog } from '../src/sdks/fetch.js';
import { sdkReport } from '../src/sdks/report.js';

const config: ResolvedConfig = {
  apiKey: 'beel_sk_test_x',
  env: 'test',
  baseUrl: 'https://app.beel.es/api',
  transport: 'stdio',
};

const setupTool = workflowTools.find((t) => t.name === SETUP_STATUS)!;

/** The advertised output schema of one company in the report. */
function companySchemaProperties(): Record<string, { description?: string; properties?: object }> {
  const schema = setupTool.outputSchema as unknown as {
    properties: {
      companies: {
        items: { properties: Record<string, { description?: string; properties?: object }> };
      };
    };
  };
  return schema.properties.companies.items.properties;
}

// The SDK catalogue is read from the docs site; offline, the bundled copy answers.
beforeEach(() => {
  clearSdksCache();
  vi.stubGlobal('fetch', async () => {
    throw new Error('offline');
  });
});
afterEach(() => vi.unstubAllGlobals());

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
  getCompanyDefaultSeries: {
    defaults: [
      {
        document_type: 'STANDARD',
        exists: true,
        series_id: 'ser-1',
        code: 'F',
        provisional: false,
      },
    ],
  },
  getCompanyVeriFactuConfiguration: { enabled: true, apply_by_default: true, status: 'ACTIVE' },
  getCompanyTaxConfiguration: {
    default_main_tax: { type: 'IVA', percentage: 21, regime_key: '01' },
    apply_irpf: true,
    default_irpf_rate: 15,
    irpf_exempt: false,
    apply_equivalence_surcharge: false,
    default_payment_method: 'BANK_TRANSFER',
    withholding_options: { allowed_irpf_rates: [0, 1, 2, 7, 15, 19], suggested_irpf_rate: null },
  },
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
          { document_type: 'F2', exists: true, series_id: 'ser-2', code: 'R' },
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
    expect(co.default_series).toEqual({
      all_configured: false,
      missing: ['F1'],
      defaults: [{ document_type: 'F2', series_id: 'ser-2', code: 'R' }],
    });
    expect(co.verifactu).toEqual({ enabled: false });
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
    expect(status.companies[0]!.default_series).toEqual({
      all_configured: false,
      missing: ['F1'],
      defaults: [],
    });
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

describe('what an integration needs to start', () => {
  it('reports the default series ids, the VeriFactu status and the tax defaults', async () => {
    const status = await getSetupStatus(config, {}, fakeCaller(HEALTHY));
    assertValidOutput(setupTool, status);
    const co = status.companies[0]!;
    expect(co.company_id).toBe('co-1');
    expect(co.nif).toBe('B1');
    expect(co.default_series.defaults).toEqual([
      { document_type: 'STANDARD', series_id: 'ser-1', code: 'F' },
    ]);
    expect(co.verifactu).toEqual({ enabled: true, status: 'ACTIVE' });
    // Under the API's own field names, and only those a line is built from.
    expect(co.tax_defaults).toEqual({
      default_main_tax: { type: 'IVA', percentage: 21, regime_key: '01' },
      apply_irpf: true,
      default_irpf_rate: 15,
      irpf_exempt: false,
      allowed_irpf_rates: [0, 1, 2, 7, 15, 19],
      apply_equivalence_surcharge: false,
    });
  });

  it('does not report the retired apply_by_default, even when a response still carries it', async () => {
    const status = await getSetupStatus(config, {}, fakeCaller(HEALTHY));
    expect(status.companies[0]!.verifactu).not.toHaveProperty('apply_by_default');
    const verifactu = companySchemaProperties().verifactu!;
    expect(Object.keys(verifactu.properties!)).not.toContain('apply_by_default');
  });

  it('asks for the tax configuration of each company by its id', async () => {
    const seen: Array<[string, Record<string, unknown>]> = [];
    await getSetupStatus(config, {}, async (operationId, args) => {
      seen.push([operationId, args]);
      return HEALTHY[operationId];
    });
    expect(seen).toContainEqual(['getCompanyTaxConfiguration', { company_id: 'co-1' }]);
  });

  it('leaves out a series entry with no id, and a tax field of the wrong type', async () => {
    const caller = fakeCaller({
      ...HEALTHY,
      getCompanyDefaultSeries: {
        defaults: [
          { document_type: 'STANDARD', exists: true },
          { document_type: 'SIMPLIFIED', exists: false, series_id: null, code: null },
        ],
      },
      getCompanyTaxConfiguration: {
        default_main_tax: { type: 'IVA' },
        apply_irpf: 'yes',
        default_irpf_rate: '15',
        withholding_options: { allowed_irpf_rates: [0, '19'] },
      },
    });
    const status = await getSetupStatus(config, {}, caller);
    assertValidOutput(setupTool, status);
    const co = status.companies[0]!;
    expect(co.default_series.defaults).toEqual([]);
    expect(co.tax_defaults).toEqual({ allowed_irpf_rates: [0] });
  });

  it('reports a tax configuration that is not an object instead of reading it', async () => {
    const caller = fakeCaller({ ...HEALTHY, getCompanyTaxConfiguration: [] });
    const status = await getSetupStatus(config, {}, caller);
    assertValidOutput(setupTool, status);
    expect(status.companies[0]!.tax_defaults.error).toMatch(/not the object/);
  });

  it('keeps the rest of the report when the tax configuration cannot be read', async () => {
    const failures = new Map<string, unknown>([
      ['getCompanyTaxConfiguration', new ApiError('Missing scope', 403, 'INSUFFICIENT_SCOPE')],
    ]);
    const status = await getSetupStatus(config, {}, fakeCaller(HEALTHY, failures));
    assertValidOutput(setupTool, status);
    const co = status.companies[0]!;
    expect(co.tax_defaults).toEqual({ error: 'INSUFFICIENT_SCOPE: Missing scope' });
    expect(co.ready).toBe(true);
    expect(co.default_series.defaults).toHaveLength(1);
    expect(co.missing).toEqual([]);
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

describe('the official SDKs', () => {
  it('are reported from the catalogue, next to the account', async () => {
    const status = await getSetupStatus(config, {}, fakeCaller(HEALTHY));
    assertValidOutput(setupTool, status);
    const expected = sdkReport(snapshotSdkCatalog());
    expect(status.sdks).toEqual(expected.sdks);
    expect(status.sdk_guidance).toEqual(expected.sdk_guidance);
  });

  it('are reported even when the credential cannot be read', async () => {
    const failing = new Map<string, unknown>([['getMyIdentity', new Error('boom')]]);
    const status = await getSetupStatus(config, {}, fakeCaller({}, failing));
    assertValidOutput(setupTool, status);
    expect(status.account.error).toContain('boom');
    expect(status.sdks.length).toBeGreaterThan(0);
  });

  it('come from the catalogue it is given', async () => {
    const catalog = structuredClone(snapshotSdkCatalog());
    catalog.directive = 'Use the SDK.';
    catalog.sdks = catalog.sdks.slice(0, 1);
    const status = await getSetupStatus(config, {}, fakeCaller(HEALTHY), async () => catalog);
    expect(status.sdk_guidance.directive).toBe('Use the SDK.');
    expect(status.sdks.map((sdk) => sdk.id)).toEqual([catalog.sdks[0]!.id]);
  });
});

describe('readiness is worded from the environment', () => {
  it('says test (TEST) in a test session, and never Live', async () => {
    const status = await getSetupStatus(config, {}, fakeCaller(HEALTHY));
    expect(status.companies[0]!.next_action).toBe(
      'This company can issue in test (TEST). Create a first invoice with beel_create_invoice.',
    );
    expect(status.next_action).toMatch(/^Every company can issue in test \(TEST\)\./);
    expect(JSON.stringify(status)).not.toMatch(/issue Live/);
  });

  it('asks for confirmation in a live session, where every invoice is a real fiscal document', async () => {
    const status = await getSetupStatus({ ...config, env: 'live' }, {}, fakeCaller(HEALTHY));
    expect(status.environment).toBe('live');
    expect(status.companies[0]!.next_action).toMatch(
      /can issue in live \(PROD\)\. Every invoice there is a real fiscal document: confirm with the user/,
    );
  });
});

describe('a payment connection is not needed to issue', () => {
  it('stays out of missing and next_action, and is still reported', async () => {
    const caller = fakeCaller({ ...HEALTHY, listCompanyPaymentConnections: { connections: [] } });
    const status = await getSetupStatus(config, {}, caller);
    assertValidOutput(setupTool, status);
    const co = status.companies[0]!;
    expect(co.payment_connection).toEqual({ count: 0, active: false });
    expect(co.missing).toEqual([]);
    expect(co.next_action).not.toMatch(/payment/i);
    expect(status.next_action).not.toMatch(/payment/i);
  });
});

describe('the tax defaults are described as the contract applies them', () => {
  it('says the main tax is only a prefill and the IRPF default does apply (TAX-010)', () => {
    const description = companySchemaProperties().tax_defaults!.description!;
    expect(description).toMatch(/default_main_tax is a prefill the API never applies/);
    expect(description).toMatch(/A line without irpf_rate takes default_irpf_rate \(TAX-010\)/);
  });
});
