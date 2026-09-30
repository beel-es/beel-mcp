import { decodeJwt } from 'jose';

/**
 * The person behind a BeeL access token (a JWT): its `user_id` claim, else its
 * subject. It keys the OAuth grant and names the user in product analytics, so
 * both see the same id the API does.
 */
export function subjectFromAccessToken(token: string): string | null {
  try {
    const claims = decodeJwt(token);
    const sub = claims.user_id ?? claims.sub;
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null;
  }
}
