/**
 * Close matches for a name that does not exist, so an error can offer the one
 * that was meant instead of a list to read through.
 */

/** Edit distance between two strings (insertions, deletions, substitutions). */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_unused, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Up to `max` candidates close to `wanted`, closest first, ignoring case. A
 * candidate qualifies when one name contains the other or it is within a third
 * of the name's length in edits; all are ranked by edits, so a one-letter typo
 * outranks a shorter name the query happens to contain. Ties keep alphabetical
 * order, so the answer is stable.
 */
export function closestMatches(wanted: string, candidates: string[], max: number): string[] {
  const target = wanted.trim().toLowerCase();
  if (!target) return [];
  const tolerance = Math.max(2, Math.floor(target.length / 3));
  const scored: Array<{ name: string; distance: number }> = [];
  for (const name of candidates) {
    const lower = name.toLowerCase();
    const distance = editDistance(target, lower);
    const contains = lower.includes(target) || target.includes(lower);
    if (contains || distance <= tolerance) scored.push({ name, distance });
  }
  return scored
    .sort((x, y) => x.distance - y.distance || x.name.localeCompare(y.name))
    .slice(0, max)
    .map((entry) => entry.name);
}
