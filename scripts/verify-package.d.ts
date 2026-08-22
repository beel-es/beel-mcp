/**
 * Types for the packaging checks, which are plain JavaScript because they run
 * from npm scripts in both pipelines. Declared here so the test suite can import
 * them under the project's strict settings.
 */
declare module '*/verify-package.mjs' {
  interface PackedFile {
    path: string;
  }
  interface PackedEntry {
    files: PackedFile[];
    size?: number;
  }
  /** Pull the single package entry out of `npm pack --json`, whatever its shape. */
  export function readPackedEntry(parsed: unknown): PackedEntry;
  /** Everything wrong with the package as it stands, in the order found. */
  export function findProblems(
    pkg: { bin?: Record<string, string> },
    shipped: Set<string>,
  ): string[];
}
