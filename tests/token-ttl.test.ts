import { describe, expect, it } from 'vitest';
import { INITIAL_ACCESS_TOKEN_TTL, workerAccessTokenTTL } from '../src/cf/upstream.js';

describe('access token lifetimes', () => {
  it('stays below the upstream token it was derived from', () => {
    for (const upstream of [300, 600, 3600, 86400]) {
      expect(workerAccessTokenTTL(upstream)).toBeLessThan(upstream);
    }
  });

  it('never goes below a minute, however short the upstream token is', () => {
    expect(workerAccessTokenTTL(1)).toBe(60);
    expect(workerAccessTokenTTL(0)).toBe(60);
  });

  it('falls back to the OAuth default hour when expires_in is absent', () => {
    expect(workerAccessTokenTTL(undefined)).toBe(3300);
  });

  // The first token is issued before any refresh has revealed the upstream
  // lifetime, so it must survive the shortest one we could plausibly meet.
  // Spring Authorization Server — what BeeL runs — defaults to five minutes.
  it('issues a first token shorter than a five-minute upstream token', () => {
    expect(INITIAL_ACCESS_TOKEN_TTL).toBeLessThan(300);
  });
});
