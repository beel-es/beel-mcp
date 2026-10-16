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
 * NIF stays: a full invoice cannot be issued without it (art. 6.1.d RD
 * 1619/2012). What the function does not need goes:
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
 *  - prompts for the flows above; only the invoicing ones stay.
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
  'Members',
  'Provisioning',
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
]);

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

/** A sentence that names a redacted field, or the bank details it carries. */
function mentionsRedacted(text: string, names: Set<string>): boolean {
  return /\b(iban|swift)\b/i.test(text) || [...names].some((n) => text.includes(n));
}

/**
 * Drop every sentence that mentions a redacted field. The spec wraps prose, so
 * a sentence is read across lines within its paragraph or list item; an item
 * left with nothing keeps its label and points at the app instead, so an enum
 * value never loses its line.
 */
function redactProse(text: string, names: Set<string>): string {
  if (!mentionsRedacted(text, names)) return text;
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
      if (!mentionsRedacted(joined, names)) return block.join('\n');
      const kept = joined.split(/(?<=[.;])\s+/).filter((s) => !mentionsRedacted(s, names));
      if (kept.length) return kept.join(' ');
      const label = /^(\s*[-*]\s+[^:]+:)/.exec(joined)?.[1];
      return label ? `${label} details configured in the BeeL app.` : null;
    })
    .filter((block): block is string => block !== null)
    .join('\n');
}

/** Example payloads are data, not schemas: drop the redacted keys wherever they sit. */
function redactData(node: unknown, names: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => redactData(n, names));
  if (typeof node === 'string') return redactProse(node, names);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node as JsonSchema)
      .filter(([key]) => !names.has(key))
      .map(([key, value]) => [key, redactData(value, names)]),
  );
}

function redact(node: unknown, names: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => redact(n, names));
  if (!node || typeof node !== 'object') return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as JsonSchema)
          .filter(([name]) => !names.has(name))
          .map(([name, schema]) => [name, redact(schema, names)]),
      );
    } else if (key === 'required' && Array.isArray(value)) {
      out.required = value.filter((name) => !names.has(name as string));
    } else if (key === 'description' && typeof value === 'string') {
      out.description = redactProse(value, names);
    } else if (key === 'example' || key === 'examples' || key === 'default') {
      out[key] = redactData(value, names);
    } else {
      out[key] = redact(value, names);
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
  return !operation.tags.some((tag) => CHATGPT_EXCLUDED_TAGS.has(tag));
}

/** The API tools a session on `surface` sees, with their schemas redacted. */
export function apiToolsFor(tools: ApiTool[], surface: ToolSurface): ApiTool[] {
  if (surface === 'full') return tools;
  return tools.filter(inChatgptSurface).map((t) => ({
    ...t,
    tool: {
      ...t.tool,
      inputSchema: pruneDefs(
        redact(t.tool.inputSchema, CHATGPT_REDACTED_PROPERTIES) as JsonSchema,
      ) as Tool['inputSchema'],
    },
  }));
}

/** The prompts a session on `surface` lists and may get. */
export function promptsFor(prompts: Prompt[], surface: ToolSurface): Prompt[] {
  return surface === 'full' ? prompts : prompts.filter((p) => CHATGPT_PROMPTS.has(p.name));
}
