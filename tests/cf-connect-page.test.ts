import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  CONNECTOR_DISPLAY_NAME,
  claudeAddConnectorUrl,
  connectPageHandler,
} from '../src/cf/connect-page.js';
import { WORKER_PATH } from '../src/cf/constants.js';

const app = new Hono();
app.get(WORKER_PATH.connect, connectPageHandler);

const page = async (origin: string) => {
  const res = await app.fetch(new Request(`${origin}${WORKER_PATH.connect}`));
  return { res, html: await res.text() };
};

describe('connect page', () => {
  it('builds the Claude deep link that pre-fills the add-connector dialog', () => {
    const link = new URL(claudeAddConnectorUrl('https://mcp.beel.es/mcp'));
    expect(link.origin + link.pathname).toBe('https://claude.ai/customize/connectors');
    expect(link.searchParams.get('modal')).toBe('add-custom-connector');
    expect(link.searchParams.get('connectorName')).toBe(CONNECTOR_DISPLAY_NAME);
    expect(link.searchParams.get('connectorUrl')).toBe('https://mcp.beel.es/mcp');
  });

  it('serves HTML whose links point at the server it was requested from', async () => {
    const { res, html } = await page('https://staging.example.com');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(html).toContain('https://staging.example.com/mcp');
    expect(html).toContain(
      encodeURIComponent('https://staging.example.com/mcp').replace(/%20/g, '+'),
    );
    expect(html).not.toContain('https://mcp.beel.es/mcp');
  });

  it('gives every client its own anchor, #claude included', async () => {
    const { html } = await page('https://mcp.beel.es');
    for (const id of ['claude', 'claude-code', 'chatgpt', 'codex', 'cursor', 'vscode', 'other']) {
      expect(html, id).toContain(`<section id="${id}"`);
      expect(html, id).toContain(`href="#${id}"`);
    }
  });
});
