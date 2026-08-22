import { describe, expect, it } from 'vitest';
import { explainCode, explainError } from '../src/guardrails/explain.js';

describe('explaining API errors', () => {
  it("leads with the API's own message and links its documentation page", () => {
    // The message and the doc page are the API's job and it does it well, in the
    // caller's language and across ~357 codes. This layer must not paraphrase them.
    const text = explainError({ status: 422, message: 'Environments do not match', code: 'ENV_MISMATCH' });
    expect(text).toContain('Environments do not match');
    expect(text).toContain('docs.beel.es/errors/ENV_MISMATCH');
    expect(text).toContain('What to do:');
    expect(text).toContain('Retrying this call unchanged will not help.');
  });

  it('prefers the RFC 7807 type URI the API sent over one built locally', () => {
    const text = explainError({
      status: 422, message: 'x', code: 'ENV_MISMATCH',
      docsUrl: 'https://docs.example.test/errors/ENV_MISMATCH',
    });
    expect(text).toContain('https://docs.example.test/errors/ENV_MISMATCH');
  });

  it('never drops error.details, which carry the specifics the agent needs', () => {
    // The API puts diagnostic pointers in details — defaults_status_endpoint here.
    // A curated allow-list would drop exactly the field the agent needs, so the
    // whole object is passed through.
    const text = explainError({
      status: 422,
      message: 'You have no default invoice series.',
      code: 'SERIES_DEFAULT_NOT_FOUND',
      details: {
        expected_document_type: 'FACTURA_RECTIFICATIVA',
        defaults_status_endpoint: 'GET /v1/companies/x/series/defaults',
      },
    });
    expect(text).toContain('defaults_status_endpoint');
    expect(text).toContain('FACTURA_RECTIFICATIVA');
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
    // Each bare blocker also gets its own documentation page.
    expect(text).toContain('errors/NIF_NOT_REGISTERED');
  });

  it('flags a benign code as not necessarily a failure', () => {
    const text = explainError({ status: 409, message: 'Already voided', code: 'INVOICE_ALREADY_VOIDED' });
    expect(text).toMatch(/not necessarily a failure/);
  });

  it('surfaces detail fields verbatim', () => {
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

  it('degrades to the API message and a constructed doc link for an unknown code', () => {
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
    expect(text).toContain('errors/SOMETHING_NEW');
    expect(text).not.toContain('What to do:');
  });

  it('handles an error with no code at all', () => {
    expect(explainError({ status: 500, message: 'Gateway exploded' })).toContain('Gateway exploded');
  });

  it('explainCode returns the remedy, or a usable fallback', () => {
    expect(explainCode('NIF_NOT_REGISTERED')).toMatch(/beel_get_company_veri_factu_configuration/);
    expect(explainCode('UNKNOWN_BLOCKER')).toContain('errors/UNKNOWN_BLOCKER');
  });
});
