import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApiTools } from '../src/tools/api-tools.js';
import { docsTools } from '../src/tools/docs-tools.js';
import { workflowTools } from '../src/tools/workflow-tools.js';
import { ERROR_CATALOG } from '../src/guardrails/catalog.js';

/**
 * Everything this server writes for a model to read — guardrail prose, workflow
 * prompts, error remedies — names tools the model is meant to call. A name that
 * does not resolve sends the agent nowhere, and nothing else in the build would
 * notice: these are strings, not identifiers.
 *
 * This has already caught real breakage twice: deprecated operationIds cited in
 * the guardrails after the company-scoped migration, and a prompt asking for
 * `beel_create_corrective_invoice` (the real name has `company` in it).
 */

const TOOL_NAMES = new Set([
  ...buildApiTools().tools.map((t) => t.tool.name),
  ...docsTools.map((t) => t.name),
  ...workflowTools.map((t) => t.name),
]);

/** `beel_sk_test_`/`beel_sk_live_` are API key prefixes, not tools. */
const NOT_A_TOOL = /^beel_sk_(test|live)_/;

function brokenReferencesIn(text: string, label: string): string[] {
  const broken: string[] = [];
  for (const match of text.matchAll(/\bbeel_[a-z0-9_]+/g)) {
    const name = match[0];
    if (NOT_A_TOOL.test(name) || TOOL_NAMES.has(name)) continue;
    broken.push(`${label}: ${name}`);
  }
  return broken;
}

describe('every tool named in agent-facing text exists', () => {
  it('in the guardrail prose', () => {
    const dir = 'src/guardrails/rules';
    const broken = readdirSync(dir).flatMap((f) =>
      brokenReferencesIn(readFileSync(join(dir, f), 'utf8'), f),
    );
    expect(broken).toEqual([]);
  });

  it('in the workflow prompts', () => {
    const broken = brokenReferencesIn(
      readFileSync('src/prompts/workflows.ts', 'utf8'),
      'prompts/workflows.ts',
    );
    expect(broken).toEqual([]);
  });

  it('in the error catalogue remedies', () => {
    const broken = Object.entries(ERROR_CATALOG).flatMap(([code, entry]) =>
      brokenReferencesIn(entry.remedy ?? '', code),
    );
    expect(broken).toEqual([]);
  });

  it('in the setup-status report and server instructions', () => {
    const broken = [
      ...brokenReferencesIn(readFileSync('src/tools/workflow-tools.ts', 'utf8'), 'workflow-tools.ts'),
      ...brokenReferencesIn(readFileSync('src/server.ts', 'utf8'), 'server.ts'),
    ];
    expect(broken).toEqual([]);
  });

  it('in the README, which is where a user starts', () => {
    const broken = brokenReferencesIn(readFileSync('README.md', 'utf8'), 'README.md').filter(
      // The scoped npm package name, not a tool.
      (ref) => !ref.endsWith('beel_es'),
    );
    expect(broken).toEqual([]);
  });
});
