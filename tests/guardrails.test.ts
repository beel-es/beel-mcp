import { describe, expect, it } from 'vitest';
import { loadSpec } from '../src/spec/load.js';
import { buildManifest, type OperationSpec } from '../src/spec/manifest.js';
import { describeTool, guardrailsForOperation } from '../src/guardrails/enrich.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readGuardrailResource } from '../src/resources/guardrails.js';
import { GUARDRAILS, guardrailUri } from '../src/guardrails/rules.js';
import { splitChunks, searchChunks, renderChunks } from '../src/docs/search.js';

const RULES_DIR = 'src/guardrails/rules';

const manifest = buildManifest(loadSpec());
const byId = (id: string): OperationSpec => manifest.find((o) => o.operationId === id)!;

describe('guardrail enrichment', () => {
  it('attaches invoice-type and regime-key guardrails to createCompanyInvoice', () => {
    const ids = guardrailsForOperation(byId('createCompanyInvoice'));
    expect(ids).toContain('invoice-types');
    expect(ids).toContain('regime-keys');
  });

  it('attaches cancel-vs-rectify to void and corrective', () => {
    expect(guardrailsForOperation(byId('voidCompanyInvoice'))).toContain('cancel-vs-rectify');
    expect(guardrailsForOperation(byId('createCompanyCorrectiveInvoice'))).toContain('cancel-vs-rectify');
  });

  it('injects a guardrails footer and the endpoint into the description', () => {
    const desc = describeTool(byId('createCompanyInvoice'));
    expect(desc).toContain('Fiscal guardrails');
    expect(desc).toContain('POST /v1/companies/{company_id}/invoices');
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

describe('guardrail prose points at things that exist', () => {
  it('does not cite bare operationIds, which are not callable by name', () => {
    const operations = new Set(buildManifest(loadSpec()).map((op) => op.operationId));
    const bare: string[] = [];
    for (const file of readdirSync(RULES_DIR)) {
      const text = readFileSync(join(RULES_DIR, file), 'utf8');
      for (const match of text.matchAll(/`([a-z][a-zA-Z0-9]{5,})`/g)) {
        if (operations.has(match[1]!)) bare.push(`${file}: ${match[1]}`);
      }
    }
    expect(bare).toEqual([]);
  });

  it('every guardrail carries complete front matter', () => {
    for (const g of GUARDRAILS) {
      expect(g.title.length, g.id).toBeGreaterThan(5);
      expect(g.summary.length, g.id).toBeGreaterThan(20);
      expect(g.docPath.startsWith('/'), g.id).toBe(true);
      expect(g.body.length, g.id).toBeGreaterThan(200);
      expect(g.body.startsWith('---'), `${g.id} still contains its front matter`).toBe(false);
    }
  });
});

describe('docs search ranking', () => {
  const chunk = (page: string, heading: string, content: string) => ({ page, heading, content });

  it('does not let one enormous section win every query', () => {
    // The corpus holds a 54 KB reference table that mentions nearly every term.
    // Under raw term frequency it outranks the section that actually answers.
    const giant = chunk('All error codes', 'Full table', `${'SIMPLIFICADA lorem ipsum '.repeat(2000)}`);
    const answer = chunk('Invoice types', 'F2 — Factura simplificada', 'A simplificada is capped at 3000 EUR including VAT.'.repeat(6));
    const [top] = searchChunks([giant, answer], ['simplificada'], 1);
    expect(top?.heading).toBe('F2 — Factura simplificada');
  });

  it('does not let a near-empty heading stub win either', () => {
    // The opposite failure: normalise too eagerly and a 40-character cross
    // reference outranks the section that actually explains the thing.
    const stub = chunk('Series API Reference', 'Series', 'See also.');
    const answer = chunk('Glossary', 'Invoice Series Terms', 'A series numbers invoices. '.repeat(20));
    const [top] = searchChunks([stub, answer], ['series'], 1);
    expect(top?.page).toBe('Glossary');
  });

  it('prefers a chunk matching every term over one matching a single term often', () => {
    const partial = chunk('Taxes', 'IVA', 'recargo recargo recargo recargo recargo. '.repeat(20));
    const complete = chunk(
      'Taxes',
      'Surcharge',
      'The recargo de equivalencia applies per line and only under regime 18. '.repeat(8),
    );
    const [top] = searchChunks([partial, complete], ['recargo', 'equivalencia'], 1);
    expect(top?.heading).toBe('Surcharge');
  });

  it('truncates an oversized section and says so', () => {
    const rendered = renderChunks([chunk('Big', 'Table', 'x'.repeat(20_000))]);
    expect(rendered.length).toBeLessThan(9_000);
    expect(rendered).toMatch(/truncated/);
    expect(rendered).toMatch(/20000 characters/);
  });

  it('leaves a normal section intact', () => {
    const rendered = renderChunks([chunk('Page', 'Section', 'short body')]);
    expect(rendered).toBe('## Page › Section\n\nshort body');
  });
});
