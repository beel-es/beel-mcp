import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
 * Names drift for ordinary reasons — an API migration renames an operation, a
 * tool gains a path segment — and prose is the one place a compiler cannot
 * follow. This is the check that does.
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

/** Every `.ts` and `.md` under a directory, recursively. */
function textFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return textFiles(path);
    return /\.(ts|md)$/.test(path) ? [path] : [];
  });
}

describe('every tool named in agent-facing text exists', () => {
  it('anywhere under src/ — prose, prompts, descriptions, comments alike', () => {
    // The whole tree rather than the files that happen to hold prose today: a
    // tool name reaches the model from wherever it is written, and the next
    // module to name one will not be on a list anybody remembered to extend.
    const broken = textFiles('src').flatMap((file) =>
      brokenReferencesIn(readFileSync(file, 'utf8'), file),
    );
    expect(broken).toEqual([]);
  });

  it('in the error catalogue remedies', () => {
    const broken = Object.entries(ERROR_CATALOG).flatMap(([code, entry]) =>
      brokenReferencesIn(entry.remedy ?? '', code),
    );
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
