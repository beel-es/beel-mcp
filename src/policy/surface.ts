import type { Tool } from '@modelcontextprotocol/sdk/types.js';
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
 *    secrets, claim tokens, API key ids in request logs) or administer people
 *    (members, invitations, access levels);
 *  - the AEAT representation, which carries the representative's identity
 *    document and signature;
 *  - payment provider connections and their events;
 *  - input fields for bank accounts and for the legal representative.
 */
export type ToolSurface = 'full' | 'chatgpt';

export const CHATGPT_EXCLUDED_TAGS = new Set([
  'AccountRequestLogs',
  'AccountWebhooks',
  'CompanyPaymentConnections',
  'CompanyPaymentEvents',
  'CompanyRepresentation',
  'Invitations',
  'Members',
]);

export const CHATGPT_EXCLUDED_OPERATION_IDS = new Set([
  'provisionAccount',
  'createAccountClaimToken',
  'changeManagedAccountAccessLevel',
  'endAccountManagement',
]);

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
    } else {
      out[key] = redact(value, names);
    }
  }
  return out;
}

function inChatgptSurface({ operation }: ApiTool): boolean {
  if (CHATGPT_EXCLUDED_OPERATION_IDS.has(operation.operationId)) return false;
  return !operation.tags.some((tag) => CHATGPT_EXCLUDED_TAGS.has(tag));
}

/** The API tools a session on `surface` sees, with their schemas redacted. */
export function apiToolsFor(tools: ApiTool[], surface: ToolSurface): ApiTool[] {
  if (surface === 'full') return tools;
  return tools.filter(inChatgptSurface).map((t) => ({
    ...t,
    tool: {
      ...t.tool,
      inputSchema: redact(t.tool.inputSchema, CHATGPT_REDACTED_PROPERTIES) as Tool['inputSchema'],
    },
  }));
}
