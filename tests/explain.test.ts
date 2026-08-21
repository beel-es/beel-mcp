import { describe, expect, it } from 'vitest';
import { explainCode, explainError } from '../src/guardrails/explain.js';

describe('explaining API errors', () => {
  it('adds meaning and remedy to a catalogued code', () => {
    const text = explainError({ status: 422, message: 'Not ready', code: 'ENV_MISMATCH' });
    expect(text).toContain('ENV_MISMATCH');
    expect(text).toContain('What this means:');
    expect(text).toContain('What to do:');
    expect(text).toContain('Retrying this call unchanged will not help.');
  });

  it('expands the nested blockers of EMISSION_NOT_READY, each with its own fix', () => {
    // The whole point: the container code says nothing, the blockers say everything.
    const text = explainError({
      status: 422,
      message: 'Company not ready to issue',
      code: 'EMISSION_NOT_READY',
      details: { blockers: ['NIF_NOT_REGISTERED', 'NIF_REPRESENTATION_REQUIRED'] },
    });
    expect(text).toContain('NIF_NOT_REGISTERED');
    expect(text).toContain('beel_generate_company_representation');
    expect(text.match(/Fix:/g)?.length).toBe(2);
  });

  it('flags a benign code as not necessarily a failure', () => {
    const text = explainError({ status: 409, message: 'Already voided', code: 'INVOICE_ALREADY_VOIDED' });
    expect(text).toMatch(/not necessarily a failure/);
  });

  it('surfaces the detail fields the catalogue asks for', () => {
    const text = explainError({
      status: 403,
      message: 'Forbidden',
      code: 'INSUFFICIENT_SCOPE',
      details: { missing_scopes: ['invoices:write'] },
    });
    expect(text).toContain('missing_scopes');
    expect(text).toContain('invoices:write');
  });

  it('links the guardrail that explains the underlying rule', () => {
    const text = explainError({ status: 400, message: 'Bad transition', code: 'TRANSITION_NOT_SUPPORTED' });
    expect(text).toContain('beel://guardrails/invoice-state-machine');
  });

  it('degrades to the API message for an unknown code, losing nothing', () => {
    const text = explainError({
      status: 500,
      message: 'Boom',
      code: 'SOMETHING_NEW',
      details: { hint: 'x' },
      requestId: 'abc123',
    });
    expect(text).toContain('Boom');
    expect(text).toContain('SOMETHING_NEW');
    expect(text).toContain('"hint":"x"');
    expect(text).toContain('abc123');
    expect(text).not.toContain('What this means:');
  });

  it('handles an error with no code at all', () => {
    expect(explainError({ status: 500, message: 'Gateway exploded' })).toContain('Gateway exploded');
  });

  it('explainCode returns the remedy, or a usable fallback', () => {
    expect(explainCode('NIF_NOT_REGISTERED')).toMatch(/VeriFactu registration/);
    expect(explainCode('UNKNOWN_BLOCKER')).toBe('Resolve UNKNOWN_BLOCKER.');
  });
});
