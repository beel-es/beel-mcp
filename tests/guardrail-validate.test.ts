import { describe, expect, it } from 'vitest';
import { assertNoViolations, findViolations, GuardrailError } from '../src/guardrails/validate.js';

const line = (over: Record<string, unknown> = {}) => ({ quantity: 1, unit_price: 100, ...over });
const codes = (body: unknown) => findViolations(body).map((v) => v.code);

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
    const violations = findViolations({ type: 'CORRECTIVE', lines: [line()] });
    expect(violations.map((v) => v.code)).toContain('CORRECTIVE_IS_A_SEPARATE_OPERATION');
    expect(violations[0]?.fix).toMatch(/corrective_invoice/);
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
    expect(findViolations(body).length).toBeGreaterThanOrEqual(3);
  });

  it('ignores bodies it does not understand instead of guessing', () => {
    expect(codes(undefined)).toEqual([]);
    expect(codes('a string')).toEqual([]);
    expect(codes({ lines: 'not an array' })).toEqual([]);
  });

  it('throws a GuardrailError naming the API error code, and honours the escape hatch', () => {
    const bad = { lines: [line({ total_excluding_tax: 100 })] };
    expect(() => assertNoViolations(bad, {})).toThrow(GuardrailError);
    expect(() => assertNoViolations(bad, {})).toThrow(/LINE_UNIT_PRICE_XOR_DECLARED_TOTAL/);
    expect(() => assertNoViolations(bad, { BEEL_DISABLE_PREFLIGHT: '1' })).not.toThrow();
  });
});
