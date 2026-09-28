import { describe, expect, it } from 'vitest';
import { MAX_SCHEMA_CONSTRAINT_CHARS, schemaDescription } from '../src/spec/prose.js';

describe('schemaDescription', () => {
  it('keeps a one-paragraph description as written', () => {
    expect(schemaDescription('Invoice type.\nOne of four.')).toBe('Invoice type.\nOne of four.');
  });

  it('keeps the first paragraph, then only the rules of the rest', () => {
    const text = [
      'Main tax of the line.',
      '**Mandatory on `NORMAL` lines.** Some history about why.',
      'An example: IVA at 21. Omitting it is rejected with `422 LINE_MAIN_TAX_REQUIRED`.',
    ].join('\n\n');
    expect(schemaDescription(text)).toBe(
      'Main tax of the line.\n\nMandatory on `NORMAL` lines. ' +
        'Omitting it is rejected with `422 LINE_MAIN_TAX_REQUIRED`.',
    );
  });

  it('drops later paragraphs that state no rule', () => {
    expect(schemaDescription('A code.\n\nBackground.\n\nAn example.')).toBe('A code.');
  });

  it(`adds at most ${MAX_SCHEMA_CONSTRAINT_CHARS} characters of rules`, () => {
    const rules = Array.from({ length: 20 }, (_unused, i) => `Rule ${i} must hold.`).join(' ');
    const [, extra = ''] = schemaDescription(`A field.\n\n${rules}`).split('\n\n');
    expect(extra.length).toBeLessThanOrEqual(MAX_SCHEMA_CONSTRAINT_CHARS);
    expect(extra.startsWith('Rule 0 must hold.')).toBe(true);
  });
});
