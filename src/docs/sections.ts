/**
 * A documentation page split by its Markdown headings, so an agent can read the
 * part that answers instead of the whole page. An API reference page runs to
 * tens of KB (parameters, request body, one block per response, the schemas it
 * uses); the question usually lives in one of those blocks.
 *
 * A section is addressed by its anchor — the slug the docs site gives the
 * heading, the same one a search result's `url` carries after `#` — or by its
 * title. It runs to the next heading of the same or a higher level, so asking
 * for "Responses" brings every response, and "422" only that one.
 */

export interface Heading {
  depth: number;
  title: string;
  anchor: string;
  /** Line index of the heading. */
  line: number;
}

/** Pages up to this size are returned whole; larger ones answer with their outline. */
export const OUTLINE_THRESHOLD_CHARS = 8_000;
/** Most of the introduction an outline carries. */
const INTRO_CHARS = 1_500;
/** Longest heading title an outline line shows. */
const OUTLINE_TITLE_CHARS = 90;
/** Longest anchor an outline line shows; a prefix of an anchor still finds its section. */
const OUTLINE_ANCHOR_CHARS = 60;

/** The slug the docs site gives a heading: lowercase, punctuation dropped, spaces to hyphens. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Every heading outside fenced code, with a unique anchor (repeats get -1, -2…). */
export function parseHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  markdown.split('\n').forEach((raw, line) => {
    const fenceMatch = /^\s*(```|~~~)/.exec(raw);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (fenceMatch[1] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (!match) return;
    const title = match[2]!;
    const base = slugify(title);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({
      depth: match[1]!.length,
      title,
      anchor: count === 0 ? base : `${base}-${count}`,
      line,
    });
  });
  return headings;
}

/**
 * The heading `wanted` names: its exact anchor, then its exact title, then the
 * first anchor that starts with it (a search result's `#cor-024` for the
 * heading «COR-024 · …»), then the first title that contains it.
 */
export function findHeading(headings: Heading[], wanted: string): Heading | undefined {
  const raw = wanted.trim().replace(/^#+/, '').trim();
  const slug = slugify(raw);
  const lower = raw.toLowerCase();
  if (!slug && !lower) return undefined;
  return (
    headings.find((h) => h.anchor === slug) ??
    headings.find((h) => h.title.toLowerCase() === lower) ??
    headings.find((h) => slug !== '' && h.anchor.startsWith(slug)) ??
    headings.find((h) => h.title.toLowerCase().includes(lower))
  );
}

/** The heading and its body, up to the next heading of the same or a higher level. */
export function extractSection(markdown: string, headings: Heading[], heading: Heading): string {
  const lines = markdown.split('\n');
  const next = headings.find((h) => h.line > heading.line && h.depth <= heading.depth);
  return lines
    .slice(heading.line, next ? next.line : lines.length)
    .join('\n')
    .trimEnd();
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The text before the first heading after the title: what the page is about. */
function introduction(markdown: string, headings: Heading[]): string {
  const lines = markdown.split('\n');
  const start = headings[0]?.depth === 1 && headings[0].line === firstContentLine(lines) ? 1 : 0;
  const end = headings[start]?.line ?? lines.length;
  return cut(lines.slice(0, end).join('\n').trim(), INTRO_CHARS);
}

function firstContentLine(lines: string[]): number {
  const index = lines.findIndex((l) => l.trim() !== '');
  return index < 0 ? 0 : index;
}

/**
 * What a long page answers with when no section is asked for: its introduction,
 * the sections with their anchors, and how to read one.
 */
export function renderOutline(page: string, markdown: string, headings: Heading[]): string {
  const minDepth = Math.min(...headings.map((h) => h.depth));
  const outline = headings.map(
    (h) =>
      `${'  '.repeat(h.depth - minDepth)}- ${cut(h.title, OUTLINE_TITLE_CHARS)} ` +
      `[${cut(h.anchor, OUTLINE_ANCHOR_CHARS).replace(/…$/, '')}]`,
  );
  return [
    introduction(markdown, headings),
    '',
    `This page is ${markdown.length} characters, so only its sections are listed ` +
      `(anchor in brackets). Read one with beel_docs_get, page "${page}" and section ` +
      'set to its anchor or title; a section runs to the next heading of its level.',
    '',
    ...outline,
  ].join('\n');
}
