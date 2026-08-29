import { describe, expect, it } from 'vitest';
import { appCsp, appOrigin, DEFAULT_APP_ORIGIN, PDFJS_CDN_ORIGIN } from '../src/mcpapp/contract.js';
import { BEEL_DEFAULTS, ENV_VAR } from '../src/shared/defaults.js';

describe('the viewer resolves its own origin', () => {
  it('follows MCP_PUBLIC_URL, so a deployment on another domain still relays', () => {
    // The CSP names the origin the app fetches the PDF bytes from. Naming the
    // wrong one blocks the fetch, and a blocked fetch looks to the app exactly
    // like a failed one — there is no error that says "CSP".
    const env = { [ENV_VAR.publicUrl]: 'https://mcp.example.test/' };
    expect(appOrigin(env)).toBe('https://mcp.example.test');
    expect(appCsp(env).connectDomains).toEqual(['https://mcp.example.test', PDFJS_CDN_ORIGIN]);
  });

  it('falls back to the public BeeL deployment', () => {
    expect(appOrigin({})).toBe(BEEL_DEFAULTS.publicUrl);
    expect(DEFAULT_APP_ORIGIN).toBe(BEEL_DEFAULTS.publicUrl);
  });

  it('lets the app load nothing but pdf.js from outside', () => {
    // The bundle is imported without Subresource Integrity — a dynamic import
    // takes no integrity attribute — so the CSP is the whole boundary.
    expect(appCsp({}).resourceDomains).toEqual([PDFJS_CDN_ORIGIN]);
  });
});
