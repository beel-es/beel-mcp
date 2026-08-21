import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { catalogCodes, ERROR_CATALOG, lookupError } from '../src/guardrails/catalog.js';
import { GUARDRAILS } from '../src/guardrails/rules.js';
import { buildApiTools } from '../src/tools/api-tools.js';
import { docsTools } from '../src/tools/docs-tools.js';
import { workflowTools } from '../src/tools/workflow-tools.js';

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

  it('names only tools that exist, so a remedy never sends the agent nowhere', () => {
    const known = new Set(buildApiTools().tools.map((t) => t.tool.name));
    for (const t of [...docsTools, ...workflowTools]) known.add(t.name);
    const broken: string[] = [];
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      for (const match of (entry.remedy ?? '').matchAll(/\bbeel_[a-z0-9_]+/g)) {
        if (!known.has(match[0])) broken.push(`${code} → ${match[0]}`);
      }
    }
    expect(broken).toEqual([]);
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
});
