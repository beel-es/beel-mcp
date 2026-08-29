/**
 * Environment access shared by both runtimes. Node exposes `process.env` and the
 * Cloudflare Worker a bindings object; both are string-keyed records, so every
 * module reads them through these helpers instead of branching on the runtime.
 */

export type EnvRecord = Record<string, unknown>;

/** The ambient environment (`process.env` under Node, `{}` inside a Worker). */
export function ambientEnv(): EnvRecord {
  return typeof process !== 'undefined' && process.env ? (process.env as EnvRecord) : {};
}

/** A trimmed, non-empty string variable, or `undefined`. */
export function readEnv(env: EnvRecord, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A variable holding a URL/origin, with its trailing slash removed. */
export function readEnvUrl(env: EnvRecord, name: string, fallback: string): string {
  return stripTrailingSlash(readEnv(env, name) ?? fallback);
}

/** A comma-separated variable as a list of trimmed, lowercased entries. */
export function readEnvList(env: EnvRecord, name: string): string[] {
  const raw = readEnv(env, name);
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** A positive integer variable, falling back when absent or unparseable. */
export function readEnvInt(env: EnvRecord, name: string, fallback: number): number {
  const raw = readEnv(env, name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
