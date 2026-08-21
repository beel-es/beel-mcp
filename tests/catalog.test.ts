import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { catalogCodes, ERROR_CATALOG, lookupError } from '../src/guardrails/catalog.js';
import { GUARDRAILS } from '../src/guardrails/rules.js';
import { buildApiTools } from '../src/tools/api-tools.js';
import { CHECKED_OPERATIONS, findViolations } from '../src/guardrails/validate.js';

const spec = readFileSync('openapi/public-api.yaml', 'utf8');

describe('the error catalogue stays anchored to the contract', () => {
  it('every catalogued code is still emitted by the API', () => {
    // The catalogue is hand-transcribed, so this is what keeps it honest: a code
    // the API stops emitting must fail here, not quietly become advice about
    // something that can no longer happen.
    const stale = catalogCodes().filter((code) => !spec.includes(code));
    expect(stale).toEqual([]);
  });

  it('every catalogued code names a guardrail that exists', () => {
    const ids = new Set(GUARDRAILS.map((g) => g.id));
    const dangling = Object.entries(ERROR_CATALOG)
      .filter(([, entry]) => entry.guardrail && !ids.has(entry.guardrail))
      .map(([code, entry]) => `${code} → ${entry.guardrail}`);
    expect(dangling).toEqual([]);
  });

  it('every entry earns its place: a tool-call remedy or non-obvious retry advice', () => {
    // The catalogue exists to add what the API response cannot carry. An entry
    // with neither is duplication of a message the API already sends better.
    const freeloaders = Object.entries(ERROR_CATALOG)
      .filter(([, e]) => !e.remedy && e.actor === 'request')
      .filter(([, e]) => !e.guardrail)
      .map(([code]) => code);
    expect(freeloaders).toEqual([]);
  });

  it('covers every blocker EMISSION_NOT_READY can nest', () => {
    // These arrive as bare strings inside error.details.blockers[], with no
    // message and no link of their own — the strongest case for an entry.
    for (const blocker of [
      'COMPANY_NOT_ACTIVATED',
      'ENV_MISMATCH',
      'NIF_NOT_REGISTERED',
      'NIF_REPRESENTATION_REQUIRED',
    ]) {
      expect(lookupError(blocker), `${blocker} is not catalogued`).toBeDefined();
    }
  });

  it('a code labelled `api` really is one, and a `local` one really is not', () => {
    // The origin label is a claim made to the model about where a code comes
    // from. If it were wrong, an agent would search the docs for something that
    // does not exist, or dismiss a real code as invented.
    const PROBES: Array<[string, unknown]> = [
      ['createCompanyInvoice', { type: 'CORRECTIVE', lines: [{ quantity: 1, unit_price: 1, total_excluding_tax: 1, irpf_rate: 1, line_type: 'SUPLIDO', exemption_reason: 'EXENTA_ART_21', exemption_reason_text: 'x', equivalence_surcharge_rate: 5, main_tax: { regime_key: '01' } }] }],
      ['createCompanySeries', { format: '{CODIGO}-{NUM:6}' }],
      ['createCompany', { numbering: { code: 'F' }, activate: false }],
    ];
    const seen = PROBES.flatMap(([op, body]) => findViolations(op, body));
    expect(seen.length).toBeGreaterThan(5);

    const misLabelledApi = seen.filter((v) => v.origin === 'api' && !spec.includes(v.code));
    expect(misLabelledApi.map((v) => v.code)).toEqual([]);

    const misLabelledLocal = seen.filter((v) => v.origin === 'local' && spec.includes(v.code));
    expect(misLabelledLocal.map((v) => v.code)).toEqual([]);
  });

  it('every enforced API code is also catalogued, so both paths agree', () => {
    // A code the pre-flight can raise should be explicable when the API raises
    // it too — otherwise the same problem reads differently depending on who
    // caught it.
    const enforced = ['LINE_UNIT_PRICE_XOR_DECLARED_TOTAL', 'SIMPLIFICADA_FORBIDS_IRPF',
      'SURCHARGE_REQUIRES_REGIME', 'SERIES_ANNUAL_REQUIRES_YEAR', 'NUMBERING_REQUIRES_ACTIVATION'];
    const uncatalogued = enforced.filter((c) => !catalogCodes().includes(c));
    expect(uncatalogued).toEqual([]);
  });

  it('every checked operation is reachable as a tool', () => {
    const known = new Set(buildApiTools().tools.map((t) => t.operation.operationId));
    expect(Object.keys(CHECKED_OPERATIONS).filter((id) => !known.has(id))).toEqual([]);
  });
});
