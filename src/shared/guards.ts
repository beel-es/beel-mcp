/**
 * Typed guards for values that arrive as `unknown` — API payloads, tool
 * arguments, parsed JSON.
 *
 * They exist so that reading a field is a decision with two visible outcomes:
 * the value is of the expected shape, or it is absent. `String(x ?? '')` has
 * only one outcome and it is always a positive one — an absent id becomes the
 * empty string and travels on into a URL. Every helper here returns
 * `undefined` rather than a substitute value.
 */

/** A non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value at `key` when it is a non-empty string, else `undefined`. */
export function readString(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The value at `key` when it is a boolean, else `undefined`. */
export function readBoolean(source: unknown, key: string): boolean | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** The value at `key` when it is an array, else `undefined`. */
export function readArray(source: unknown, key: string): unknown[] | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return Array.isArray(value) ? value : undefined;
}

/** The entries of `value` that are non-empty strings; `[]` when it is not an array. */
export function stringItems(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

/**
 * Drop the keys whose value is `undefined`.
 *
 * A JSON payload has absent keys, not keys holding `undefined`, and a schema
 * validator reading the object before it is serialised sees the difference.
 * Building a result and then compacting it keeps the two views identical.
 */
export function compact<T extends Record<string, unknown>>(record: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}
