import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from '../src/config.js';
import { snapshotCatalog, clearRulesCache } from '../src/rules/fetch.js';
import { filterRules } from '../src/rules/render.js';
import { loadSpec } from '../src/spec/load.js';
import { RULES_GET, RULES_LIST, executeRulesTool } from '../src/tools/rules-tools.js';
import { jsonText } from '../src/tools/tool-result.js';
import { declareOperation, declareSchema, schemaNames } from '../src/spec/declarations.js';
import { buildApiTools } from '../src/tools/api-tools.js';
import { docsTools } from '../src/tools/docs-tools.js';
import { rulesTools } from '../src/tools/rules-tools.js';
import { schemaTools } from '../src/tools/schema-tools.js';
import { workflowTools } from '../src/tools/workflow-tools.js';
import { SCHEMA_GET, executeSchemaTool } from '../src/tools/schema-tools.js';
import { getSetupStatus, type OperationCaller } from '../src/tools/workflow-tools.js';
import { snapshotSdkCatalog } from '../src/sdks/fetch.js';
import { sdkReport } from '../src/sdks/report.js';

/**
 * Size budgets for the results an agent reads most while it builds.
 *
 * A tool result stays in the conversation and is read again on every later
 * turn, so a result that grows is paid for on every call after it. Each budget
 * is a ceiling with headroom over today's size, measured on the bundled rules
 * snapshot and the contract's own examples so that it is deterministic. A change
 * that breaks one should shrink the output, or raise the budget in review with
 * the reason.
 */

/** Longest concise rule the catalogue produces today is about 2,300 characters. */
const CONCISE_RULE_BUDGET = 3_000;
/** A concise list line: id, strength, a statement cut at 160 characters, enforced_by. */
const LIST_LINE_BUDGET = 220;
/** Header, truncation note and the closing hint of a list. */
const LIST_FRAME_BUDGET = 400;
/** One fully configured company in the setup report, as compact JSON. */
const SETUP_COMPANY_BUDGET = 1_500;
/**
 * The SDKs and the catalogue's two sentences, as compact JSON: about 1,300
 * characters for three SDKs today, each an id, a status, a few marker files, an
 * install command, links and, when not recommended, a one-sentence note.
 */
const SDK_REPORT_BUDGET = 2_000;
/** Compact JSON against indented JSON, on the contract's invoice example. */
const COMPACT_JSON_RATIO = 0.8;
/**
 * CreateInvoiceRequest with its inline line type: 27 fields, each a name, a type,
 * its first sentence and the sentences that say what is required or rejected
 * (at most MAX_FIELD_CONSTRAINT_CHARS); about 4,400 characters today. The SDK's
 * generated type for the same schema runs to about 14,600.
 */
const CREATE_INVOICE_BUDGET = 5_000;
/** The five schemas an invoice body is written from, read in one call: about 7,500 today. */
const INVOICE_BODY_BATCH_BUDGET = 9_000;
/**
 * The whole tools/list answer, which a client sends with every request: about
 * 448,000 characters today, from 582,000 before input-schema descriptions were
 * kept to their first paragraph and their rules. Most of what remains is the
 * contract's shared schemas, repeated in each tool that uses them.
 */
const TOOLS_LIST_BUDGET = 470_000;
/** Any one schema or operation of the contract; the largest today is about 4,400. */
const DECLARATION_BUDGET = 6_000;

const snapshot = snapshotCatalog();

beforeEach(() => {
  clearRulesCache();
  vi.stubGlobal('fetch', async () => {
    throw new Error('offline');
  });
});
afterEach(() => vi.unstubAllGlobals());

describe(`${RULES_GET} stays small in concise`, () => {
  it(`keeps every rule under ${CONCISE_RULE_BUDGET} characters`, async () => {
    const over: string[] = [];
    for (const rule of snapshot.rules) {
      const text = await executeRulesTool(RULES_GET, { id: rule.id });
      if (text.length > CONCISE_RULE_BUDGET) over.push(`${rule.id}: ${text.length}`);
    }
    expect(over).toEqual([]);
  });

  it('reads eight rules for well under half of what detailed costs', async () => {
    const ids = filterRules(snapshot, { enforced_by: 'integrator' })
      .slice(0, 8)
      .map((r) => r.id);
    const concise = await executeRulesTool(RULES_GET, { ids });
    const detailed = await executeRulesTool(RULES_GET, { ids, response_format: 'detailed' });
    expect(concise.length).toBeLessThan(8 * 600);
    expect(concise.length).toBeLessThan(detailed.length * 0.45);
  });
});

describe(`${RULES_LIST} grows by one short line per rule`, () => {
  const filters = [
    ...snapshot.domains.map((d) => ({ domain: d.slug })),
    ...['api', 'integrator', 'issuer'].map((enforced_by) => ({ enforced_by })),
    ...['MUST', 'MUST_NOT', 'SHOULD'].map((severity) => ({ severity })),
  ];

  it.each(filters)('with %o', async (filter) => {
    const matches = filterRules(snapshot, filter).length;
    const text = await executeRulesTool(RULES_LIST, filter);
    expect(text.length).toBeLessThan(matches * LIST_LINE_BUDGET + LIST_FRAME_BUDGET);
  });
});

describe('API results travel as compact JSON', () => {
  it(`are at most ${COMPACT_JSON_RATIO * 100}% of the indented form on a real invoice`, () => {
    const spec = loadSpec() as {
      components: { examples: Record<string, { value: { data: unknown } }> };
    };
    const invoice = spec.components.examples['get-invoice-success']!.value.data;
    const indented = JSON.stringify(invoice, null, 2);
    expect(jsonText(invoice).length).toBeLessThan(indented.length * COMPACT_JSON_RATIO);
  });
});

describe('beel_get_setup_status', () => {
  it(`reports a fully configured company in under ${SETUP_COMPANY_BUDGET} characters`, async () => {
    const config: ResolvedConfig = {
      apiKey: 'beel_sk_test_x',
      env: 'test',
      baseUrl: 'https://app.beel.es/api',
      transport: 'stdio',
    };
    const responses: Record<string, unknown> = {
      getMyIdentity: { account_id: '4d8f2c1a-0b9e-4f3a-8c7d-6e5f4a3b2c1d', name: 'Ada' },
      listCompanies: {
        companies: [
          {
            id: '9c8f1f2e-2b7a-4a1e-9d1f-3f5a8c2b7e10',
            nif: 'B12345678',
            legal_name: 'Example SL',
          },
        ],
      },
      getCompanyIssuingReadiness: { ready: true, blockers: [] },
      getCompanyDefaultSeries: {
        defaults: ['STANDARD', 'SIMPLIFIED', 'CORRECTIVE'].map((type, i) => ({
          document_type: type,
          exists: true,
          series_id: `a1b2c3d4-e5f6-7890-abcd-ef123456789${i}`,
          code: type[0],
        })),
      },
      getCompanyVeriFactuConfiguration: { enabled: true, status: 'ACTIVE' },
      getCompanyTaxConfiguration: {
        default_main_tax: { type: 'IVA', percentage: 21, regime_key: '01' },
        apply_irpf: false,
        irpf_exempt: false,
        apply_equivalence_surcharge: false,
        withholding_options: { allowed_irpf_rates: [0, 19, 24], suggested_irpf_rate: 0 },
      },
      listCompanyPaymentConnections: { connections: [{ status: 'ACTIVE' }] },
    };
    const caller: OperationCaller = async (operationId) => responses[operationId];
    const status = await getSetupStatus(config, {}, caller);
    // The SDKs have a budget of their own, below.
    const { sdks: _sdks, sdk_guidance: _guidance, ...account } = status;
    expect(jsonText(account).length).toBeLessThan(SETUP_COMPANY_BUDGET);
  });
});

describe(`${SCHEMA_GET} answers a field-level question in a few KB`, () => {
  it(`declares CreateInvoiceRequest and its line type in under ${CREATE_INVOICE_BUDGET}`, async () => {
    const text = await executeSchemaTool(SCHEMA_GET, { name: 'CreateInvoiceRequest' });
    expect(text).toContain('lines: Array<{');
    expect(text.length).toBeLessThan(CREATE_INVOICE_BUDGET);
  });

  it(`declares the five schemas of an invoice body in under ${INVOICE_BODY_BATCH_BUDGET}`, async () => {
    const names = [
      'CreateInvoiceRequest',
      'Recipient',
      'AlternativeIdentifier',
      'Address',
      'TaxInfo',
    ];
    const text = await executeSchemaTool(SCHEMA_GET, { names });
    for (const name of names) expect(text).toContain(`interface ${name} `);
    expect(text.length).toBeLessThan(INVOICE_BODY_BATCH_BUDGET);
  });

  it(`keeps every schema and operation of the contract under ${DECLARATION_BUDGET}`, () => {
    const doc = loadSpec();
    const over = [
      ...schemaNames(doc).map((name) => [name, declareSchema(doc, name)!.text] as const),
      ...buildApiTools().tools.map(
        (t) => [t.tool.name, declareOperation(doc, t.operation, t.tool.name).text] as const,
      ),
    ]
      .filter(([, text]) => text.length > DECLARATION_BUDGET)
      .map(([name, text]) => `${name}: ${text.length}`);
    expect(over).toEqual([]);
  });
});

describe('the official SDKs in the setup report', () => {
  it(`take under ${SDK_REPORT_BUDGET} characters`, () => {
    expect(jsonText(sdkReport(snapshotSdkCatalog())).length).toBeLessThan(SDK_REPORT_BUDGET);
  });
});

describe('tools/list', () => {
  it(`stays under ${TOOLS_LIST_BUDGET} characters`, () => {
    const tools = [
      ...buildApiTools().tools.map((t) => t.tool),
      ...docsTools,
      ...rulesTools,
      ...schemaTools,
      ...workflowTools,
    ];
    expect(JSON.stringify({ tools }).length).toBeLessThan(TOOLS_LIST_BUDGET);
  });
});
