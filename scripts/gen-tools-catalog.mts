/**
 * Generates the tool catalogue (grouped by tag) as MDX for the documentation site
 * at docs.beel.es, whose reference page expects the `<Accordions>` components
 * emitted below. Nothing in this repository consumes the output; it is copied
 * into the docs site by hand after a contract sync.
 *
 * The catalogue is derived from the OpenAPI contract and the scope policy, so it
 * cannot drift from the tools the server actually exposes.
 *
 *   npm run tools:catalog > tools-catalog.mdx
 */
import { buildApiTools } from '../src/tools/api-tools.js';
import { requiredScopes } from '../src/policy/scopes.js';

// The same entry point the server uses, so the catalogue documents exactly the
// tools an agent is offered — including the policy's exclusions.
const { tools } = buildApiTools();

// One group per tag; one row per tool with its name, summary and required scopes.
const byTag = new Map<string, { name: string; summary: string; scopes: string[] }[]>();
for (const { tool, operation } of tools) {
  const rows = byTag.get(operation.tags[0]) ?? [];
  rows.push({
    name: tool.name,
    summary: (operation.summary || '').replace(/\|/g, '\\|').trim(),
    scopes: requiredScopes([operation]),
  });
  byTag.set(operation.tags[0], rows);
}

const tags = [...byTag.keys()].sort((a, b) => a.localeCompare(b));
let total = 0;
const lines: string[] = [];

// Only the per-category tool catalogue: prompts and helper tools are hand-written
// in the docs, where curation reads better than generation. Every `<Accordion>`
// must sit inside an `<Accordions>` wrapper.
lines.push('<Accordions type="single">');
lines.push('');
for (const tag of tags) {
  const rows = byTag.get(tag)!.sort((a, b) => a.name.localeCompare(b.name));
  total += rows.length;
  lines.push(`<Accordion title="${tag} (${rows.length})">`);
  lines.push('');
  lines.push('| Tool | Description | Scopes |');
  lines.push('| --- | --- | --- |');
  for (const r of rows) {
    const scopes = r.scopes.length ? r.scopes.map((s) => `\`${s}\``).join(' ') : '—';
    lines.push(`| \`${r.name}\` | ${r.summary || '—'} | ${scopes} |`);
  }
  lines.push('');
  lines.push('</Accordion>');
  lines.push('');
}
lines.push('</Accordions>');

console.error(`Tags: ${tags.length}, tools: ${total}`);
console.log(lines.join('\n'));
