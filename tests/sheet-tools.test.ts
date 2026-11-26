import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { SpecNode } from '../src/spec/load.js';
import { buildManifest } from '../src/spec/manifest.js';
import { applyToolPolicy, SHEET_OPERATION_IDS } from '../src/policy/tool-policy.js';
import { fallbackAllowlist, requiredScopes } from '../src/policy/scopes.js';
import { ENV_VAR } from '../src/shared/defaults.js';
import { buildInputSchema } from '../src/spec/json-schema.js';
import { executeApiTool } from '../src/tools/api-tools.js';
import { ArgumentError } from '../src/tools/validate-args.js';

/**
 * The sheet tools, against a fixture contract that already carries them in their
 * account-scoped form: the vendored contract does not yet.
 */
const doc = parse(readFileSync('tests/fixtures/sheets-spec.yaml', 'utf8')) as SpecNode;
const manifest = buildManifest(doc);
const SHEET_IDS = ['listSheets', 'putSheet', 'listSheetRows', 'loadSheet', 'listSheetLoads'];
const AUTOMATION_SCOPES = ['automations:read', 'automations:write'];

const toolIds = () => applyToolPolicy(manifest).tools.map((t) => t.operationId);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sheet tools switched off (the default)', () => {
  it('expose no Automations operation', () => {
    expect(toolIds()).toEqual([]);
  });

  it('ask for no automations scope, not even in the fallback', () => {
    expect(requiredScopes(manifest)).toEqual([]);
    for (const s of AUTOMATION_SCOPES) expect(fallbackAllowlist().has(s)).toBe(false);
  });
});

describe('sheet tools switched on', () => {
  it('expose the five sheet operations and nothing else of Automations', () => {
    vi.stubEnv(ENV_VAR.sheetTools, '1');
    expect(toolIds().sort()).toEqual([...SHEET_IDS].sort());
    expect([...SHEET_OPERATION_IDS].sort()).toEqual([...SHEET_IDS].sort());
  });

  it('ask for automations:read and automations:write, and let the fallback request them', () => {
    vi.stubEnv(ENV_VAR.sheetTools, '1');
    expect(requiredScopes(manifest)).toEqual(AUTOMATION_SCOPES);
    for (const s of AUTOMATION_SCOPES) expect(fallbackAllowlist().has(s)).toBe(true);
  });

  it('stays off for any other value', () => {
    vi.stubEnv(ENV_VAR.sheetTools, 'no');
    expect(toolIds()).toEqual([]);
  });
});

describe('loading a sheet', () => {
  const load = manifest.find((op) => op.operationId === 'loadSheet')!;
  const config = {
    apiKey: 'beel_sk_test_x',
    env: 'test' as const,
    baseUrl: 'https://api.example.test',
  };
  const base = { account_id: 'a1', name: 'tarifas', mode: 'replace', dry_run: true };
  const csv = 'sku,price\nA-1,10.5\n';

  function captureFetch(): RequestInit[] {
    const sent: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(init);
      return new Response(JSON.stringify({ success: true, data: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    return sent;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('takes the rows as JSON or as CSV text, with the dry run and mode as arguments', () => {
    const schema = buildInputSchema(load, doc) as { properties: Record<string, { type?: string }> };
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['rows', 'csv', 'dry_run', 'mode']),
    );
    expect(schema.properties).not.toHaveProperty('body');
    expect(schema.properties.rows!.type).toBe('array');
    expect(schema.properties.csv!.type).toBe('string');
  });

  it('sends the CSV untouched as text/csv', async () => {
    const sent = captureFetch();
    await executeApiTool(config, load, { ...base, csv });
    expect(new Headers(sent[0]!.headers).get('content-type')).toBe('text/csv');
    expect(sent[0]!.body).toBe(csv);
  });

  it('sends the rows as JSON', async () => {
    const sent = captureFetch();
    const rows = [{ sku: 'A-1', price: 10.5 }];
    await executeApiTool(config, load, { ...base, rows });
    expect(new Headers(sent[0]!.headers).get('content-type')).toContain('application/json');
    expect(sent[0]!.body).toBe(JSON.stringify(rows));
  });

  it('refuses both or neither, naming the two arguments', async () => {
    const sent = captureFetch();
    await expect(executeApiTool(config, load, { ...base, csv, rows: [] })).rejects.toThrow(
      /exactly one of `rows` or `csv`/,
    );
    await expect(executeApiTool(config, load, base)).rejects.toThrow(ArgumentError);
    expect(sent).toEqual([]);
  });
});
