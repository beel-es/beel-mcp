import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSpec } from '../src/spec/load.js';
import { buildManifest, type OperationSpec } from '../src/spec/manifest.js';
import {
  BY_OPERATION_ID,
  BY_TAG,
  describeTool,
  guardrailsForOperation,
} from '../src/guardrails/enrich.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEGACY_ALIASES,
  listGuardrailResources,
  readGuardrailResource,
} from '../src/resources/guardrails.js';
import { GUARDRAILS, guardrailUri } from '../src/guardrails/rules.js';
import { clearRulesCache, snapshotCatalog } from '../src/rules/fetch.js';
import { splitChunks, searchChunks, renderChunks } from '../src/docs/search.js';

const RULES_DIR = 'src/guardrails/rules';

const manifest = buildManifest(loadSpec());
const byId = (id: string): OperationSpec => manifest.find((o) => o.operationId === id)!;
const domains = snapshotCatalog().domains;

// The resources read the rules catalogue; keep these tests off the network and
// on the bundled snapshot.
beforeEach(() => {
  clearRulesCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('guardrail enrichment', () => {
  it('points createCompanyInvoice at the simplified and tax rules and the line guide', () => {
    const ids = guardrailsForOperation(byId('createCompanyInvoice'));
    expect(ids).toContain('simplified');
    expect(ids).toContain('taxes');
    expect(ids).toContain('invoice-lines');
  });

  it('points void and corrective at the void and corrective rules', () => {
    expect(guardrailsForOperation(byId('voidCompanyInvoice'))).toContain('void');
    expect(guardrailsForOperation(byId('createCompanyCorrectiveInvoice'))).toContain('corrective');
  });

  it('every mapped id is an API guide or a domain of the rules catalogue', () => {
    const known = new Set([...GUARDRAILS.map((g) => g.id), ...domains.map((d) => d.slug)]);
    const dangling = [...Object.values(BY_OPERATION_ID), ...Object.values(BY_TAG)]
      .flat()
      .filter((id) => !known.has(id));
    expect(dangling).toEqual([]);
  });

  it('injects the rule domains, the guides and the endpoint into the description', () => {
    const desc = describeTool(byId('createCompanyInvoice'));
    expect(desc).toContain('POST /v1/companies/{company_id}/invoices');
    expect(desc).toContain('beel_rules_list');
    expect(desc).toMatch(/domains simplified, contents, taxes, surcharge/);
    expect(desc).toContain(guardrailUri('invoice-lines'));
  });

  it('copies no rule text into a tool description', () => {
    // Rule wording lives in the catalogue only; a description that quoted it
    // would be a second copy, and the first to go stale.
    const statements = snapshotCatalog().rules.map((r) => r.statement);
    for (const op of manifest) {
      const desc = describeTool(op);
      expect(statements.filter((s) => desc.includes(s))).toEqual([]);
    }
  });
});

describe('guardrail resources', () => {
  it('guide ids, rule domains and the errors resource never share a URI', () => {
    const ids = [...GUARDRAILS.map((g) => g.id), ...domains.map((d) => d.slug), 'errors'];
    expect(new Set(ids).size).toBe(ids.length);
    for (const legacy of Object.keys(LEGACY_ALIASES)) expect(ids).not.toContain(legacy);
  });

  it('lists the index, one resource per rule domain, every guide and the errors', async () => {
    const uris = (await listGuardrailResources()).map((r) => r.uri);
    expect(uris[0]).toBe('beel://guardrails');
    for (const d of domains) expect(uris).toContain(guardrailUri(d.slug));
    for (const g of GUARDRAILS) expect(uris).toContain(guardrailUri(g.id));
    expect(uris).toContain('beel://guardrails/errors');
  });

  it('resolves every guide URI to markdown', async () => {
    for (const g of GUARDRAILS) {
      const body = await readGuardrailResource(guardrailUri(g.id));
      expect(body).toContain(g.title);
    }
  });

  it('serves every rule domain from the catalogue, each rule with its id and link', async () => {
    const { rules } = snapshotCatalog();
    for (const d of domains) {
      const body = (await readGuardrailResource(guardrailUri(d.slug)))!;
      expect(body).toContain(`# ${d.title}`);
      for (const rule of rules.filter((r) => r.domain === d.slug)) {
        expect(body).toContain(rule.id);
        expect(body).toContain(rule.url);
      }
      // A domain is read whole; keep it well inside a context window.
      expect(body.length).toBeLessThan(40_000);
    }
  });

  it('groups the index by domain and links the guides', async () => {
    const body = (await readGuardrailResource('beel://guardrails'))!;
    for (const d of domains) expect(body).toContain(guardrailUri(d.slug));
    for (const g of GUARDRAILS) expect(body).toContain(guardrailUri(g.id));
  });

  it('keeps the URIs of guides that became rule domains readable', async () => {
    for (const [legacy, slugs] of Object.entries(LEGACY_ALIASES)) {
      const body = (await readGuardrailResource(guardrailUri(legacy)))!;
      for (const slug of slugs) expect(body).toContain(guardrailUri(slug));
    }
  });

  it('returns null for unknown URIs', async () => {
    expect(await readGuardrailResource('beel://guardrails/does-not-exist')).toBeNull();
    expect(await readGuardrailResource('beel://elsewhere')).toBeNull();
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
    const giant = chunk(
      'All error codes',
      'Full table',
      `${'SIMPLIFICADA lorem ipsum '.repeat(2000)}`,
    );
    const answer = chunk(
      'Invoice types',
      'F2 — Factura simplificada',
      'A simplificada is capped at 3000 EUR including VAT.'.repeat(6),
    );
    const [top] = searchChunks([giant, answer], ['simplificada'], 1);
    expect(top?.heading).toBe('F2 — Factura simplificada');
  });

  it('does not let a near-empty heading stub win either', () => {
    // The opposite failure: normalise too eagerly and a 40-character cross
    // reference outranks the section that actually explains the thing.
    const stub = chunk('Series API Reference', 'Series', 'See also.');
    const answer = chunk(
      'Glossary',
      'Invoice Series Terms',
      'A series numbers invoices. '.repeat(20),
    );
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
