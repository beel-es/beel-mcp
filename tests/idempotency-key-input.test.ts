import { describe, expect, it } from 'vitest';
import { buildApiTools } from '../src/tools/api-tools.js';

/**
 * The idempotency key is derived from a hash of the request itself. That makes a
 * blind retry safe, but a hash cannot tell a retry from an intended repetition:
 * two legitimately identical invoices to the same customer on the same day hash
 * the same, and the API replays the first for 24 h. The agent believes it created
 * the second one, and it does not exist.
 *
 * Only the caller knows which of the two cases it is, so it must be able to say.
 */
describe('the idempotency escape hatch', () => {
  const { tools } = buildApiTools();

  it('offers idempotency_key as an optional input wherever the contract declares the header', () => {
    const declaring = tools.filter(
      (t) =>
        t.operation.method === 'POST' &&
        t.operation.headerParams.some((p) => p.name === 'Idempotency-Key'),
    );
    expect(declaring.length).toBeGreaterThan(0);

    for (const t of declaring) {
      const schema = t.tool.inputSchema as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(
        schema.properties.idempotency_key,
        `${t.operation.operationId} has no escape hatch`,
      ).toBeDefined();
      // Optional: the derived hash still covers the blind retry when it is absent.
      expect(schema.required ?? []).not.toContain('idempotency_key');
    }
  });

  it('offers it on invoice creation, where a duplicate is a second fiscal document', () => {
    const create = tools.find((t) => t.operation.operationId === 'createCompanyInvoice');
    expect(create).toBeDefined();
    const props = (
      create!.tool.inputSchema as { properties: Record<string, Record<string, unknown>> }
    ).properties;
    expect(props.idempotency_key?.type).toBe('string');
    expect(props.idempotency_key?.pattern).toBe('^[a-zA-Z0-9_-]+$');
  });

  it('does not offer it where the contract does not accept it (GET)', () => {
    for (const t of tools.filter((t) => t.operation.method === 'GET')) {
      const props = (t.tool.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(
        props.idempotency_key,
        `${t.operation.operationId} should not offer it`,
      ).toBeUndefined();
    }
  });
});
