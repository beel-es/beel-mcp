import { describe, expect, it } from 'vitest';
import { renameInDescriptions, routeNamer } from '../src/spec/routes.js';
import { buildApiTools } from '../src/tools/api-tools.js';

describe('routes quoted in prose are named as tools', () => {
  const name = routeNamer([
    { name: 'beel_create_corrective_invoice', method: 'POST', path: '/v1/x/{id}/corrective' },
  ]);

  it('rewrites a quoted route of a known tool, and leaves any other as written', () => {
    expect(name('Created via `POST /v1/x/{id}/corrective`.')).toBe(
      'Created via `beel_create_corrective_invoice`.',
    );
    expect(name('See `GET /v1/x/{id}/corrective` and `POST /v1/other`.')).toBe(
      'See `GET /v1/x/{id}/corrective` and `POST /v1/other`.',
    );
    // An unquoted route, like a tool's own Endpoint line, is left alone.
    expect(name('Endpoint: POST /v1/x/{id}/corrective')).toBe(
      'Endpoint: POST /v1/x/{id}/corrective',
    );
  });

  it('rewrites every description of a schema, in place', () => {
    const schema = {
      description: '`POST /v1/x/{id}/corrective`',
      properties: { a: { description: 'via `POST /v1/x/{id}/corrective`' } },
    };
    renameInDescriptions(schema, name);
    expect(schema.description).toBe('`beel_create_corrective_invoice`');
    expect(schema.properties.a.description).toBe('via `beel_create_corrective_invoice`');
  });

  it('applies to the tool definitions: a route a tool calls is named by that tool', () => {
    const tools = buildApiTools().tools;
    const routes = new Set(tools.map((t) => `${t.operation.method} ${t.operation.path}`));
    for (const { tool } of tools) {
      const text = JSON.stringify(tool);
      for (const match of text.matchAll(/`(GET|POST|PUT|PATCH|DELETE) (\/v1\/[^`\s]+)`/g)) {
        expect(routes.has(`${match[1]} ${match[2]}`), `${tool.name}: ${match[0]}`).toBe(false);
      }
    }
    const create = tools.find((t) => t.tool.name === 'beel_create_invoice')!.tool;
    expect(create.description).toMatch(
      /^Endpoint: POST \/v1\/companies\/\{company_id\}\/invoices$/m,
    );
  });
});
