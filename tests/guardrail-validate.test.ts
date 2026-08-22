import { describe, expect, it } from 'vitest';
import {
  assertNoViolations,
  CHECKED_OPERATIONS,
  findViolations,
  GuardrailError,
} from '../src/guardrails/validate.js';
import { buildApiTools } from '../src/tools/api-tools.js';

const INVOICE_OP = 'createCompanyInvoice';
const line = (over: Record<string, unknown> = {}) => ({ quantity: 1, unit_price: 100, ...over });
const codes = (body: unknown, op = INVOICE_OP) => findViolations(op, body).map((v) => v.code);

describe('executable guardrails — line pricing', () => {
  it('accepts a line with exactly one pricing field', () => {
    expect(codes({ type: 'STANDARD', lines: [line()] })).toEqual([]);
    expect(codes({ lines: [{ quantity: 1, total_including_tax: 121 }] })).toEqual([]);
  });

  it('rejects a line with two pricing fields', () => {
    expect(codes({ lines: [line({ total_excluding_tax: 100 })] })).toContain(
      'LINE_UNIT_PRICE_XOR_DECLARED_TOTAL',
    );
  });

  it('rejects a line with no pricing field', () => {
    expect(codes({ lines: [{ quantity: 1 }] })).toContain('LINE_UNIT_PRICE_XOR_DECLARED_TOTAL');
  });

  it('rejects a discount on a declared total but allows it on unit_price', () => {
    expect(codes({ lines: [{ quantity: 1, total_excluding_tax: 100, discount_percentage: 10 }] })).toContain(
      'LINE_DECLARED_TOTAL_FORBIDS_DISCOUNT',
    );
    expect(codes({ lines: [line({ discount_percentage: 10 })] })).toEqual([]);
  });
});

describe('executable guardrails — F2 and IRPF', () => {
  it('rejects a non-zero irpf_rate on a SIMPLIFIED invoice', () => {
    expect(codes({ type: 'SIMPLIFIED', lines: [line({ irpf_rate: 15 })] })).toContain(
      'SIMPLIFICADA_FORBIDS_IRPF',
    );
  });

  it('allows irpf_rate 0 on SIMPLIFIED, and any rate on STANDARD', () => {
    expect(codes({ type: 'SIMPLIFIED', lines: [line({ irpf_rate: 0 })] })).toEqual([]);
    expect(codes({ type: 'STANDARD', lines: [line({ irpf_rate: 15 })] })).toEqual([]);
  });

  it('does not flag an omitted irpf_rate, which inherits the account default', () => {
    expect(codes({ type: 'SIMPLIFIED', lines: [line()] })).toEqual([]);
  });
});

describe('executable guardrails — equivalence surcharge and regime', () => {
  it('rejects a surcharge under a regime that does not admit one', () => {
    const body = {
      lines: [line({ equivalence_surcharge_rate: 5.2, main_tax: { type: 'IVA', percentage: 21, regime_key: '01' } })],
    };
    expect(codes(body)).toContain('SURCHARGE_REQUIRES_REGIME');
  });

  it('rejects regime 18 without a surcharge', () => {
    const body = { lines: [line({ main_tax: { type: 'IVA', percentage: 21, regime_key: '18' } })] };
    expect(codes(body)).toContain('REGIME_REQUIRES_SURCHARGE');
  });

  it('accepts the coherent pair, and stays silent when regime_key is omitted', () => {
    const paired = {
      lines: [line({ equivalence_surcharge_rate: 5.2, main_tax: { type: 'IVA', percentage: 21, regime_key: '18' } })],
    };
    expect(codes(paired)).toEqual([]);
    // Omitted regime_key is derived by BeeL from the surcharge — never our call.
    const derived = { lines: [line({ equivalence_surcharge_rate: 5.2, main_tax: { type: 'IVA', percentage: 21 } })] };
    expect(codes(derived)).toEqual([]);
  });
});

describe('executable guardrails — invoice level', () => {
  it('redirects CORRECTIVE to its own operation', () => {
    const violations = findViolations(INVOICE_OP, { type: 'CORRECTIVE', lines: [line()] });
    expect(violations.map((v) => v.code)).toContain('CORRECTIVE_IS_A_SEPARATE_OPERATION');
    expect(violations[0]?.fix).toMatch(/corrective_invoice/);
    expect(violations[0]?.origin).toBe('local');
  });

  it('requires a source reference on SUPLIDO lines', () => {
    expect(codes({ lines: [line({ line_type: 'SUPLIDO' })] })).toContain(
      'SUPLIDO_REQUIRES_SOURCE_REFERENCE',
    );
    expect(codes({ lines: [line({ line_type: 'SUPLIDO', source_invoice_reference: 'A/2025/1' })] })).toEqual([]);
  });

  it('only allows exemption_reason_text under OTRO', () => {
    expect(codes({ lines: [line({ exemption_reason: 'EXENTA_ART_21', exemption_reason_text: 'x' })] })).toContain(
      'EXEMPTION_TEXT_REQUIRES_OTRO',
    );
    expect(codes({ lines: [line({ exemption_reason: 'OTRO', exemption_reason_text: 'x' })] })).toEqual([]);
  });
});

describe('executable guardrails — reporting and escape hatch', () => {
  it('reports every violation at once, not just the first', () => {
    const body = {
      type: 'SIMPLIFIED',
      lines: [line({ total_excluding_tax: 100, discount_percentage: 10, irpf_rate: 15 })],
    };
    expect(findViolations(INVOICE_OP, body).length).toBeGreaterThanOrEqual(3);
  });

  it('ignores bodies it does not understand instead of guessing', () => {
    expect(codes(undefined)).toEqual([]);
    expect(codes('a string')).toEqual([]);
    expect(codes({ lines: 'not an array' })).toEqual([]);
  });

  it('throws a GuardrailError naming the API error code, and honours the escape hatch', () => {
    const bad = { lines: [line({ total_excluding_tax: 100 })] };
    expect(() => assertNoViolations(INVOICE_OP, bad, {})).toThrow(GuardrailError);
    expect(() => assertNoViolations(INVOICE_OP, bad, {})).toThrow(/LINE_UNIT_PRICE_XOR_DECLARED_TOTAL/);
    expect(() => assertNoViolations(INVOICE_OP, bad, { BEEL_DISABLE_PREFLIGHT: '1' })).not.toThrow();
  });
});

describe('executable guardrails — series numbering', () => {
  const SERIES_OP = 'createCompanySeries';

  it('requires a year token when the counter resets annually', () => {
    expect(codes({ format: '{CODIGO}-{NUM:6}', counter_reset: 'ANNUAL' }, SERIES_OP)).toContain(
      'SERIES_ANNUAL_REQUIRES_YEAR',
    );
  });

  it('applies the ANNUAL default when counter_reset is omitted', () => {
    // The trap: silence means ANNUAL, so a year-less format is still invalid.
    const issues = findViolations(SERIES_OP, { format: '{CODIGO}-{NUM:6}' });
    expect(issues.map((v) => v.code)).toContain('SERIES_ANNUAL_REQUIRES_YEAR');
    expect(issues[0]?.message).toMatch(/default when omitted/);
  });

  it('accepts a year-less format when the counter never resets', () => {
    expect(codes({ format: '{CODIGO}-{NUM:6}', counter_reset: 'NEVER' }, SERIES_OP)).toEqual([]);
  });

  it('requires month and year when the counter resets monthly', () => {
    expect(codes({ format: '{CODIGO}-{YYYY}-{NUM:4}', counter_reset: 'MONTHLY' }, SERIES_OP)).toContain(
      'SERIES_MONTHLY_REQUIRES_MONTH_AND_YEAR',
    );
    expect(codes({ format: '{YYYY}{MM}-{NUM:3}', counter_reset: 'MONTHLY' }, SERIES_OP)).toEqual([]);
  });

  it('says nothing when the format is omitted and the default applies', () => {
    expect(codes({ name: 'Facturas', code: 'FAC' }, SERIES_OP)).toEqual([]);
  });
});

describe('executable guardrails — company numbering', () => {
  it('rejects a numbering block that would be discarded', () => {
    expect(codes({ numbering: { code: 'F' }, activate: false }, 'createCompany')).toContain(
      'NUMBERING_REQUIRES_ACTIVATION',
    );
  });

  it('validates the nested simplified and corrective series too', () => {
    const body = { numbering: { corrective: { format: '{CODIGO}-{NUM:4}' } }, activate: true };
    expect(codes(body, 'createCompany')).toContain('SERIES_ANNUAL_REQUIRES_YEAR');
  });
});

describe('executable guardrails — dispatch', () => {
  it('only runs checks for the operation the body is bound for', () => {
    // A series format on an invoice payload must not trigger the series rule.
    expect(codes({ format: '{CODIGO}-{NUM:6}' }, INVOICE_OP)).toEqual([]);
    expect(codes({ lines: [line({ total_excluding_tax: 100 })] }, 'listCompanyInvoices')).toEqual([]);
  });

  it('every checked operationId is still a real tool', () => {
    // Hand-curated ids stop matching silently when the API renames operations,
    // which would disable a fiscal check with no trace. Fail here instead.
    const known = new Set(buildApiTools().tools.map((t) => t.operation.operationId));
    const stale = Object.keys(CHECKED_OPERATIONS).filter((id) => !known.has(id));
    expect(stale).toEqual([]);
  });
});

describe('every violation carries a usable fix', () => {
  // A pre-flight rejection has no API message behind it: this text is everything
  // the agent gets. It must always name a concrete change, never restate the code.
  const PAYLOADS: Array<[string, unknown]> = [
    ['createCompanyInvoice', { type: 'SIMPLIFIED', lines: [{ quantity: 1, unit_price: 10, total_excluding_tax: 10, discount_percentage: 5, irpf_rate: 15 }] }],
    ['createCompanyInvoice', { lines: [{ quantity: 1, unit_price: 10, equivalence_surcharge_rate: 5.2, main_tax: { regime_key: '01' } }] }],
    ['createCompanyInvoice', { lines: [{ quantity: 1, unit_price: 10, main_tax: { regime_key: '18' } }] }],
    ['createCompanyInvoice', { lines: [{ quantity: 1, unit_price: 10, line_type: 'SUPLIDO' }] }],
    ['createCompanyInvoice', { lines: [{ quantity: 1, unit_price: 10, exemption_reason: 'EXENTA_ART_21', exemption_reason_text: 'x' }] }],
    ['createCompanyInvoice', { type: 'CORRECTIVE', lines: [{ quantity: 1, unit_price: 1 }] }],
    ['createCompanySeries', { format: '{CODIGO}-{NUM:6}' }],
    ['createCompanySeries', { format: '{CODIGO}-{YYYY}-{NUM:4}', counter_reset: 'MONTHLY' }],
    ['createCompany', { numbering: { code: 'F' }, activate: false }],
  ];

  it('produces a specific fix for every rule, never a placeholder', () => {
    const all = PAYLOADS.flatMap(([op, body]) => findViolations(op, body));
    expect(all.length).toBeGreaterThanOrEqual(10);
    const weak = all.filter((v) => /^Resolve /.test(v.fix) || v.fix.length < 25);
    expect(weak.map((v) => v.code)).toEqual([]);
  });

  it('states the offending value in the message, not just the rule', () => {
    // "irpf_rate is 15" beats "irpf_rate is not allowed": the agent can see what
    // it sent without re-reading its own payload.
    const [, body] = PAYLOADS[0]!;
    const irpf = findViolations('createCompanyInvoice', body).find((v) => v.code === 'SIMPLIFICADA_FORBIDS_IRPF');
    expect(irpf?.message).toContain('15');
  });

  it('labels each violation as an API code or a locally checked rule', () => {
    const all = PAYLOADS.flatMap(([op, body]) => findViolations(op, body));
    expect(all.every((v) => v.origin === 'api' || v.origin === 'local')).toBe(true);
    // Locally-checked codes are ours; they must not masquerade as API codes.
    const local = new Set(all.filter((v) => v.origin === 'local').map((v) => v.code));
    expect([...local].sort()).toEqual([
      'CORRECTIVE_IS_A_SEPARATE_OPERATION',
      'EXEMPTION_TEXT_REQUIRES_OTRO',
      'SUPLIDO_REQUIRES_SOURCE_REFERENCE',
    ]);
  });
});
