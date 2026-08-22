/**
 * Parse the llms-full.txt corpus into heading-delimited chunks and rank them by
 * keyword overlap. Pure, in-process, dependency-free — same approach as the CLI.
 */

export interface DocChunk {
  page: string;
  heading: string;
  content: string;
}

/** Split the full docs text into chunks at `# Page` / `## Section` headings. */
export function splitChunks(full: string): DocChunk[] {
  const lines = full.split('\n');
  const chunks: DocChunk[] = [];
  let page = '';
  let heading = '';
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content || heading) chunks.push({ page, heading, content });
    buffer = [];
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) inFence = !inFence;
    if (!inFence) {
      const h1 = line.match(/^# (.+)/);
      const h2 = line.match(/^## (.+)/);
      if (h1) {
        flush();
        page = h1[1]!.trim();
        heading = '';
        continue;
      }
      if (h2) {
        flush();
        heading = h2[1]!.trim();
        continue;
      }
    }
    buffer.push(line);
  }
  flush();
  return chunks.filter((c) => c.content.length > 0);
}

/**
 * Saturation point for term frequency. Beyond a handful of occurrences a term
 * says little more about relevance, so the tenth hit must not weigh like the first.
 */
const TF_SATURATION = 2;

/** A term in the title is strong evidence, and independent of how long the body is. */
const TITLE_WEIGHT = 2;

/** Body length, in characters, treated as "normal" for length normalisation. */
const REFERENCE_LENGTH = 1_500;

/**
 * Below this, a chunk is a heading with a stub under it — a cross-reference or an
 * empty API-reference shell. It matches, but it cannot answer anything.
 */
const MIN_USEFUL_LENGTH = 250;

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Relevance of one chunk to the query terms.
 *
 * Raw term frequency has two failure modes, and this corpus hits both hard.
 * Without **saturation and length normalisation** the single largest section
 * wins nearly every query — the corpus contains a 54 KB reference table that
 * mentions almost every term, and it would bury the answer. Normalise too
 * eagerly and it inverts: near-empty heading stubs float to the top instead,
 * and those answer even less.
 *
 * So the two signals are scored differently. A title hit does not depend on how
 * long the body is, and is not normalised by it. A body hit is saturated and
 * normalised. Chunks too short to contain an answer are damped outright.
 */
function score(chunk: DocChunk, terms: string[]): number {
  const title = `${chunk.page} ${chunk.heading}`.toLowerCase();
  const body = chunk.content.toLowerCase();

  let titleScore = 0;
  let bodyScore = 0;
  let allHit = true;

  for (const term of terms) {
    const needle = term.toLowerCase();
    const inTitle = title.includes(needle);
    const occurrences = countOccurrences(body, needle);

    if (!inTitle && occurrences === 0) {
      allHit = false;
      continue;
    }
    if (inTitle) titleScore += TITLE_WEIGHT;
    // Diminishing returns: 1 hit ≈ 0.33, 5 ≈ 0.71, 50 ≈ 0.96.
    if (occurrences > 0) bodyScore += occurrences / (occurrences + TF_SATURATION);
  }

  if (titleScore === 0 && bodyScore === 0) return 0;

  // Damp long chunks without erasing them: ten times the reference length keeps
  // roughly a third of its body score.
  const lengthPenalty = 1 + Math.log1p(chunk.content.length / REFERENCE_LENGTH);
  let total = titleScore + bodyScore / lengthPenalty;

  // A stub matches but cannot answer; scale it down in proportion to how little
  // it holds rather than dropping it, so it still surfaces when nothing else does.
  if (chunk.content.length < MIN_USEFUL_LENGTH) {
    total *= chunk.content.length / MIN_USEFUL_LENGTH;
  }

  if (allHit && terms.length > 1) total *= 2; // every term present is a strong signal
  return total;
}

/** Top-N chunks by keyword score. */
export function searchChunks(chunks: DocChunk[], terms: string[], limit = 3): DocChunk[] {
  return chunks
    .map((chunk) => ({ chunk, score: score(chunk, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.chunk);
}

/** All chunks belonging to a page whose title matches (case-insensitive contains). */
export function findPage(chunks: DocChunk[], pageTitle: string): DocChunk[] {
  const needle = pageTitle.toLowerCase().trim();
  return chunks.filter((c) => c.page.toLowerCase().includes(needle));
}

/** Parse the llms.txt index into a flat list of `{ title, url }` link entries. */
export function parseIndex(index: string): Array<{ title: string; url: string }> {
  const entries: Array<{ title: string; url: string }> = [];
  for (const line of index.split('\n')) {
    const match = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)/);
    if (match) entries.push({ title: match[1]!.trim(), url: match[2]!.trim() });
  }
  return entries;
}

/**
 * Ceiling on a single rendered chunk. The corpus contains a 54 KB table of error
 * codes; returning it whole would spend more of the model's context than the
 * answer is worth. Truncation is announced so the agent knows to narrow its query
 * rather than assume it read everything.
 */
const MAX_RENDERED_CHARS = 8_000;

/** Render chunks as a single markdown string for tool output. */
export function renderChunks(chunks: DocChunk[]): string {
  if (chunks.length === 0) return 'No matching documentation found.';
  return chunks
    .map((c) => {
      const title = [c.page, c.heading].filter(Boolean).join(' › ');
      const truncated = c.content.length > MAX_RENDERED_CHARS;
      const content = truncated
        ? `${c.content.slice(0, MAX_RENDERED_CHARS)}\n\n[…truncated: this section is ${c.content.length} characters. Search with more specific terms to reach the part you need.]`
        : c.content;
      return `## ${title}\n\n${content}`;
    })
    .join('\n\n---\n\n');
}
