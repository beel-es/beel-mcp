import type { GetPromptResult, Prompt } from '@modelcontextprotocol/sdk/types.js';

/**
 * Guided workflows as MCP prompts. They encode the *order of operations* a safe
 * agent should follow (validate NIF → choose type → check gates → issue), so the
 * model doesn't skip a fiscal step. The rules themselves come from `beel_rules_list` /
 * `beel_rules_get` (the published catalogue); the prompts only point at them.
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
      'Guided flow to invite a collaborator (gestoría) or teammate to the account with the ' +
      'right role (ADMIN or MEMBER) and, for a member, access per NIF.',
    arguments: [
      { name: 'email', description: 'Email of the person to invite.', required: false },
      { name: 'role', description: 'Intended role: ADMIN or MEMBER.', required: false },
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
      'Guided flow to connect a payment provider (Stripe) to a NIF: list existing ' +
      'connections, initiate, and verify it is active.',
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
              '1. Decide STANDARD (F1) vs SIMPLIFIED (F2) from the `simplified` rules:',
              '   `beel_rules_list` with domain "simplified" (SIM-001, SIM-006 in particular).',
              '2. If F1 to a Spanish recipient, call `beel_validate_nif` first; for an individual,',
              '   the legal_name must match the AEAT census.',
              '3. Set `main_tax.regime_key` per line (default "01"). For exports/OSS/recargo/REBU,',
              '   read the `taxes` and `surcharge` rules (`beel_rules_list` with domain) and use',
              '   `beel_docs_search` for worked payloads.',
              '4. Check the company can issue with `beel_get_issuing_readiness`, and resolve its',
              '   `blockers` first.',
              '5. Create the invoice with `beel_create_invoice`. It is saved as a DRAFT, with no',
              '   number, unless `options.issue_directly` is true; review the draft, then issue it',
              '   with `beel_issue_invoice`, which gives it its number.',
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
              'Help me fix an already-issued invoice. First read the rules with `beel_rules_list`',
              '(domains "void" and "corrective"; VOI-001 and COR-001 decide which), then decide:',
              '',
              '- The operation never took place (issued by mistake, a test, an accidental',
              '  duplicate) → `beel_void_invoice` (VOI-001). An invoice for an operation that did',
              '  happen is never voided to fix it.',
              '- The operation happened but an amount, the VAT or a detail is wrong →',
              '  `beel_create_corrective_invoice` with the right rectification_code (R1–R5) and',
              '  rectification_type (PARTIAL with lines, or TOTAL without).',
              "- Only the recipient's own data is wrong (name, NIF or address of the right",
              '  recipient) → a corrective with the corrected recipient, rectification_type PARTIAL,',
              '  rectification_code R4 and no lines (COR-017). Invoiced to another person',
              '  altogether → a TOTAL corrective and a new invoice to the right customer.',
              '- It carried an IRPF withholding it should not have → not a corrective (COR-024):',
              '  void it and issue it again without the withholding (the exception in VOI-001).',
              '- Pick the rectification_code with `beel_rules_get` id "COR-002".',
              '- A void of a sent or paid invoice needs `issued_in_error: true`, only when it is true.',
              '- The customer of a simplified invoice wants one with their details →',
              '  `beel_create_simplified_exchange`, not a void or a corrective.',
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
              '1. Call `beel_get_setup_status`: it gives my account, every NIF with its',
              '   readiness, blockers, default series, VeriFactu status and tax defaults, the',
              '   `environment` of this session and the next action. Drive the flow from it; do not',
              '   re-read what it already reports.',
              '2. If the NIF is not there yet, validate it with `beel_validate_nif`, read',
              '   `beel://guardrails/multi-nif` and add it with `beel_create_company` (scope',
              '   companies:write).',
              '3. Resolve the `blockers` one by one: they are the source of truth for what is',
              '   missing. A document type with no default series: `beel_set_default_series`',
              '   (blocker SERIES_DEFAULT_NOT_FOUND). VeriFactu: read',
              '   `beel://guardrails/verifactu-gates` and enable it with',
              '   `beel_update_verifactu_configuration` only if this NIF must reach AEAT.',
              '4. Re-check with `beel_get_issuing_readiness` until `ready` is true. Never issue while',
              '   blockers remain.',
              '5. Only then issue a first invoice to confirm the pipeline end to end. In `test`',
              "   it costs nothing; in `live` (the contract's PROD) it is a real fiscal document, so",
              '   confirm with me and issue one you actually mean to send.',
              '6. Payments (optional to issue, needed to get paid): `beel_list_payment_connections`',
              '   and, if none is active, `beel_initiate_payment_connection` for that company.',
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
              '2. Create the invitation with `beel_create_invitation`: their email and the',
              '   `account_role`. OWNER cannot be invited (an account has exactly one); pick:',
              '   - ADMIN: administers the account (NIFs, series, members, settings).',
              '   - MEMBER: works only on the NIFs it is granted.',
              '3. For a MEMBER, grant each NIF it needs with `beel_put_member_grant` (per',
              '   company_id) and `access_level` VIEW (read) or OPERATE (issue and manage). A',
              '   gestoría often needs only some NIFs: grant those, not all of them.',
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
              '1. Confirm the NIF: `beel_get_setup_status` lists every NIF with its company_id and',
              '   blockers; every call below takes that company_id.',
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
              '   `beel_docs_search` "representation" for the exact steps if unsure.',
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
              '1. A connection belongs to one NIF: every call takes its company_id (from',
              '   `beel_get_setup_status` or `beel_list_companies`). Connect each NIF that collects.',
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
              'each area below. Use `beel_rules_list` / `beel_rules_get` for the fiscal rules and',
              '`beel_docs_search` for guides and payloads:',
              '',
              '1. Idempotency: send an Idempotency-Key on invoice creation and other unsafe writes',
              '   so retries never duplicate. Rule LIF-004 (`beel_rules_get`).',
              '2. API-key security: keep beel_sk_live_ keys server-side only, rotate leaked keys,',
              '   and use beel_sk_test_ keys in non-production.',
              '3. Error handling: read the error `code` and request_id, back off on 429/5xx, and',
              '   surface fiscal error codes to the user rather than retrying blindly.',
              '4. Webhook signature verification: verify the signature before trusting a payload.',
              '   Search `beel_docs_search` "webhook signature".',
              '5. Invoice lifecycle: read the `lifecycle`, `void` and `corrective` rules',
              '   (`beel_rules_list` with domain); never mutate an issued invoice in place (LIF-001).',
              '6. Migrate off deprecated endpoints to the company-scoped routes under',
              '   /v1/companies/{company_id}/..., the ones these tools call. Search',
              '   `beel_docs_search` "deprecated".',
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
