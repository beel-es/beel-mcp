import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatSnapshot, SNAPSHOT_PATH } from '../scripts/sync-sdks.mjs';
import { parseSdkCatalog, SdkCatalogError, type SdkCatalog } from '../src/sdks/catalog.js';
import { clearSdksCache, loadSdks, sdksUrl, snapshotSdkCatalog } from '../src/sdks/fetch.js';
import { RECOMMENDED_STATUS, sdkReport } from '../src/sdks/report.js';

const snapshot = snapshotSdkCatalog();

function stubFetch(impl: (url: string) => Promise<Response>) {
  const mock = vi.fn(async (input: unknown) => impl(String(input)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => clearSdksCache());
afterEach(() => vi.unstubAllGlobals());

describe('the bundled SDK snapshot', () => {
  it('parses as an SDK catalogue with a recommended SDK', () => {
    expect(snapshot.version).toBe(1);
    expect(snapshot.sdks.some((sdk) => sdk.status === RECOMMENDED_STATUS)).toBe(true);
  });

  it('is exactly what `npm run sync:sdks` writes — never edited by hand', () => {
    const text = readFileSync(SNAPSHOT_PATH, 'utf8');
    expect(text).toBe(formatSnapshot(JSON.parse(text)));
  });
});

describe('parseSdkCatalog', () => {
  it('rejects a document without the fields the server reads', () => {
    expect(() => parseSdkCatalog([])).toThrow(SdkCatalogError);
    const broken = structuredClone(snapshot) as unknown as { sdks: Record<string, unknown>[] };
    delete broken.sdks[0]!.install;
    expect(() => parseSdkCatalog(broken)).toThrow(/install/);
  });

  it('rejects a version it does not read, so a breaking change falls back to the snapshot', () => {
    expect(() => parseSdkCatalog({ ...snapshot, version: 2 })).toThrow(/version is 2/);
  });

  it('ignores fields it does not know, so an upstream addition cannot break the server', () => {
    const extended = { ...structuredClone(snapshot), extra: true };
    expect(parseSdkCatalog(extended).sdks).toHaveLength(snapshot.sdks.length);
  });
});

describe('loadSdks', () => {
  it('reads /api/sdks.json under the docs URL, which BEEL_DOCS_URL overrides', async () => {
    expect(sdksUrl({})).toBe('https://docs.beel.es/api/sdks.json');
    const live: SdkCatalog = { ...structuredClone(snapshot), directive: 'Served live.' };
    const mock = stubFetch(async () => new Response(JSON.stringify(live)));
    const { catalog, origin } = await loadSdks({ BEEL_DOCS_URL: 'http://docs.test' });
    expect(origin).toBe('live');
    expect(catalog.directive).toBe('Served live.');
    expect(mock.mock.calls[0]![0]).toBe('http://docs.test/api/sdks.json');
  });

  it('falls back to the bundled snapshot when the fetch fails or the body is not a catalogue', async () => {
    stubFetch(async () => {
      throw new Error('offline');
    });
    expect((await loadSdks({})).origin).toBe('snapshot');
    clearSdksCache();
    stubFetch(async () => new Response(JSON.stringify({ hello: 'world' })));
    const { catalog, origin } = await loadSdks({});
    expect(origin).toBe('snapshot');
    expect(catalog.sdks).toHaveLength(snapshot.sdks.length);
  });
});

describe('sdkReport', () => {
  const report = sdkReport(snapshot);

  it("passes the catalogue's own sentences through word for word", () => {
    expect(report.sdk_guidance).toEqual({
      directive: snapshot.directive,
      fallback: snapshot.fallback.text,
      openapi_url: snapshot.fallback.openapi_url,
    });
  });

  it('gives each SDK its stack markers, install command, and docs and guides as Markdown', () => {
    const recommended = snapshot.sdks.find((sdk) => sdk.status === RECOMMENDED_STATUS)!;
    const entry = report.sdks.find((sdk) => sdk.id === recommended.id)!;
    expect(entry).toEqual({
      id: recommended.id,
      status: RECOMMENDED_STATUS,
      detect: recommended.detect,
      install: recommended.install.command,
      docs: recommended.docs_md_url,
      guides: recommended.guides.map((guide) => guide.md_url),
    });
  });

  it('carries the status note only for an SDK that is not recommended', () => {
    const catalog = structuredClone(snapshot);
    catalog.sdks[0]!.status = RECOMMENDED_STATUS;
    catalog.sdks[0]!.status_note = 'Ignored when recommended.';
    catalog.sdks[1]!.status = 'legacy';
    catalog.sdks[1]!.status_note = 'Call the REST API for now.';
    const [first, second] = sdkReport(catalog).sdks;
    expect(first).not.toHaveProperty('note');
    expect(second!.note).toBe('Call the REST API for now.');
  });

  it('omits docs when the catalogue has no page for the SDK', () => {
    const catalog = structuredClone(snapshot);
    catalog.sdks[0]!.docs_md_url = null;
    catalog.sdks[0]!.docs_url = null;
    expect(sdkReport(catalog).sdks[0]).not.toHaveProperty('docs');
  });
});
