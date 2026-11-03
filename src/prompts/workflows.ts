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
    name: 'fix-rejection',
    description:
      'Act on an invoice AEAT rejected or accepted with errors: read submission_status and ' +
      'error_code, find who has to act (recipient data, issuer setup, content, records, ' +
      'temporary) and apply the fix that family calls for.',
    arguments: [
      {
        name: 'invoice',
        description: 'The invoice ID, or its number, if known.',
        required: false,
      },
    ],
  },
  {
    name: 'go-live-checklist',
    description:
      'Check a NIF before its first Live invoice: readiness blockers, signed representation, ' +
      'VeriFactu enabled, series continuing the previous numbering, activation and Live ' +
      'webhooks. Reports what is missing instead of guessing.',
    arguments: [
      {
        name: 'company',
        description: 'The NIF/company going Live, if known.',
        required: false,
      },
      {
        name: 'last_number',
        description: 'The last invoice number issued with the previous system, if any.',
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
              '2. If F1 to a Spanish recipient, register (or reuse) the customer: creating it checks',
              '   the NIF against the AEAT census, and for an individual the legal_name must match.',
              '3. Set `main_tax.regime_key` per line (default "01"). For exports/OSS/recargo/REBU,',
              '   read the `taxes` and `surcharge` rules (`beel_rules_list` with domain) and use',
              '   `beel_docs_search` for worked payloads.',
              '4. Check issuing readiness (`beel://guardrails/verifactu-gates`) before issuing if',
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
              'Help me fix an already-issued invoice. First read the rules with `beel_rules_list`',
              '(domains "void" and "corrective"; VOI-001 and COR-001 decide which), then decide:',
              '',
              '- The invoice should never have existed (wrong customer, duplicate) → `beel_void_invoice`.',
              '- The invoice should exist but data is wrong (amount, IVA, NIF, discount, bad debt) →',
              '  `beel_create_corrective_invoice` with the right rectification_code (R1–R5) and',
              '  rectification_type (PARTIAL with lines, or TOTAL without).',
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
    case 'fix-rejection': {
      return {
        description: 'Act on an AEAT rejection',
        messages: [
          userMessage(
            [
              'Help me resolve an invoice AEAT rejected or flagged. Rule REC-008 (`beel_rules_get`).',
              'Decide from `submission_status` and `error_code` only: never parse `error_message`,',
              'which is for humans. Follow this order:',
              '',
              '1. Read the invoice with `beel_get_invoice` (its `verifactu` block), or find the',
              '   affected ones with `beel_list_invoices` filtered by `verifactu_status` REJECTED.',
              '   `beel_list_invoice_verifactu_records` shows each record (registration and',
              '   cancellation) with its own status.',
              '2. PENDING: BeeL is still retrying a temporary AEAT error. Do nothing yet.',
              '3. ACCEPTED with an `error_code`: the invoice is registered and valid; do not',
              '   resubmit. Check the flagged data (usually the recipient NIF and legal name) and,',
              '   if it was wrong, fix the customer with `beel_patch_customer` so the next invoices',
              '   carry it right.',
              '4. REJECTED: act by the family of `error_code`:',
              '   - Recipient data (1109, 1110, 1123, 1193, 1149): check the NIF with',
              '     `beel_validate_nif` and fix the customer. Not a corrective: the rejected invoice',
              "     is not in AEAT's registry (COR-022, CNT-020).",
              '   - Issuer setup (4104, 4107, 4109, 4112): the invoice is fine, the NIF is not set up',
              '     with AEAT. Resolve it (register the NIF, or run the `setup-representation`',
              '     prompt) and then contact BeeL support with the invoice ID.',
              '   - Suspended access (4141): only AEAT can lift it; then contact BeeL support.',
              '   - Records (3000 to 3003): do not reissue; contact BeeL support to reconcile.',
              '   - Invoice content (1100, 1106, 1108, 1124, 1112, 1133, 1145, 1152): issue a',
              '     corrective with `beel_create_corrective_invoice` (run `fix-invoice` to pick it).',
              '   - Record format (4102, 4103, 4119): contact BeeL support with the invoice ID.',
              '   - REJECTED with no `error_code`: read `error_message` to the user and contact',
              '     BeeL support; for a number already taken, search `beel_docs_search`',
              '     "handling rejections".',
              '   - A code not listed here: `beel_docs_search` "handling rejections", and if it is',
              '     not there either, contact BeeL support. Do not guess.',
              '5. Never edit or delete the issued invoice (LIF-001).',
              '',
              args.invoice
                ? `Invoice: ${args.invoice}`
                : 'Tell me which invoice, or I will list the rejected ones.',
            ].join('\n'),
          ),
        ],
      };
    }
    case 'go-live-checklist': {
      const ctx = [
        args.company ? `NIF/company: ${args.company}` : null,
        args.last_number
          ? `Last number issued with the previous system: ${args.last_number}`
          : null,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        description: 'Check a NIF before its first Live invoice',
        messages: [
          userMessage(
            [
              'Help me check a NIF before its first invoice in Live. Report each item as done or',
              'missing, with the tool result that shows it; do not fix anything Live without my',
              'confirmation. Order:',
              '',
              '1. Overview: `beel_get_setup_status`, then `beel_get_issuing_readiness` for the NIF.',
              '   Its `blockers` list is the source of truth.',
              '2. Representation (REC-011): `beel_get_representation` must be valid. If not, run',
              '   the `setup-representation` prompt; the holder signs it, nobody else.',
              '3. VeriFactu: `beel_get_verifactu_configuration` must be enabled in this Live',
              '   session; `beel_update_verifactu_configuration` registers the NIF with AEAT.',
              '4. Numbering (NUM-003, NUM-007): `beel_list_series` and `beel_get_default_series`.',
              '   If the NIF issued invoices with another system, its series must continue that',
              '   numbering (`initial_number`, `counter_reset`) before the first Live issue: a',
              '   series cannot be renumbered afterwards. `beel_docs_search` "continuing a',
              '   sequence" has the steps.',
              '5. Activation: `beel_activate_company` switches the NIF on in Live, and every NIF',
              '   on in Live is billed. Confirm with me before calling it.',
              '6. Webhooks: `beel_list_webhook_subscriptions` from this Live session. Test',
              '   subscriptions do not receive Live events.',
              '7. When `beel_get_issuing_readiness` reports `ready`, the first Live invoice is a',
              '   real fiscal document: issue only one I actually mean to send (LIF-003).',
              '',
              ctx || 'Tell me which NIF is going Live.',
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
              '6. Migrate off deprecated endpoints to the company-scoped API (the beel_*_company_*',
              '   tools under /v1/companies/{company_id}/...). Search `beel_docs_search` "deprecated".',
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
