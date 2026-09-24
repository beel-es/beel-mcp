import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatSnapshot, SNAPSHOT_PATH } from '../scripts/sync-rules.mjs';
import { parseRulesCatalog, RulesCatalogError, type RulesCatalog } from '../src/rules/catalog.js';
import { clearRulesCache, loadRules, rulesUrl, snapshotCatalog } from '../src/rules/fetch.js';
import {
  CONCISE_STATEMENT_CHARS,
  RulesQueryError,
  filterRules,
  renderRuleList,
} from '../src/rules/render.js';
import { RULES_GET, RULES_LIST, executeRulesTool, rulesTools } from '../src/tools/rules-tools.js';
import {
  MAX_RULES_PER_ERROR,
  explainErrorWithRules,
  rulesNoteForCode,
} from '../src/guardrails/explain.js';
import { CACHE_TTL_MS, RULES_SOURCE } from '../src/shared/defaults.js';

const snapshot = snapshotCatalog();

/** A catalogue served over the stubbed network, distinguishable from the snapshot. */
function liveCatalog(): RulesCatalog {
  const copy = structuredClone(snapshot);
  copy.rules[0]!.title = 'Served live';
  return copy;
}

function stubFetch(impl: (url: string) => Promise<Response>) {
  const mock = vi.fn(async (input: unknown) => impl(String(input)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

const offline = () =>
  stubFetch(async () => {
    throw new Error('offline');
  });

beforeEach(() => clearRulesCache());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the bundled snapshot', () => {
  it('parses as a rules catalogue', () => {
    expect(snapshot.version).toBe(1);
    expect(snapshot.domains.length).toBeGreaterThan(5);
    expect(snapshot.rules.length).toBeGreaterThan(50);
  });

  it('carries the terms of use the catalogue is published with', () => {
    expect(snapshot.license).toMatchObject({ permitted: expect.any(Array) });
  });

  it('is exactly what `npm run sync:rules` writes — never edited by hand', () => {
    const text = readFileSync(SNAPSHOT_PATH, 'utf8');
    expect(text).toBe(formatSnapshot(JSON.parse(text)));
  });

  it('is internally consistent: unique ids, and every domain lists exactly its rules', () => {
    const ids = snapshot.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const domain of snapshot.domains) {
      const own = snapshot.rules.filter((r) => r.domain === domain.slug).map((r) => r.id);
      expect(domain.rules, domain.slug).toEqual(own);
    }
  });

  it('points at the public docs, not at a development server', () => {
    const text = readFileSync(SNAPSHOT_PATH, 'utf8');
    expect(text).not.toMatch(/localhost|127\.0\.0\.1/);
  });
});

describe('parseRulesCatalog', () => {
  it('rejects a document without the fields the tools read', () => {
    expect(() => parseRulesCatalog({ version: 1, domains: [], rules: [] })).toThrow(
      RulesCatalogError,
    );
    const broken = structuredClone(snapshot) as unknown as { rules: Record<string, unknown>[] };
    delete broken.rules[3]!.statement;
    expect(() => parseRulesCatalog(broken)).toThrow(/statement/);
  });

  it('ignores fields it does not know, so an upstream addition cannot break the server', () => {
    const extended = { ...structuredClone(snapshot), extra: true };
    expect(parseRulesCatalog(extended).rules.length).toBe(snapshot.rules.length);
  });
});

describe('loadRules', () => {
  it('reads /api/rules.json under the docs URL, which BEEL_DOCS_URL overrides', async () => {
    expect(rulesUrl({})).toBe('https://docs.beel.es/api/rules.json');
    expect(rulesUrl({ BEEL_DOCS_URL: 'http://localhost:3007/' })).toBe(
      'http://localhost:3007/api/rules.json',
    );
    const mock = stubFetch(async () => new Response(JSON.stringify(liveCatalog())));
    const { catalog, origin } = await loadRules({ BEEL_DOCS_URL: 'http://docs.test' });
    expect(origin).toBe('live');
    expect(catalog.rules[0]!.title).toBe('Served live');
    expect(mock.mock.calls[0]![0]).toBe('http://docs.test/api/rules.json');
  });

  it('caches a live copy for the TTL', async () => {
    const mock = stubFetch(async () => new Response(JSON.stringify(liveCatalog())));
    await loadRules({});
    await loadRules({});
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the bundled snapshot when the fetch fails', async () => {
    offline();
    const { catalog, origin } = await loadRules({});
    expect(origin).toBe('snapshot');
    expect(catalog.rules.length).toBe(snapshot.rules.length);
  });

  it('falls back to the snapshot on an HTTP error or a body that is not a catalogue', async () => {
    stubFetch(async () => new Response('not found', { status: 404 }));
    expect((await loadRules({})).origin).toBe('snapshot');
    clearRulesCache();
    stubFetch(async () => new Response(JSON.stringify({ hello: 'world' })));
    expect((await loadRules({})).origin).toBe('snapshot');
  });

  it('prefers a stale live copy over the snapshot once the TTL has passed', async () => {
    vi.useFakeTimers();
    stubFetch(async () => new Response(JSON.stringify(liveCatalog())));
    await loadRules({});
    vi.advanceTimersByTime(CACHE_TTL_MS.rules + 1);
    offline();
    const { catalog, origin } = await loadRules({});
    expect(origin).toBe('stale');
    expect(catalog.rules[0]!.title).toBe('Served live');
  });

  it('does not retry a failing host on every call', async () => {
    vi.useFakeTimers();
    const mock = offline();
    await loadRules({});
    await loadRules({});
    expect(mock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RULES_SOURCE.retryAfterFailureMs + 1);
    await loadRules({});
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe('filters', () => {
  it('filters by domain, enforced_by and severity, combined', () => {
    const rules = filterRules(snapshot, { domain: 'corrective', enforced_by: 'api' });
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.domain === 'corrective' && r.enforced_by === 'api')).toBe(true);
    const mustNot = filterRules(snapshot, { severity: 'must_not' });
    expect(mustNot.length).toBeGreaterThan(0);
    expect(mustNot.every((r) => r.severity === 'MUST_NOT')).toBe(true);
  });

  it('matches every query word against id, title and statement', () => {
    const [first] = filterRules(snapshot, { query: 'simplified 3,000' });
    expect(first?.id).toBe('SIM-001');
    expect(filterRules(snapshot, { query: 'lif-001' }).map((r) => r.id)).toEqual(['LIF-001']);
    expect(filterRules(snapshot, { query: 'zzzz-no-such-word' })).toEqual([]);
  });

  it('answers an unknown filter value with the values that exist', () => {
    expect(() => filterRules(snapshot, { domain: 'nope' })).toThrow(RulesQueryError);
    expect(() => filterRules(snapshot, { domain: 'nope' })).toThrow(/corrective/);
    expect(() => filterRules(snapshot, { enforced_by: 'robot' })).toThrow(/integrator/);
  });
});

describe(`${RULES_LIST}`, () => {
  beforeEach(() => {
    offline();
  });

  it('is read-only and open-world, with a response_format switch', () => {
    for (const tool of rulesTools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      expect(tool.inputSchema.properties).toHaveProperty('response_format');
    }
  });

  it('prints one line per rule: ID · strength · statement · enforced_by', async () => {
    const text = await executeRulesTool(RULES_LIST, { domain: 'void' });
    const lines = text.split('\n').filter((l) => /^VOI-\d{3} · /.test(l));
    expect(lines).toHaveLength(snapshot.domains.find((d) => d.slug === 'void')!.rules.length);
    expect(lines[0]).toMatch(/^VOI-001 · required · .+ · issuer$/);
    // A MUST_NOT rule whose title is an instruction never reads as its opposite.
    expect(text).not.toMatch(/MUST_NOT|MUST NOT/);
    expect(text).not.toContain('Domains (filter');
  });

  it('lists the domains when called unfiltered, and stays small', async () => {
    const text = await executeRulesTool(RULES_LIST, {});
    for (const d of snapshot.domains) expect(text).toContain(`- ${d.slug} (`);
    expect(text).toMatch(/more\. Narrow with domain/);
    expect(text.length).toBeLessThan(8_000);
  });

  it('cuts long statements in concise and keeps them whole in detailed', () => {
    const long = snapshot.rules.find((r) => r.statement.length > CONCISE_STATEMENT_CHARS)!;
    const concise = renderRuleList(snapshot, { query: long.id }, 'concise', 20);
    const detailed = renderRuleList(snapshot, { query: long.id }, 'detailed', 20);
    expect(concise).not.toContain(long.statement);
    expect(concise).toContain('…');
    expect(detailed).toContain(long.statement);
  });

  it('keeps even the whole catalogue within a bounded size', async () => {
    const text = await executeRulesTool(RULES_LIST, { limit: 200 });
    // 127 rules today; one short line each.
    expect(text.length).toBeLessThan(snapshot.rules.length * 260);
  });

  it('says when the answer came from the bundled snapshot', async () => {
    expect(await executeRulesTool(RULES_LIST, { domain: 'void' })).toMatch(/bundled/);
  });

  it('rejects an unknown filter with the fix', async () => {
    await expect(executeRulesTool(RULES_LIST, { domain: 'vat' })).rejects.toThrow(
      /Use one of: .*taxes/,
    );
  });
});

describe(`${RULES_GET}`, () => {
  beforeEach(() => {
    offline();
  });

  it('returns the full rule by id: statement, why, legal quote, examples, related, docs', async () => {
    const rule = snapshot.rules.find((r) => r.id === 'LIF-001')!;
    const text = await executeRulesTool(RULES_GET, { id: 'lif-001' });
    expect(text).toContain(rule.statement);
    expect(text).toContain(rule.why);
    expect(text).toContain(rule.legal_basis[0]!.quote!);
    expect(text).toContain(rule.examples.incorrect!.text);
    expect(text).toContain(`Related: ${rule.related.join(', ')}`);
    expect(text).toContain(rule.url);
  });

  it('keeps the concise form short', async () => {
    const rule = snapshot.rules.find((r) => r.id === 'LIF-001')!;
    const text = await executeRulesTool(RULES_GET, { id: 'LIF-001', response_format: 'concise' });
    expect(text).toContain(rule.statement);
    expect(text).not.toContain(rule.legal_basis[0]!.quote!);
    expect(text.length).toBeLessThan(1_500);
  });

  it('returns every rule citing an error code', async () => {
    const citing = snapshot.rules.filter((r) =>
      r.error_codes.some((e) => e.code === 'SIMPLIFICADA_FORBIDS_IRPF'),
    );
    expect(citing.length).toBeGreaterThan(1);
    const text = await executeRulesTool(RULES_GET, { error_code: 'simplificada_forbids_irpf' });
    for (const rule of citing) expect(text).toContain(`${rule.id} · `);
  });

  it('explains how to fix a lookup that finds nothing', async () => {
    await expect(executeRulesTool(RULES_GET, { id: 'COR-999' })).rejects.toThrow(
      /COR-001 to COR-\d{3}.*beel_rules_list/,
    );
    await expect(executeRulesTool(RULES_GET, { error_code: 'NO_SUCH_CODE' })).rejects.toThrow(
      /errors\/NO_SUCH_CODE/,
    );
    await expect(executeRulesTool(RULES_GET, {})).rejects.toThrow(/exactly one of id/);
    await expect(
      executeRulesTool(RULES_GET, { id: 'LIF-001', error_code: 'STATUS_NOT_MODIFIABLE' }),
    ).rejects.toThrow(/exactly one of id/);
  });
});

describe('error enrichment with the rules a code enforces', () => {
  const fromSnapshot = async () => ({ catalog: snapshot, origin: 'snapshot' as const });

  it('names the id, title and link of each rule citing the code', async () => {
    const rule = snapshot.rules.find((r) => r.id === 'LIF-001')!;
    const note = await rulesNoteForCode('STATUS_NOT_MODIFIABLE', fromSnapshot);
    expect(note).toContain(`- LIF-001 ${rule.title} — ${rule.url}`);
    expect(note).toContain('beel_rules_get');
  });

  it('adds nothing for a code no rule cites, or with no code at all', async () => {
    expect(await rulesNoteForCode('INVOICE_NO_LINES', fromSnapshot)).toBe('');
    expect(await rulesNoteForCode(undefined, fromSnapshot)).toBe('');
  });

  it('fails silently when the catalogue cannot be read', async () => {
    const broken = async () => {
      throw new Error('unreachable');
    };
    expect(await rulesNoteForCode('STATUS_NOT_MODIFIABLE', broken)).toBe('');
    const text = await explainErrorWithRules(
      { status: 409, message: 'no', code: 'STATUS_NOT_MODIFIABLE' },
      broken,
    );
    expect(text).toContain('BeeL API error 409: no');
  });

  it(`caps the list at ${MAX_RULES_PER_ERROR} and points at the rest`, async () => {
    const crowded = structuredClone(snapshot);
    for (const rule of crowded.rules.slice(0, 6)) {
      rule.error_codes.push({ code: 'X_CODE', url: 'https://docs.beel.es/errors/X_CODE' });
    }
    const note = await rulesNoteForCode('X_CODE', async () => ({
      catalog: crowded,
      origin: 'live',
    }));
    expect(note.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(MAX_RULES_PER_ERROR);
    expect(note).toContain('3 more');
  });

  it('appends the note after the explained error', async () => {
    const text = await explainErrorWithRules(
      { status: 409, message: 'Issued invoices cannot be edited', code: 'STATUS_NOT_MODIFIABLE' },
      fromSnapshot,
    );
    expect(text.indexOf('code: STATUS_NOT_MODIFIABLE')).toBeLessThan(text.indexOf('LIF-001'));
  });
});
