import { describe, expect, it } from 'vitest';
import { buildApiTools } from '../src/tools/api-tools.js';

/**
 * La clave de idempotencia se deriva de un hash del propio request. Eso hace seguro
 * el reintento ciego, pero un hash no distingue un reintento de una repetición
 * querida: dos facturas legítimamente idénticas al mismo cliente el mismo día dan
 * la misma clave, y la API devuelve el resultado de la primera durante 24 h. El
 * agente cree que creó la segunda y no existe.
 *
 * Solo quien llama sabe cuál de los dos casos es, así que necesita poder decirlo.
 */
describe('escotilla de idempotencia', () => {
  const { tools } = buildApiTools();

  it('los POST con Idempotency-Key aceptan idempotency_key como entrada opcional', () => {
    const posts = tools.filter(
      (t) =>
        t.operation.method === 'POST' &&
        t.operation.headerParams.some((p) => p.name === 'Idempotency-Key'),
    );
    expect(posts.length).toBeGreaterThan(0);

    for (const t of posts) {
      const schema = t.tool.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      expect(schema.properties.idempotency_key, `${t.operation.operationId} sin escotilla`).toBeDefined();
      // Opcional: el hash sigue cubriendo el reintento ciego cuando no se envía.
      expect(schema.required ?? []).not.toContain('idempotency_key');
    }
  });

  it('crear factura es uno de ellos', () => {
    const create = tools.find((t) => t.operation.operationId === 'createCompanyInvoice');
    expect(create).toBeDefined();
    const props = (create!.tool.inputSchema as { properties: Record<string, any> }).properties;
    expect(props.idempotency_key?.type).toBe('string');
    expect(props.idempotency_key?.pattern).toBe('^[a-zA-Z0-9_-]+$');
  });

  it('no se ofrece donde el contrato no lo admite (GET)', () => {
    const gets = tools.filter((t) => t.operation.method === 'GET');
    for (const t of gets) {
      const props = (t.tool.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(props.idempotency_key, `${t.operation.operationId} no debería ofrecerla`).toBeUndefined();
    }
  });
});
