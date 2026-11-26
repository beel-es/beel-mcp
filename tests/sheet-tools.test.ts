import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { SpecNode } from '../src/spec/load.js';
import { buildManifest } from '../src/spec/manifest.js';
import { applyToolPolicy, SHEET_OPERATION_IDS } from '../src/policy/tool-policy.js';
import { fallbackAllowlist, requiredScopes } from '../src/policy/scopes.js';
import { ENV_VAR } from '../src/shared/defaults.js';

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
