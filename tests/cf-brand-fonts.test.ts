import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { brandFontHandler } from '../src/cf/brand-fonts.js';
import { BRAND_FONT_FILES, BRAND_FONT_PATH } from '../src/mcpapp/contract.js';

const app = new Hono();
app.get(`${BRAND_FONT_PATH}/:file`, brandFontHandler);

const get = (file: string) =>
  app.fetch(new Request(`https://mcp.beel.es${BRAND_FONT_PATH}/${file}`));

describe('brand fonts', () => {
  it('serves each font as public, cacheable woff2 any app origin can read', async () => {
    for (const file of BRAND_FONT_FILES) {
      const res = await get(file);
      expect(res.status, file).toBe(200);
      expect(res.headers.get('content-type')).toBe('font/woff2');
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('cache-control')).toMatch(/^public, max-age=\d+$/);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // "wOF2": the file is a real woff2, not an empty stub.
      expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('wOF2');
    }
  });

  it('serves nothing else from that path', async () => {
    expect((await get('other.woff2')).status).toBe(404);
    expect((await get('..%2Fwrangler.jsonc')).status).toBe(404);
  });
});
