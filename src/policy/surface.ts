import type { Prompt, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ApiTool } from '../tools/api-tools.js';

/**
 * Which tools a session sees. `full` is the whole derived surface; `chatgpt` is
 * the one published in OpenAI's plugin directory, whose review forbids asking
 * for restricted data (government identifiers of a person, bank or card data,
 * credentials and secrets) unless the stated function needs it.
 *
 * The plugin's stated function is invoicing: invoices, customers, products,
 * series, recurring invoices, sending them and the fiscal summary. A customer's
 * NIF stays, but only where the customer is registered or checked
 * (`CHATGPT_IDENTIFIER_OPERATION_IDS`): a full invoice cannot be issued without
 * it (art. 6.1.d RD 1619/2012). Invoices then name the customer by
 * `customer_id`. What the function does not need goes:
 *
 *  - families that hand out or show credentials and secrets (webhook signing
 *    secrets, claim tokens, API key ids in request logs, the bodies of sent
 *    emails, which carry verification and invitation links) or administer
 *    accounts and people (provisioning, members, invitations, access levels);
 *  - the AEAT representation, which carries the representative's identity
 *    document and signature;
 *  - payment provider connections and their events;
 *  - input fields for bank accounts and for the legal representative, with
 *    the definitions, descriptions and examples that mention them;
 *  - prompts for the flows above; only the invoicing ones stay;
 *  - identity documents other than the NIF (passports, foreign IDs), company
 *    set-up and activation (done in the BeeL app) and bulk operations that
 *    hide several operations behind one tool.
 */
export type ToolSurface = 'full' | 'chatgpt';

export const CHATGPT_EXCLUDED_TAGS = new Set([
  'AccountEmails',
  'AccountRequestLogs',
  'Accounts',
  'AccountWebhooks',
  'CompanyPaymentConnections',
  'CompanyPaymentEvents',
  'CompanyRepresentation',
  'Invitations',
  'CompanyActivations',
  'Members',
  'Provisioning',
]);

export const CHATGPT_EXCLUDED_OPERATION_IDS = new Set([
  'createCompany',
  'patchCompanyById',
  'deleteCompanyById',
  'createCompanyCustomersBulk',
  'createCompanyInvoiceBatch',
]);

/** The only operations whose input carries a NIF on the `chatgpt` surface. */
export const CHATGPT_IDENTIFIER_OPERATION_IDS = new Set([
  'createCompanyCustomer',
  'patchCompanyCustomer',
  'validateNif',
]);

/** Prompts a ChatGPT session lists: the invoicing flows. */
export const CHATGPT_PROMPTS = new Set(['issue-invoice', 'fix-invoice']);

/** Input properties removed wherever they appear in a tool's schema. */
export const CHATGPT_REDACTED_PROPERTIES = new Set([
  'iban',
  'swift',
  'payment_iban',
  'payment_swift',
  'default_iban',
  'default_swift',
  'legal_representative',
  'alternative_id',
  'id_otro',
]);

/** Removed, with the prose about them, outside `CHATGPT_IDENTIFIER_OPERATION_IDS`. */
export const CHATGPT_IDENTIFIER_PROPERTIES = new Set(['nif']);

/**
 * Phrases that mention the NIF only in passing, rewritten so the sentence that
 * carries them survives the redaction.
 */
const CHATGPT_PROSE_REWRITES: Array<[RegExp, string]> = [
  [/\s*— its identifier, not its NIF/g, ''],
  [/\bNIF, legal name or trade name\b/g, 'legal name or trade name'],
  [/\bname, NIF or email\b/g, 'name or email'],
  [/\bNIF, legal name and trade name\b/g, 'legal name and trade name'],
];

/**
 * `$defs` whose description no longer holds once the NIF is gone, replaced
 * whole: a recipient without a NIF can only be a registered customer.
 */
const CHATGPT_DEF_DESCRIPTIONS: Record<string, string> = {
  Recipient:
    'Invoice recipient. For a full invoice, register the customer first with ' +
    'beel_create_customer (or find it with beel_list_customers) and send only ' +
    '`customer_id`. Inline recipient data, without `customer_id`, is only for ' +
    'SIMPLIFIED invoices.',
};

function describeDefs(schema: JsonSchema): JsonSchema {
  const defs = schema.$defs as Record<string, JsonSchema> | undefined;
  if (!defs || !Object.keys(CHATGPT_DEF_DESCRIPTIONS).some((name) => name in defs)) return schema;
  return {
    ...schema,
    $defs: Object.fromEntries(
      Object.entries(defs).map(([name, def]) => [
        name,
        name in CHATGPT_DEF_DESCRIPTIONS
          ? { ...def, description: CHATGPT_DEF_DESCRIPTIONS[name] }
          : def,
      ]),
    ),
  };
}

interface Redaction {
  names: Set<string>;
  prose: RegExp;
  rewrites: Array<[RegExp, string]>;
}

const BANK_AND_DOCUMENTS = /\b(iban|swift|passports?|pasaporte)\b/i;

const KEEPS_NIF: Redaction = {
  names: CHATGPT_REDACTED_PROPERTIES,
  prose: BANK_AND_DOCUMENTS,
  rewrites: [],
};

const DROPS_NIF: Redaction = {
  names: new Set([...CHATGPT_REDACTED_PROPERTIES, ...CHATGPT_IDENTIFIER_PROPERTIES]),
  prose: /\b(iban|swift|passports?|pasaporte|nif|cif|dni|nie|tax id)\b/i,
  rewrites: CHATGPT_PROSE_REWRITES,
};

/** The host whose verified OAuth callback puts a session on the `chatgpt` surface. */
export const CHATGPT_ORIGIN = 'chatgpt.com';

/**
 * The surface for the client behind a grant. Only a verified callback counts:
 * the self-asserted DCR name is anyone's to claim, and a client that cannot be
 * told apart keeps the full surface it always had.
 */
export function surfaceForClient(identity: { verified: boolean; origin?: string }): ToolSurface {
  return identity.verified && identity.origin === CHATGPT_ORIGIN ? 'chatgpt' : 'full';
}

type JsonSchema = Record<string, unknown>;

/** A sentence that names a redacted field, or the data it carries. */
function mentionsRedacted(text: string, r: Redaction): boolean {
  return r.prose.test(text) || [...r.names].some((n) => text.includes(n));
}

/**
 * Drop every sentence that mentions a redacted field. The spec wraps prose, so
 * a sentence is read across lines within its paragraph or list item; an item
 * left with nothing keeps its label and points at the app instead, so an enum
 * value never loses its line.
 */
function redactProse(raw: string, r: Redaction): string {
  const text = r.rewrites.reduce((t, [from, to]) => t.replace(from, to), raw);
  if (!mentionsRedacted(text, r)) return text;
  const blocks: string[][] = [];
  for (const line of text.split('\n')) {
    const startsBlock =
      !blocks.length || /^\s*([-*]\s|$)/.test(line) || /^\s*$/.test(blocks.at(-1)!.at(-1)!);
    if (startsBlock) blocks.push([line]);
    else blocks.at(-1)!.push(line);
  }
  return blocks
    .map((block) => {
      const joined = block.map((l, i) => (i ? l.trim() : l)).join(' ');
      if (!mentionsRedacted(joined, r)) return block.join('\n');
      const kept = joined.split(/(?<=[.;])\s+/).filter((s) => !mentionsRedacted(s, r));
      if (kept.length) return kept.join(' ');
      const label = /^(\s*[-*]\s+[^:]+:)/.exec(joined)?.[1];
      // An item about a removed value (an enum member) goes whole.
      if (!label || [...r.names].some((n) => label.includes(`\`${n}\``))) return null;
      return `${label} details configured in the BeeL app.`;
    })
    .filter((block): block is string => block !== null)
    .join('\n');
}

/** Example payloads are data, not schemas: drop the redacted keys wherever they sit. */
function redactData(node: unknown, r: Redaction): unknown {
  if (Array.isArray(node)) return node.map((n) => redactData(n, r));
  if (typeof node === 'string') return redactProse(node, r);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node as JsonSchema)
      .filter(([key]) => !r.names.has(key))
      .map(([key, value]) => [key, redactData(value, r)]),
  );
}

function redact(node: unknown, r: Redaction): unknown {
  if (Array.isArray(node)) return node.map((n) => redact(n, r));
  if (!node || typeof node !== 'object') return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as JsonSchema)
          .filter(([name]) => !r.names.has(name))
          .map(([name, schema]) => [name, redact(schema, r)]),
      );
    } else if ((key === 'required' || key === 'enum') && Array.isArray(value)) {
      out[key] = value.filter((name) => !r.names.has(name as string));
    } else if (key === 'description' && typeof value === 'string') {
      out.description = redactProse(value, r);
    } else if (key === 'example' || key === 'examples' || key === 'default') {
      out[key] = redactData(value, r);
    } else {
      out[key] = redact(value, r);
    }
  }
  return out;
}

/** `$ref` targets under `#/$defs/`, anywhere in `node`. */
function refsIn(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => refsIn(n, out));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as JsonSchema)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/$defs/')) {
        out.add(value.slice('#/$defs/'.length));
      } else refsIn(value, out);
    }
  }
  return out;
}

/**
 * Remove the `$defs` nothing reaches once the redacted properties are gone, so
 * the published schema carries no orphaned IBAN or representative definition.
 */
function pruneDefs(schema: JsonSchema): JsonSchema {
  const defs = schema.$defs as JsonSchema | undefined;
  if (!defs) return schema;
  const { $defs: _, ...root } = schema;
  const reached = new Set<string>();
  let frontier = refsIn(root);
  while (frontier.size) {
    const next = new Set<string>();
    for (const name of frontier) {
      if (reached.has(name) || !(name in defs)) continue;
      reached.add(name);
      for (const ref of refsIn(defs[name])) next.add(ref);
    }
    frontier = next;
  }
  const kept = Object.fromEntries(Object.entries(defs).filter(([name]) => reached.has(name)));
  return Object.keys(kept).length ? { ...root, $defs: kept } : root;
}

function inChatgptSurface({ operation }: ApiTool): boolean {
  if (CHATGPT_EXCLUDED_OPERATION_IDS.has(operation.operationId)) return false;
  return !operation.tags.some((tag) => CHATGPT_EXCLUDED_TAGS.has(tag));
}

/** The API tools a session on `surface` sees, with their schemas redacted. */
export function apiToolsFor(tools: ApiTool[], surface: ToolSurface): ApiTool[] {
  if (surface === 'full') return tools;
  return tools.filter(inChatgptSurface).map((t) => {
    const r = CHATGPT_IDENTIFIER_OPERATION_IDS.has(t.operation.operationId) ? KEEPS_NIF : DROPS_NIF;
    return {
      ...t,
      tool: {
        ...t.tool,
        // The description explains the tool, including what BeeL calls a
        // company (a NIF): only the phrases about searching by NIF change.
        description: r.rewrites.reduce(
          (d, [from, to]) => d.replace(from, to),
          t.tool.description ?? '',
        ),
        inputSchema: pruneDefs(
          r === DROPS_NIF
            ? describeDefs(redact(t.tool.inputSchema, r) as JsonSchema)
            : (redact(t.tool.inputSchema, r) as JsonSchema),
        ) as Tool['inputSchema'],
      },
    };
  });
}

/** The prompts a session on `surface` lists and may get. */
export function promptsFor(prompts: Prompt[], surface: ToolSurface): Prompt[] {
  return surface === 'full' ? prompts : prompts.filter((p) => CHATGPT_PROMPTS.has(p.name));
}
