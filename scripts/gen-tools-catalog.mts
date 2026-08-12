/**
 * Genera el catálogo de tools del MCP (agrupado por tag) en formato MDX para las docs.
 * Derivado del contrato OpenAPI + la política de scopes, así nunca se desincroniza.
 *
 *   npx tsx scripts/gen-tools-catalog.mts > /tmp/tools-catalog.mdx
 */
import { buildApiTools } from '../src/tools/api-tools.js';
import { requiredScopes } from '../src/policy/tool-policy.js';

// Usa la MISMA vía que el server (buildApiTools aplica la política: excluye deprecated),
// así el catálogo documenta exactamente las tools que el agente ve.
const { tools } = buildApiTools();

// Agrupa por tag; una fila por tool con nombre, resumen y scopes requeridos.
const byTag = new Map<string, { name: string; summary: string; scopes: string[] }[]>();
for (const { tool, operation } of tools) {
  const rows = byTag.get(operation.tag) ?? [];
  rows.push({
    name: tool.name,
    summary: (operation.summary || '').replace(/\|/g, '\\|').trim(),
    scopes: requiredScopes([operation]),
  });
  byTag.set(operation.tag, rows);
}

const tags = [...byTag.keys()].sort((a, b) => a.localeCompare(b));
let total = 0;
const lines: string[] = [];
for (const tag of tags) {
  const rows = byTag.get(tag)!.sort((a, b) => a.name.localeCompare(b.name));
  total += rows.length;
  lines.push(`<Accordion title="${tag} (${rows.length})">`);
  lines.push('');
  lines.push('| Tool | Descripción | Scopes |');
  lines.push('| --- | --- | --- |');
  for (const r of rows) {
    const scopes = r.scopes.length ? r.scopes.map((s) => `\`${s}\``).join(' ') : '—';
    lines.push(`| \`${r.name}\` | ${r.summary || '—'} | ${scopes} |`);
  }
  lines.push('');
  lines.push('</Accordion>');
  lines.push('');
}

console.error(`Tags: ${tags.length}, tools: ${total}`);
console.log(lines.join('\n'));
