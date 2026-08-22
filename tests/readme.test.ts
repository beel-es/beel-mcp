import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildApiTools } from '../src/tools/api-tools.js';
import { docsTools } from '../src/tools/docs-tools.js';
import { workflowTools } from '../src/tools/workflow-tools.js';
import { prompts } from '../src/prompts/workflows.js';

/**
 * The README states counts, and counts rot as the contract grows. On a project
 * whose whole claim is that its surface is derived rather than maintained by
 * hand, a number that no longer matches is the first thing a reader can check
 * and the worst one to get wrong. So assert them rather than trusting an editor
 * to remember.
 */
const readme = readFileSync('README.md', 'utf8');

describe('the README counts match reality', () => {
  it('states the real number of API tools', () => {
    const count = buildApiTools().tools.length;
    expect(readme, `README should say ${count} API tools`).toContain(`**${count} API tools**`);
  });

  it('states the real number of synthetic tools', () => {
    const count = docsTools.length + workflowTools.length;
    expect(readme, `README should say ${count} synthetic tools`).toContain(
      `**${count} synthetic tools**`,
    );
  });

  it('states the real number of workflow prompts', () => {
    expect(readme, `README should say ${prompts.length} workflow prompts`).toContain(
      `**${prompts.length} workflow prompts**`,
    );
  });

  it('names every workflow prompt that exists', () => {
    for (const prompt of prompts) {
      expect(readme, `README does not mention the "${prompt.name}" prompt`).toContain(prompt.name);
    }
  });

});
