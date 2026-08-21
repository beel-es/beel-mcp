import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { catalogCodes, ERROR_CATALOG, lookupError } from '../src/guardrails/catalog.js';
import { GUARDRAILS } from '../src/guardrails/rules.js';

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

  it('every entry carries a remedy that says what to do', () => {
    // An entry whose remedy only restates the meaning is maintenance cost with
    // no benefit — the API message already said that much.
    const useless = Object.entries(ERROR_CATALOG)
      .filter(([, e]) => e.remedy.trim().length < 20 || e.remedy === e.meaning)
      .map(([code]) => code);
    expect(useless).toEqual([]);
  });

  it('covers every blocker EMISSION_NOT_READY can nest', () => {
    // These arrive as bare strings inside error.details.blockers[]; an
    // uncatalogued one would surface to the agent with no remedy at all.
    for (const blocker of [
      'COMPANY_NOT_ACTIVATED',
      'ENV_MISMATCH',
      'NIF_NOT_REGISTERED',
      'NIF_REPRESENTATION_REQUIRED',
    ]) {
      expect(lookupError(blocker), `${blocker} is not catalogued`).toBeDefined();
    }
  });
});
