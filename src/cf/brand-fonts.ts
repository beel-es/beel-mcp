/**
 * Serves the BeeL. app's brand fonts (DM Sans, Geist Mono) from this origin.
 *
 * Self-hosted rather than linked from a font CDN, as the website does: a CDN
 * would receive the IP address of every user who opens the app. The files are
 * embedded in the Worker bundle (`Data` rule in wrangler.jsonc) and are public,
 * so any origin may read them; the app's sandbox origin changes per host and
 * per server, and a font request carries no credentials.
 *
 * Licences: assets/beel-app/fonts/*-OFL.txt (SIL Open Font License 1.1).
 */
import type { Context } from 'hono';
import dmSans from '../../assets/beel-app/fonts/dm-sans-latin.woff2';
import geistMono from '../../assets/beel-app/fonts/geist-mono.woff2';
import { BRAND_FONT_FILES, type BrandFontFile } from '../mcpapp/contract.js';

const FONTS: Readonly<Record<BrandFontFile, ArrayBuffer>> = {
  'dm-sans-latin.woff2': dmSans,
  'geist-mono.woff2': geistMono,
};

/** A week: long enough to be free after the first open, short enough to pick up a new cut. */
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function isBrandFont(file: string | undefined): file is BrandFontFile {
  return (BRAND_FONT_FILES as readonly string[]).includes(file ?? '');
}

export function brandFontHandler(c: Context): Response {
  const file = c.req.param('file');
  if (!isBrandFont(file)) return c.notFound() as Response;
  return new Response(FONTS[file], {
    headers: {
      'Content-Type': 'font/woff2',
      'Cache-Control': `public, max-age=${MAX_AGE_SECONDS}`,
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
