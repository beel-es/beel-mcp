import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, readBaseUrl, resolveConfig } from '../src/config.js';

const DEFAULT_BASE = 'https://app.beel.es/api';

function configDirWith(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'beel-config-'));
  writeFileSync(join(dir, 'config.json'), contents);
  return dir;
}

describe('the API base URL must protect the key it carries', () => {
  it('falls back to the public default when unset', () => {
    expect(readBaseUrl({}, 'BEEL_BASE_URL', DEFAULT_BASE)).toBe(DEFAULT_BASE);
  });

  it('accepts https and strips the trailing slash', () => {
    expect(
      readBaseUrl({ BEEL_BASE_URL: 'https://staging.test/api/' }, 'BEEL_BASE_URL', DEFAULT_BASE),
    ).toBe('https://staging.test/api');
  });

  it('refuses plaintext http against a remote host', () => {
    expect(() =>
      readBaseUrl({ BEEL_BASE_URL: 'http://api.example.test' }, 'BEEL_BASE_URL', DEFAULT_BASE),
    ).toThrow(ConfigError);
  });

  it('refuses plaintext loopback unless it is explicitly permitted', () => {
    expect(() =>
      readBaseUrl({ BEEL_BASE_URL: 'http://localhost:8080' }, 'BEEL_BASE_URL', DEFAULT_BASE),
    ).toThrow(/BEEL_ALLOW_INSECURE_BASE_URL/);
    expect(
      readBaseUrl(
        { BEEL_BASE_URL: 'http://127.0.0.1:8080', BEEL_ALLOW_INSECURE_BASE_URL: 'true' },
        'BEEL_BASE_URL',
        DEFAULT_BASE,
      ),
    ).toBe('http://127.0.0.1:8080');
  });

  it('does not let the escape hatch open a remote host', () => {
    expect(() =>
      readBaseUrl(
        { BEEL_BASE_URL: 'http://api.example.test', BEEL_ALLOW_INSECURE_BASE_URL: 'true' },
        'BEEL_BASE_URL',
        DEFAULT_BASE,
      ),
    ).toThrow(ConfigError);
  });

  it('refuses a non-URL and a non-HTTP scheme', () => {
    expect(() =>
      readBaseUrl({ BEEL_BASE_URL: 'app.beel.es' }, 'BEEL_BASE_URL', DEFAULT_BASE),
    ).toThrow(ConfigError);
    expect(() =>
      readBaseUrl({ BEEL_BASE_URL: 'file:///etc/passwd' }, 'BEEL_BASE_URL', DEFAULT_BASE),
    ).toThrow(ConfigError);
  });
});

describe('the CLI config file is validated, not assumed', () => {
  it('reads a well-formed file', () => {
    const dir = configDirWith(JSON.stringify({ testKey: 'beel_sk_test_abc' }));
    expect(resolveConfig({ BEEL_CONFIG_DIR: dir })).toMatchObject({
      apiKey: 'beel_sk_test_abc',
      env: 'test',
      transport: 'stdio',
    });
  });

  it('reports a malformed file instead of pretending no key was configured', () => {
    const dir = configDirWith('{ not json');
    expect(() => resolveConfig({ BEEL_CONFIG_DIR: dir })).toThrow(/not readable JSON/);
  });

  it('reports a wrongly typed key rather than sending it as a string', () => {
    const dir = configDirWith(JSON.stringify({ testKey: 42 }));
    expect(() => resolveConfig({ BEEL_CONFIG_DIR: dir })).toThrow(/"testKey" must be a string/);
  });

  it('reports a file that is not an object', () => {
    const dir = configDirWith('["beel_sk_test_abc"]');
    expect(() => resolveConfig({ BEEL_CONFIG_DIR: dir })).toThrow(/must contain a JSON object/);
  });

  it('still asks for a key when the file holds none', () => {
    const dir = configDirWith(JSON.stringify({ liveKey: 'beel_sk_live_x' }));
    expect(() => resolveConfig({ BEEL_CONFIG_DIR: dir })).toThrow(/No BeeL API key found/);
  });
});

describe('resolveConfig', () => {
  it('classifies the key from the environment and marks the transport', () => {
    expect(
      resolveConfig({ BEEL_API_KEY: 'beel_sk_live_abc', BEEL_CONFIG_DIR: '/nonexistent' }),
    ).toEqual({
      apiKey: 'beel_sk_live_abc',
      env: 'live',
      baseUrl: DEFAULT_BASE,
      transport: 'stdio',
    });
  });

  it('rejects a key that is not a BeeL key', () => {
    expect(() => resolveConfig({ BEEL_API_KEY: 'sk-something-else' })).toThrow(ConfigError);
  });
});
