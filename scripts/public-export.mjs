#!/usr/bin/env node
/**
 * Builds the publishable tree for the public mirror, as a fresh repository with a
 * single commit.
 *
 * The working tree is already free of infrastructure, but git history is not (see
 * INTERNAL.md): earlier revisions carry a KV namespace id, an internal storage
 * hostname and private issue keys. Squashing to one commit is the only way to
 * guarantee those never ship.
 *
 *   node scripts/public-export.mjs /tmp/beel-mcp-public
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Tracked paths that are internal and must not be published. */
const EXCLUDE = [
  'INTERNAL.md',
  'LEARNINGS.md',
  '.github/workflows/sync-spec.yml',
];

/**
 * Values that must not appear in code we author. `openapi/` is exempted from
 * failing the export because it is generated from the API and already published
 * verbatim in the public documentation — but hits there are still reported, since
 * they mean something internal leaked into the contract upstream.
 */
const FORBIDDEN = [
  { pattern: /railway\.app/i, what: 'internal storage host' },
  { pattern: /\bminio\.[a-z]/i, what: 'internal storage host' },
  { pattern: /storage\.beel\./i, what: 'internal storage host' },
  { pattern: /BEE-\d+/, what: 'internal issue key' },
  { pattern: /carlosmgv/i, what: 'private repository owner' },
  { pattern: /"id":\s*"[0-9a-f]{32}"/, what: 'KV namespace id' },
];

/** Generated files: reported, never fatal. */
const GENERATED = (file) => file.startsWith('openapi/');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/public-export.mjs <target-directory>');
  process.exit(1);
}
const dest = resolve(target);

const git = (args, cwd = REPO_ROOT) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// Only tracked files are exported: anything gitignored is by definition local.
// That also means an uncommitted file would be silently omitted, producing an
// export that does not build — so refuse to run against a dirty tree.
const dirty = git(['status', '--porcelain']);
if (dirty) {
  console.error('Refusing to export — the working tree has uncommitted changes:\n');
  console.error(dirty);
  console.error('\nOnly tracked files are exported, so commit first or the export will be incomplete.');
  process.exit(1);
}

const tracked = git(['ls-files']).split('\n').filter(Boolean);
const files = tracked.filter((file) => !EXCLUDE.includes(file));

if (existsSync(dest)) rmSync(dest, { recursive: true });
mkdirSync(dest, { recursive: true });

for (const file of files) {
  const to = join(dest, file);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(REPO_ROOT, file), to);
}

// Scan what is about to be published, not what we think we copied.
const blocking = [];
const reported = [];
for (const file of files) {
  let content;
  try {
    content = readFileSync(join(dest, file), 'utf8');
  } catch {
    continue; // binary or unreadable; nothing to match
  }
  for (const { pattern, what } of FORBIDDEN) {
    const match = content.match(pattern);
    if (!match) continue;
    (GENERATED(file) ? reported : blocking).push(`${file}: ${what} → ${match[0]}`);
  }
}

if (reported.length > 0) {
  console.warn('Note — internal values inside the generated contract (fix upstream):\n');
  for (const item of reported) console.warn(`  ${item}`);
  console.warn('');
}

if (blocking.length > 0) {
  console.error('Refusing to export — internal values found in authored files:\n');
  for (const item of blocking) console.error(`  ${item}`);
  console.error('\nRemove them (infrastructure belongs in environment variables) and retry.');
  process.exit(1);
}

git(['init', '-q', '-b', 'main'], dest);
git(['add', '.'], dest);
git(
  [
    'commit',
    '-q',
    '-m',
    'feat: BeeL MCP server — VeriFactu-compliant invoicing tools for AI agents',
  ],
  dest,
);

console.log(`Exported ${files.length} files to ${dest}`);
console.log('Review it, then: gh repo create beel-es/beel-mcp --public --source=. --push');
