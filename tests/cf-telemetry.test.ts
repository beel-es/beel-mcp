import { describe, expect, it } from 'vitest';
import { scrubSentryEvent, type ScrubbableEvent } from '../src/cf/telemetry.js';

const TOKEN_URL = 'https://app.beel.es/api/oauth2/token';

describe('error events carry no credential out of the Worker', () => {
  it('drops the authorization and cookie headers whatever their case', () => {
    const event = scrubSentryEvent(
      {
        request: {
          headers: { Authorization: 'Bearer secret', cookie: 'session=x', 'X-Trace': 'keep' },
        },
      },
      [TOKEN_URL],
    );
    expect(event.request?.headers).toEqual({ 'X-Trace': 'keep' });
  });

  it('drops the query string, which carries code and state', () => {
    const event: ScrubbableEvent = { request: { query_string: 'code=abc&state=xyz' } };
    expect(scrubSentryEvent(event, [TOKEN_URL]).request?.query_string).toBeUndefined();
  });

  it('drops the request body, which on a token exchange is the secret itself', () => {
    const event: ScrubbableEvent = {
      request: { data: 'grant_type=refresh_token&refresh_token=rt' },
    };
    expect(scrubSentryEvent(event, [TOKEN_URL]).request?.data).toBeUndefined();
  });

  it('drops breadcrumbs that mention a sensitive URL, keeping the rest', () => {
    const event: ScrubbableEvent = {
      breadcrumbs: [
        { message: 'fetch', data: { url: TOKEN_URL, status_code: 401 } },
        { message: `POST ${TOKEN_URL}` },
        { message: 'fetch', data: { url: 'https://app.beel.es/api/invoices' } },
      ],
    };
    const kept = scrubSentryEvent(event, [TOKEN_URL]).breadcrumbs ?? [];
    expect(kept).toHaveLength(1);
    expect(kept[0]!.data?.url).toBe('https://app.beel.es/api/invoices');
  });

  it('leaves an event with nothing sensitive untouched', () => {
    const event: ScrubbableEvent = { request: { headers: { 'X-Trace': 'keep' } } };
    expect(scrubSentryEvent(event, [TOKEN_URL])).toEqual(event);
  });
});
