import { describe, expect, it } from 'vitest';
import { loadSpec } from '../src/spec/load.js';
import { buildManifest, type OperationSpec } from '../src/spec/manifest.js';
import { describeTool, guardrailsForOperation } from '../src/guardrails/enrich.js';
import { readGuardrailResource } from '../src/resources/guardrails.js';
import { GUARDRAILS, guardrailUri } from '../src/guardrails/domain.js';
import { splitChunks, searchChunks } from '../src/docs/search.js';

const manifest = buildManifest(loadSpec());
const byId = (id: string): OperationSpec => manifest.find((o) => o.operationId === id)!;

describe('guardrail enrichment', () => {
  it('attaches invoice-type and regime-key guardrails to createInvoice', () => {
    const ids = guardrailsForOperation(byId('createInvoice'));
    expect(ids).toContain('invoice-types');
    expect(ids).toContain('regime-keys');
  });

  it('attaches cancel-vs-rectify to void and corrective', () => {
    expect(guardrailsForOperation(byId('voidInvoice'))).toContain('cancel-vs-rectify');
    expect(guardrailsForOperation(byId('createCorrectiveInvoice'))).toContain('cancel-vs-rectify');
  });

  it('injects a guardrails footer and the endpoint into the description', () => {
    const desc = describeTool(byId('createInvoice'));
    expect(desc).toContain('Fiscal guardrails');
    expect(desc).toContain('POST /v1/invoices');
    expect(desc).toContain(guardrailUri('invoice-types'));
  });
});

describe('guardrail resources', () => {
  it('resolves every guardrail URI to markdown', () => {
    for (const g of GUARDRAILS) {
      const body = readGuardrailResource(guardrailUri(g.id));
      expect(body).toBeTruthy();
      expect(body).toContain(g.title);
    }
  });

  it('resolves the overview resource', () => {
    expect(readGuardrailResource('beel://guardrails')).toContain('fiscal guardrails');
  });

  it('returns null for unknown URIs', () => {
    expect(readGuardrailResource('beel://guardrails/does-not-exist')).toBeNull();
  });
});

describe('docs search scoring', () => {
  const corpus = [
    '# Recargo de equivalencia',
    '## Accepted surcharge values',
    'The surcharge is 5.2%, 1.4% or 0.5% depending on the VAT rate.',
    '# Invoice types',
    '## F2 simplified',
    'Use F2 when the total is under 3000 EUR.',
  ].join('\n');

  it('ranks the matching section first', () => {
    const chunks = splitChunks(corpus);
    const results = searchChunks(chunks, ['surcharge', 'values'], 1);
    expect(results[0]?.page).toBe('Recargo de equivalencia');
  });
});
