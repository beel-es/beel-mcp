/**
 * Base64url, the one implementation.
 *
 * Every value the Worker mints for a URL — PKCE verifiers and challenges, state
 * tokens — has to be base64url, and two copies of the three replacements are two
 * places for one of them to be forgotten. A missing `=` strip or an unreplaced
 * `+` produces a value that is still a plausible string and only fails at the
 * other end, so the duplication is not one a test would catch by accident.
 */
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
