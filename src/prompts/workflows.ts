import type { GetPromptResult, Prompt } from '@modelcontextprotocol/sdk/types.js';

/**
 * Guided workflows as MCP prompts. They encode the *order of operations* a safe
 * agent should follow (validate NIF → choose type → check gates → issue), so the
 * model doesn't skip a fiscal step. The heavy detail stays in the guardrails and docs.
 */

export const prompts: Prompt[] = [
  {
    name: 'issue-invoice',
    description:
      'Guided flow to issue a compliant invoice: pick F1 vs F2, validate the NIF, set ' +
      'regime keys, and check the VeriFactu gates before issuing.',
    arguments: [
      { name: 'customer', description: 'Who is being billed (name / NIF / country).', required: false },
      { name: 'amount', description: 'Approximate total including IVA.', required: false },
      { name: 'concept', description: 'What is being invoiced.', required: false },
    ],
  },
  {
    name: 'fix-invoice',
    description:
      'Decide how to fix an already-issued invoice: void (anulación) vs corrective ' +
      '(rectificativa R1–R5), and apply it correctly.',
    arguments: [
      { name: 'problem', description: 'What is wrong with the invoice.', required: false },
    ],
  },
];

function userMessage(text: string): GetPromptResult['messages'][number] {
  return { role: 'user', content: { type: 'text', text } };
}

export function getPrompt(name: string, args: Record<string, string>): GetPromptResult {
  switch (name) {
    case 'issue-invoice': {
      const ctx = [
        args.customer ? `Customer: ${args.customer}` : null,
        args.amount ? `Approx total (IVA incl.): ${args.amount}` : null,
        args.concept ? `Concept: ${args.concept}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        description: 'Issue a compliant BeeL invoice',
        messages: [
          userMessage(
            [
              'Help me issue a compliant invoice through the BeeL API. Follow this order:',
              '',
              '1. Read the `beel://guardrails/invoice-types` resource. Decide STANDARD (F1) vs',
              '   SIMPLIFIED (F2): F2 only if recipient unidentified AND total ≤ 3 000 €.',
              '2. If F1 to a Spanish recipient, call `beel_validate_nif` first; for an individual,',
              '   the legal_name must match the AEAT census.',
              '3. Set `main_tax.regime_key` per line (default "01"). For exports/OSS/recargo/REBU,',
              '   check `beel://guardrails/regime-keys` and `beel_docs_search` for the exact pairing.',
              '4. Confirm the VeriFactu gates (`beel://guardrails/verifactu-gates`) before issuing if',
              '   the invoice must reach AEAT.',
              '5. Create the invoice with `beel_create_company_invoice` (consider issuing as a draft first',
              '   to review). Never reuse a serie+número.',
              '',
              ctx ? `Context:\n${ctx}` : 'Ask me for any missing details before issuing.',
            ].join('\n'),
          ),
        ],
      };
    }
    case 'fix-invoice': {
      return {
        description: 'Fix an issued BeeL invoice',
        messages: [
          userMessage(
            [
              'Help me fix an already-issued invoice. First read',
              '`beel://guardrails/cancel-vs-rectify`, then decide:',
              '',
              '- The invoice should never have existed (wrong customer, duplicate) → `beel_void_company_invoice`.',
              '- The invoice should exist but data is wrong (amount, IVA, NIF, discount, bad debt) →',
              '  `beel_create_corrective_invoice` with the right rectification_code (R1–R5) and',
              '  rectification_type (PARTIAL with lines, or TOTAL without).',
              '- Remember R5 is only for simplified (F2); R1–R4 only for standard (F1).',
              '',
              args.problem ? `Problem reported: ${args.problem}` : 'Tell me what is wrong with the invoice.',
            ].join('\n'),
          ),
        ],
      };
    }
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}
