/**
 * Routes the contract quotes in its prose, named as the tools that call them.
 *
 * The contract is written for HTTP clients, so a description says "created via
 * `POST /v1/companies/{company_id}/invoices/{invoice_id}/corrective`". An agent
 * using this server cannot call a route; it calls a tool, and the tool's name
 * is what lets it do so. A quoted route whose method and path are exactly those
 * of a tool becomes that tool's name; any other stays as written. Each tool's
 * own `Endpoint:` line is not quoted, so it keeps the route for people writing
 * HTTP code.
 */

/** A route quoted in prose: a method and a `/v1/…` path between backticks. */
const QUOTED_ROUTE = /`(GET|POST|PUT|PATCH|DELETE) (\/v1\/[^`\s]+)`/g;

export interface RoutedTool {
  name: string;
  method: string;
  path: string;
}

/** A function that rewrites every quoted route of a known tool to that tool's name. */
export function routeNamer(tools: RoutedTool[]): (text: string) => string {
  const byRoute = new Map(tools.map((t) => [`${t.method.toUpperCase()} ${t.path}`, t.name]));
  return (text) =>
    text.replace(QUOTED_ROUTE, (quoted, method: string, path: string) => {
      const name = byRoute.get(`${method} ${path}`);
      return name ? `\`${name}\`` : quoted;
    });
}

/** Apply `rename` to every `description` string in a JSON schema, in place. */
export function renameInDescriptions(schema: unknown, rename: (text: string) => string): void {
  if (Array.isArray(schema)) {
    for (const item of schema) renameInDescriptions(item, rename);
    return;
  }
  if (!schema || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') node[key] = rename(value);
    else renameInDescriptions(value, rename);
  }
}
