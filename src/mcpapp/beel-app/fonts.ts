/// <reference lib="dom" />
/**
 * Declares the brand fonts, served by this server (see cf/brand-fonts.ts). Built
 * from the contract rather than written into the stylesheet, so the origin and
 * the file names have one source.
 */
import { BRAND_FONT_PATH, DEFAULT_APP_ORIGIN, type BrandFontFile } from '../contract.js';

const FACES: ReadonlyArray<{ family: string; file: BrandFontFile; weight: string }> = [
  { family: 'DM Sans', file: 'dm-sans-latin.woff2', weight: '100 1000' },
  { family: 'Geist Mono', file: 'geist-mono.woff2', weight: '100 900' },
];

export function fontFaceCss(origin: string = DEFAULT_APP_ORIGIN): string {
  return FACES.map(
    (f) =>
      `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};` +
      `font-display:swap;src:url("${origin}${BRAND_FONT_PATH}/${f.file}") format("woff2");}`,
  ).join('\n');
}

export function installBrandFonts(doc: Document = document): void {
  const style = doc.createElement('style');
  style.textContent = fontFaceCss();
  doc.head.appendChild(style);
}
