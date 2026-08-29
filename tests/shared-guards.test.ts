import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compact,
  isRecord,
  readArray,
  readBoolean,
  readString,
  stringItems,
} from '../src/shared/guards.js';
import {
  FetchTimeoutError,
  ResponseTooLargeError,
  fetchWithTimeout,
  pLimit,
  readBoundedText,
} from '../src/shared/fetch.js';

describe('typed guards', () => {
  it('treats arrays and null as non-records', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it('returns undefined instead of a substitute value for absent fields', () => {
    expect(readString({ id: 'x' }, 'id')).toBe('x');
    expect(readString({ id: '' }, 'id')).toBeUndefined();
    expect(readString({ id: 7 }, 'id')).toBeUndefined();
    expect(readString(undefined, 'id')).toBeUndefined();
    expect(readBoolean({ ok: false }, 'ok')).toBe(false);
    expect(readBoolean({ ok: 'false' }, 'ok')).toBeUndefined();
    expect(readArray({ xs: [1] }, 'xs')).toEqual([1]);
    expect(readArray({ xs: 1 }, 'xs')).toBeUndefined();
  });

  it('drops undefined keys so the object matches its serialised form', () => {
    expect(compact({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
    expect(Object.keys(compact({ b: undefined }))).toEqual([]);
  });

  it('keeps only non-empty strings out of a mixed array', () => {
    expect(stringItems(['a', '', 1, null, 'b'])).toEqual(['a', 'b']);
    expect(stringItems('a')).toEqual([]);
  });
});

describe('fetchWithTimeout', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('raises a typed timeout when the deadline passes', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(fetchWithTimeout('https://host.test/x', {}, 5)).rejects.toBeInstanceOf(
      FetchTimeoutError,
    );
  });

  it('lets a non-timeout failure through unchanged', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('dns failure');
    });
    await expect(fetchWithTimeout('https://host.test/x', {}, 1000)).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe('bounded body reads', () => {
  it('refuses a body past the ceiling even when content-length lies', async () => {
    const response = new Response('0123456789', { headers: { 'content-length': '2' } });
    await expect(readBoundedText(response, 4)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('refuses on a declared length past the ceiling', async () => {
    const response = new Response('ab', { headers: { 'content-length': '9999' } });
    await expect(readBoundedText(response, 4)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('returns a body within the ceiling', async () => {
    expect(await readBoundedText(new Response('ok'), 16)).toBe('ok');
  });
});

describe('pLimit', () => {
  it('never exceeds the bound and preserves order', async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, (_unused, i) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return i;
    });
    expect(await pLimit(3, tasks)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty task list', async () => {
    expect(await pLimit(4, [])).toEqual([]);
  });
});
