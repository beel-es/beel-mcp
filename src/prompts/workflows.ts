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
      {
        name: 'customer',
        description: 'Who is being billed (name / NIF / country).',
        required: false,
      },
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
  {
    name: 'onboard-nif',
    description:
      'Guided end-to-end setup to get a NIF (company) ready to issue: identity → account → ' +
      'add the NIF → issuing-readiness → default series → VeriFactu gate → payments → first ' +
      'TEST invoice → go Live. Leans on the readiness/status tools instead of guessing.',
    arguments: [
      { name: 'nif', description: 'The NIF/CIF to onboard, if known.', required: false },
      {
        name: 'business_name',
        description: 'Legal or trade name for the NIF, if known.',
        required: false,
      },
    ],
  },
  {
    name: 'invite-member',
    description:
      'Guided flow to invite a collaborator (gestoría) or teammate to the account and grant ' +
      'the right role (OWNER/ADMIN/MEMBER), account-wide or per-NIF.',
    arguments: [
      { name: 'email', description: 'Email of the person to invite.', required: false },
      { name: 'role', description: 'Intended role: OWNER, ADMIN or MEMBER.', required: false },
    ],
  },
  {
    name: 'setup-representation',
    description:
      'Guided flow to set up the AEAT fiscal representation (apoderamiento) a NIF needs to ' +
      'issue Live with VeriFactu: generate the unsigned PDF, download it, sign it, upload the ' +
      'signed copy, and confirm it is valid. Resolves the NIF_REPRESENTATION_REQUIRED blocker.',
    arguments: [
      {
        name: 'company',
        description: 'The NIF/company that needs the representation, if known.',
        required: false,
      },
    ],
  },
  {
    name: 'connect-payments',
    description:
      'Guided flow to connect a payment provider (Stripe): understand per-NIF-with-focus vs ' +
      'account-wide, list existing connections, initiate, and verify it is active.',
    arguments: [
      {
        name: 'company',
        description: 'The NIF/company to connect, if a specific one.',
        required: false,
      },
    ],
  },
  {
    name: 'upgrade-integration',
    description:
      'Update an existing BeeL API integration to current best practices: idempotency, API-key ' +
      'security, error handling, webhook signature verification, invoice lifecycle rules, and ' +
      'migrating off deprecated endpoints to the company-scoped API.',
    arguments: [
      {
        name: 'current_stack',
        description: 'The integration stack/language, if known.',
        required: false,
      },
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
              '5. Create the invoice with `beel_create_invoice` (consider issuing as a draft first',
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
              '- The invoice should never have existed (wrong customer, duplicate) → `beel_void_invoice`.',
              '- The invoice should exist but data is wrong (amount, IVA, NIF, discount, bad debt) →',
              '  `beel_create_corrective_invoice` with the right rectification_code (R1–R5) and',
              '  rectification_type (PARTIAL with lines, or TOTAL without).',
              '- Remember R5 is only for simplified (F2); R1–R4 only for standard (F1).',
              '',
              args.problem
                ? `Problem reported: ${args.problem}`
                : 'Tell me what is wrong with the invoice.',
            ].join('\n'),
          ),
        ],
      };
    }
    case 'onboard-nif': {
      const ctx = [
        args.nif ? `NIF: ${args.nif}` : null,
        args.business_name ? `Business name: ${args.business_name}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        description: 'Onboard a NIF end to end until it can issue Live',
        messages: [
          userMessage(
            [
              'Help me get a NIF operational in BeeL., end to end. Do NOT guess what is missing —',
              'call the readiness/status tools and act on what they report. Follow this order:',
              '',
              '1. Confirm who I am: call `beel_get_my_identity` to get my account_id.',
              '   For a fast picture of every NIF at once, call `beel_get_setup_status` and use',
              '   its checklist and recommended next action to drive the rest of this flow.',
              '2. Choose the account and list its NIFs with `beel_list_companies`. If the NIF is not',
              '   there yet, read `beel://guardrails/multi-nif` and add it with `beel_create_company`',
              '   (scope companies:write). Validate it first with `beel_validate_nif`.',
              '3. Check issuing-readiness with `beel_get_issuing_readiness`: its `blockers`',
              '   list is the source of truth for what is missing. Resolve them one by one.',
              '4. Default series: `beel_get_default_series`; if a document type has no default,',
              '   set it with `beel_set_default_series` (blocker SERIES_DEFAULT_NOT_FOUND).',
              '5. VeriFactu gate: read `beel://guardrails/verifactu-gates`, inspect',
              '   `beel_get_verifactu_configuration`, and enable via',
              '   `beel_update_verifactu_configuration` only if this NIF must reach AEAT.',
              '6. Payments (optional to issue, needed to get paid): `beel_list_payment_connections`',
              '   and, if none active, `beel_initiate_payment_connection`.',
              '7. Issue a first invoice to confirm the pipeline end to end. In a Test session',
              '   `beel_create_invoice` costs nothing; in a Live session it is a real fiscal',
              '   document, so issue one you actually mean to send.',
              '8. Ready to issue: re-run `beel_get_issuing_readiness` until `ready` is true.',
              '   Never issue in a Live session while blockers remain.',
              '',
              ctx ? `Context:\n${ctx}` : 'Ask me for the NIF and business name if you need them.',
            ].join('\n'),
          ),
        ],
      };
    }
    case 'invite-member': {
      const ctx = [
        args.email ? `Invitee email: ${args.email}` : null,
        args.role ? `Intended role: ${args.role}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        description: 'Invite a collaborator or teammate to the account',
        messages: [
          userMessage(
            [
              'Help me invite someone (a gestoría or a teammate) to my BeeL account. Order:',
              '',
              '1. Get my account with `beel_get_my_identity`, then see who is already in with',
              '   `beel_list_members` (avoid inviting an existing member twice).',
              '2. Create the invitation with `beel_create_invitation` for their email.',
              '3. Set the right access with `beel_put_member_grant`. Roles:',
              '   - OWNER: full control incl. billing and ownership transfer (keep this rare).',
              '   - ADMIN: manage NIFs, series, members and settings, but not ownership.',
              '   - MEMBER: day-to-day operation (issue/manage invoices) without account admin.',
              '   Grants can be account-wide or scoped per-NIF — a gestoría often only needs',
              '   specific NIFs, so prefer a per-NIF grant over account-wide when in doubt.',
              '',
              ctx ? `Context:\n${ctx}` : 'Tell me the email and the role you intend to give.',
            ].join('\n'),
          ),
        ],
      };
    }
    case 'setup-representation': {
      return {
        description: 'Set up the AEAT fiscal representation for a NIF',
        messages: [
          userMessage(
            [
              'Help me set up the AEAT fiscal representation (apoderamiento) a NIF needs so BeeL can',
              'submit its invoices to VeriFactu on its behalf. Follow this order:',
              '',
              '1. Confirm the NIF: `beel_get_my_identity`, then `beel_list_companies` to pick the one',
              '   that needs it. Put it in focus if your account manages several.',
              '2. Confirm it is actually required: `beel_get_issuing_readiness`. The',
              '   `NIF_REPRESENTATION_REQUIRED` blocker (only in production — sandbox does not need it)',
              '   is the signal. If it is not there, the NIF may already be represented.',
              '3. Check current state with `beel_get_representation` before creating a new one',
              '   (avoid generating a second document if one is already pending or valid).',
              '4. Generate the unsigned document with `beel_generate_representation`, then',
              '   fetch it with `beel_download_representation_document`.',
              '5. The document must be signed by the NIF holder (digital certificate / autofirma) and',
              '   the SIGNED copy uploaded. Uploading a file is not available over the MCP, so direct',
              '   me to do it in the BeeL web app (the NIF > Representation section). Search',
              '   `beel_docs_search` ["representation"] for the exact steps if unsure.',
              '6. Verify with `beel_get_representation` until its status is valid, then re-run',
              '   `beel_get_issuing_readiness` to confirm the blocker is gone.',
              '   Use `beel_cancel_representation` only to discard a wrong/pending document.',
              '',
              args.company
                ? `Target NIF/company: ${args.company}`
                : 'Tell me which NIF needs the representation.',
            ].join('\n'),
          ),
        ],
      };
    }
    case 'connect-payments': {
      return {
        description: 'Connect a payment provider (Stripe) to a NIF',
        messages: [
          userMessage(
            [
              'Help me connect payments (Stripe) in BeeL. Order:',
              '',
              '1. Decide the scope. Passing a company_id makes the connection per-NIF; without',
              '   one it applies account-wide. Pick per-NIF when a specific NIF collects the',
              '   money, account-wide when one provider serves every NIF.',
              '2. List what already exists with `beel_list_payment_connections` to avoid',
              '   duplicating a connection.',
              '3. Start the connection with `beel_initiate_payment_connection` and complete the',
              '   provider onboarding it returns.',
              '4. Verify it is active by re-running `beel_list_payment_connections` and',
              '   checking the connection `status`.',
              '',
              args.company
                ? `Target NIF/company: ${args.company}`
                : 'Tell me which NIF should collect the payments.',
            ].join('\n'),
          ),
        ],
      };
    }
    case 'upgrade-integration': {
      return {
        description: 'Bring an existing BeeL integration up to current best practices',
        messages: [
          userMessage(
            [
              'Help me update an existing BeeL API integration to current best practices. Review',
              'each area below, and use `beel_docs_search` for the exact rules and payloads:',
              '',
              '1. Idempotency: send an Idempotency-Key on invoice creation and other unsafe writes',
              '   so retries never duplicate. Search `beel_docs_search` ["idempotency"].',
              '2. API-key security: keep beel_sk_live_ keys server-side only, rotate leaked keys,',
              '   and use beel_sk_test_ keys in non-production.',
              '3. Error handling: read the error `code` and request_id, back off on 429/5xx, and',
              '   surface fiscal error codes to the user rather than retrying blindly.',
              '4. Webhook signature verification: verify the signature before trusting a payload.',
              '   Search `beel_docs_search` ["webhook", "signature"].',
              '5. Invoice lifecycle: respect the state machine — read `beel://guardrails/invoice-state-machine`',
              '   and `beel://guardrails/cancel-vs-rectify`; never mutate an issued invoice in place.',
              '6. Migrate off deprecated endpoints to the company-scoped API (the beel_*_company_*',
              '   tools under /v1/companies/{company_id}/...). Search `beel_docs_search` ["deprecated"].',
              '',
              args.current_stack
                ? `Current stack: ${args.current_stack}`
                : 'Tell me your stack/language so I can be specific.',
            ].join('\n'),
          ),
        ],
      };
    }
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}
