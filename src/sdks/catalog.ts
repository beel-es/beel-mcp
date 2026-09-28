/**
 * The catalogue of official BeeL SDKs, as the documentation site publishes it at
 * `/api/sdks.json`: which SDK serves which stack, how to install it, whether it
 * is recommended, and the guides written against it.
 *
 * This file only describes and checks the shape. Which SDKs exist and what is
 * said about them comes from the published catalogue, so the server and the
 * documentation cannot disagree. As with the rules catalogue, the parser is
 * strict about the fields the server reads and ignores the rest.
 */

import { isRecord } from '../shared/guards.js';

/** The catalogue version this parser reads; a breaking change upstream bumps it. */
export const SDK_CATALOG_VERSION = 1;

export interface SdkGuide {
  url: string;
  md_url: string;
}

export interface Sdk {
  id: string;
  name: string;
  languages: string[];
  runtime: string;
  /** `recommended`, or `legacy` for an SDK the catalogue says not to start with. */
  status: string;
  status_note: string | null;
  /** Files whose presence in a project marks its stack, e.g. `package.json`. */
  detect: string[];
  package: { registry: string; name: string; url: string };
  install: { tool: string; command: string };
  docs_url: string | null;
  docs_md_url: string | null;
  guides: SdkGuide[];
}

export interface SdkCatalog {
  version: number;
  /** The sentence that says to use the SDK for the project's stack. */
  directive: string;
  /** What to do when no SDK fits the stack. */
  fallback: { text: string; openapi_url: string };
  sdks: Sdk[];
}

/** Raised when a document does not have the catalogue's shape. */
export class SdkCatalogError extends Error {
  constructor(problems: string[]) {
    super(`Not a valid SDK catalogue: ${problems.slice(0, 5).join('; ')}`);
    this.name = 'SdkCatalogError';
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringOrNull = (v: unknown): boolean => v === null || isString(v);
const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every(isString);

function sdkProblems(sdk: unknown, index: number): string[] {
  if (!isRecord(sdk)) return [`sdks[${index}] is not an object`];
  const where = `sdks[${index}]${isString(sdk.id) ? ` (${sdk.id})` : ''}`;
  const problems: string[] = [];
  for (const field of ['id', 'name', 'runtime', 'status'] as const) {
    if (!isString(sdk[field])) problems.push(`${where}.${field} is not a string`);
  }
  for (const field of ['status_note', 'docs_url', 'docs_md_url'] as const) {
    if (!isStringOrNull(sdk[field])) problems.push(`${where}.${field} is not a string or null`);
  }
  for (const field of ['languages', 'detect'] as const) {
    if (!isStringArray(sdk[field])) problems.push(`${where}.${field} is not a list of strings`);
  }
  const pkg = sdk.package;
  if (!isRecord(pkg) || !isString(pkg.registry) || !isString(pkg.name) || !isString(pkg.url)) {
    problems.push(`${where}.package lacks registry/name/url`);
  }
  const install = sdk.install;
  if (!isRecord(install) || !isString(install.tool) || !isString(install.command)) {
    problems.push(`${where}.install lacks tool/command`);
  }
  if (!Array.isArray(sdk.guides)) problems.push(`${where}.guides is not an array`);
  else {
    sdk.guides.forEach((guide, i) => {
      if (!isRecord(guide) || !isString(guide.url) || !isString(guide.md_url)) {
        problems.push(`${where}.guides[${i}] lacks url/md_url`);
      }
    });
  }
  return problems;
}

/** Check a parsed document and return it typed, or throw {@link SdkCatalogError}. */
export function parseSdkCatalog(doc: unknown): SdkCatalog {
  if (!isRecord(doc)) throw new SdkCatalogError(['the document is not an object']);
  const problems: string[] = [];
  if (doc.version !== SDK_CATALOG_VERSION) {
    problems.push(`version is ${String(doc.version)}, this server reads ${SDK_CATALOG_VERSION}`);
  }
  if (!isString(doc.directive)) problems.push('directive is not a string');
  const fallback = doc.fallback;
  if (!isRecord(fallback) || !isString(fallback.text) || !isString(fallback.openapi_url)) {
    problems.push('fallback lacks text/openapi_url');
  }
  if (!Array.isArray(doc.sdks) || doc.sdks.length === 0) problems.push('no sdks');
  else doc.sdks.forEach((sdk, i) => problems.push(...sdkProblems(sdk, i)));
  if (problems.length > 0) throw new SdkCatalogError(problems);
  return doc as unknown as SdkCatalog;
}
