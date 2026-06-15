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

function score(chunk: DocChunk, terms: string[]): number {
  const haystack = `${chunk.page}\n${chunk.heading}\n${chunk.content}`.toLowerCase();
  const title = `${chunk.page} ${chunk.heading}`.toLowerCase();
  let total = 0;
  let allHit = true;
  for (const term of terms) {
    const t = term.toLowerCase();
    const occurrences = haystack.split(t).length - 1;
    if (occurrences === 0) allHit = false;
    total += occurrences;
    if (title.includes(t)) total += 5; // title matches weigh more
  }
  if (allHit && terms.length > 1) total *= 2; // reward chunks matching every term
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

/** Render chunks as a single markdown string for tool output. */
export function renderChunks(chunks: DocChunk[]): string {
  if (chunks.length === 0) return 'No matching documentation found.';
  return chunks
    .map((c) => {
      const title = [c.page, c.heading].filter(Boolean).join(' › ');
      return `## ${title}\n\n${c.content}`;
    })
    .join('\n\n---\n\n');
}
