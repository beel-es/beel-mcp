import { describe, expect, it } from 'vitest';
import { buildApiTools } from '../src/tools/api-tools.js';
import { IDEMPOTENCY_KEY_DESCRIPTION } from '../src/spec/json-schema.js';
import { SERVER_INSTRUCTIONS } from '../src/server.js';
import { ERROR_CATALOG } from '../src/guardrails/catalog.js';

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

  it('describes it in one line, the same on every tool', () => {
    expect(IDEMPOTENCY_KEY_DESCRIPTION.length).toBeLessThan(160);
    for (const t of tools) {
      const props = (t.tool.inputSchema as { properties: Record<string, { description?: string }> })
        .properties;
      if (props.idempotency_key) {
        expect(props.idempotency_key.description).toBe(IDEMPOTENCY_KEY_DESCRIPTION);
      }
    }
  });
});

describe('one story about idempotency', () => {
  it('the instructions say the tools derive the key, and when to pass one', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/derives its Idempotency-Key from the request/);
    expect(SERVER_INSTRUCTIONS).toMatch(/pass idempotency_key only for a deliberate identical/);
  });

  it('nothing asks for a new key after a 4xx: the API frees the key (LIF-004)', () => {
    const texts = [
      SERVER_INSTRUCTIONS,
      ...Object.values(ERROR_CATALOG).map((entry) => entry.remedy ?? ''),
    ];
    for (const text of texts)
      expect(text).not.toMatch(/new Idempotency-Key|retry with the SAME key/);
  });

  it('a key mismatch says how to retry and how to start a new operation', () => {
    const remedy = ERROR_CATALOG.IDEMPOTENCY_KEY_MISMATCH!.remedy!;
    expect(remedy).toMatch(/send it unchanged/);
    expect(remedy).toMatch(/omit idempotency_key so one is derived/);
  });
});
