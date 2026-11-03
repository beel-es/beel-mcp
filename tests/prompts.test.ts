import { describe, expect, it } from 'vitest';
import { getPrompt, prompts } from '../src/prompts/workflows.js';

const NEW_PROMPTS = [
  'onboard-nif',
  'invite-member',
  'connect-payments',
  'upgrade-integration',
  'setup-representation',
];

function guidance(name: string, args: Record<string, string> = {}): string {
  const result = getPrompt(name, args);
  return result.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');
}

describe('guided workflow prompts', () => {
  it('registers the four new prompts alongside the originals', () => {
    const names = prompts.map((p) => p.name);
    for (const n of NEW_PROMPTS) expect(names).toContain(n);
    expect(names).toContain('issue-invoice');
  });

  it('onboard-nif encodes the safe order and references the real tools', () => {
    const text = guidance('onboard-nif', { nif: 'B12345678', business_name: 'Acme SL' });
    expect(text.length).toBeGreaterThan(200);
    for (const tool of [
      'beel_get_my_identity',
      'beel_list_companies',
      'beel_create_company',
      'beel_get_issuing_readiness',
      'beel_set_default_series',
      'beel_get_verifactu_configuration',
      'beel_initiate_payment_connection',
      'beel_create_invoice',
      'beel_get_setup_status',
    ]) {
      expect(text).toContain(tool);
    }
    expect(text).toContain('B12345678');
    expect(text).toContain('Acme SL');
  });

  it('setup-representation encodes the flow and directs the signed upload off-MCP', () => {
    const text = guidance('setup-representation', { company: 'B12345678' });
    for (const tool of [
      'beel_get_issuing_readiness',
      'beel_generate_representation',
      'beel_download_representation_document',
      'beel_get_representation',
    ]) {
      expect(text).toContain(tool);
    }
    expect(text).toContain('NIF_REPRESENTATION_REQUIRED');
    expect(text).toContain('B12345678');
  });

  it('invite-member explains roles and references the member tools', () => {
    const text = guidance('invite-member', { email: 'gestor@example.com', role: 'MEMBER' });
    expect(text).toContain('beel_list_members');
    expect(text).toContain('beel_create_invitation');
    expect(text).toContain('beel_put_member_grant');
    expect(text).toContain('OWNER');
    expect(text).toContain('gestor@example.com');
  });

  it('connect-payments explains per-NIF vs account-wide and references the tools', () => {
    const text = guidance('connect-payments');
    expect(text).toContain('beel_list_payment_connections');
    expect(text).toContain('beel_initiate_payment_connection');
    expect(text.toLowerCase()).toContain('account-wide');
  });

  it('upgrade-integration covers best practices and points at the docs tool', () => {
    const text = guidance('upgrade-integration', { current_stack: 'Node.js' });
    expect(text).toContain('beel_docs_search');
    expect(text.toLowerCase()).toContain('idempotency');
    expect(text.toLowerCase()).toContain('webhook');
    expect(text).toContain('Node.js');
  });

  it('fix-rejection decides by status and code family, never by the message', () => {
    expect(prompts.map((p) => p.name)).toContain('fix-rejection');
    const text = guidance('fix-rejection', { invoice: 'inv_123' });
    for (const tool of [
      'beel_get_invoice',
      'beel_list_invoices',
      'beel_list_invoice_verifactu_records',
      'beel_validate_nif',
      'beel_patch_customer',
      'beel_create_corrective_invoice',
    ]) {
      expect(text).toContain(tool);
    }
    for (const code of ['1109', '4112', '4141', '3000', '1100', '4102'])
      expect(text).toContain(code);
    expect(text).toContain('never parse `error_message`');
    expect(text).toContain('inv_123');
  });

  it('go-live-checklist covers every gate and asks before the billed activation', () => {
    expect(prompts.map((p) => p.name)).toContain('go-live-checklist');
    const text = guidance('go-live-checklist', {
      company: 'B12345678',
      last_number: 'A-2026-0412',
    });
    for (const tool of [
      'beel_get_issuing_readiness',
      'beel_get_representation',
      'beel_get_verifactu_configuration',
      'beel_list_series',
      'beel_activate_company',
      'beel_list_webhook_subscriptions',
    ]) {
      expect(text).toContain(tool);
    }
    expect(text).toContain('initial_number');
    expect(text).toContain('Confirm with me before calling it');
    expect(text).toContain('A-2026-0412');
  });

  it('throws on an unknown prompt', () => {
    expect(() => getPrompt('nope', {})).toThrow();
  });
});
