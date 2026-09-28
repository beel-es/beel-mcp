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
      'beel_get_setup_status',
      'beel_validate_nif',
      'beel_create_company',
      'beel_set_default_series',
      'beel_update_verifactu_configuration',
      'beel_get_issuing_readiness',
      'beel_initiate_payment_connection',
    ]) {
      expect(text).toContain(tool);
    }
    // Readiness before the first invoice, and no re-reads the setup report already gives.
    expect(text.indexOf('beel_get_issuing_readiness')).toBeLessThan(text.indexOf('first invoice'));
    expect(text).not.toContain('beel_get_my_identity');
    expect(text).not.toContain('beel_get_verifactu_configuration');
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
    expect(text).toContain('gestor@example.com');
    // Roles as the contract has them: OWNER is never invited, access is per company.
    expect(text).toMatch(/`account_role`\. OWNER cannot be invited/);
    expect(text).toMatch(/`access_level` VIEW \(read\) or OPERATE/);
    expect(text).not.toMatch(/account-wide/);
    const role = prompts
      .find((p) => p.name === 'invite-member')!
      .arguments!.find((a) => a.name === 'role')!;
    expect(role.description).not.toContain('OWNER');
  });

  it('connect-payments connects one NIF by its company_id, never account-wide', () => {
    const text = guidance('connect-payments');
    expect(text).toContain('beel_list_payment_connections');
    expect(text).toContain('beel_initiate_payment_connection');
    expect(text).toMatch(/A connection belongs to one NIF: every call takes its company_id/);
    expect(text.toLowerCase()).not.toContain('account-wide');
    expect(prompts.find((p) => p.name === 'connect-payments')!.description).not.toMatch(
      /focus|account-wide/,
    );
  });

  it('no prompt asks to put a company in focus: every call takes its company_id', () => {
    for (const p of prompts) {
      expect(guidance(p.name).toLowerCase(), p.name).not.toMatch(/in focus|with-focus/);
      expect(p.description!.toLowerCase(), p.name).not.toContain('focus');
    }
  });

  it('fix-invoice follows VOI-001, COR-017 and COR-024', () => {
    const text = guidance('fix-invoice');
    expect(text).toMatch(/operation never took place[\s\S]*beel_void_invoice` \(VOI-001\)/);
    expect(text).toMatch(/never voided to fix it/);
    expect(text).toMatch(
      /rectification_type PARTIAL,\s+rectification_code R4 and no lines \(COR-017\)/,
    );
    expect(text).toMatch(/IRPF withholding it should not have → not a corrective \(COR-024\)/);
    expect(text).toMatch(/void it and issue it again without the withholding/);
  });

  it('issue-invoice checks readiness with the tool, and tells a draft from an issued invoice', () => {
    const text = guidance('issue-invoice');
    expect(text).toMatch(/`beel_get_issuing_readiness`, and resolve its\s+`blockers` first/);
    expect(text).toMatch(
      /saved as a DRAFT, with no\s+number, unless `options.issue_directly` is true/,
    );
    expect(text).toContain('beel_issue_invoice');
    expect(text).not.toMatch(/issuing as a draft/);
  });

  it('upgrade-integration covers best practices and points at the docs tool', () => {
    const text = guidance('upgrade-integration', { current_stack: 'Node.js' });
    expect(text).toContain('beel_docs_search');
    expect(text.toLowerCase()).toContain('idempotency');
    expect(text.toLowerCase()).toContain('webhook');
    expect(text).toContain('Node.js');
    // Tool names drop the company scope word, so a beel_*_company_* pattern names nothing.
    expect(text).not.toContain('beel_*_company_*');
  });

  it('throws on an unknown prompt', () => {
    expect(() => getPrompt('nope', {})).toThrow();
  });
});
