/**
 * Quick open's file ranking (Cmd/Ctrl+P): a subsequence match of the query
 * in the path, scored higher for matches in the file name, at word starts
 * and in contiguous runs, and for shorter paths. -1 when it does not match.
 */
export function fuzzyScore(path: string, query: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const p = path.toLowerCase();
  const nameStart = p.lastIndexOf("/") + 1;
  // Try matching inside the file name first, then anywhere.
  const attempt = (from: number) => {
    let score = 0;
    let pi = from;
    let run = 0;
    for (let qi = 0; qi < q.length; qi += 1) {
      const ch = q[qi]!;
      const found = p.indexOf(ch, pi);
      if (found < 0) return -1;
      const prev = found > 0 ? p[found - 1]! : "/";
      const wordStart = prev === "/" || prev === "." || prev === "-" || prev === "_" || prev === " ";
      run = found === pi && qi > 0 ? run + 1 : 0;
      score += 1 + run * 3 + (wordStart ? 4 : 0) + (found >= nameStart ? 2 : 0);
      pi = found + 1;
    }
    return score;
  };
  const inName = attempt(nameStart);
  const anywhere = attempt(0);
  const best = Math.max(inName >= 0 ? inName + 6 : -1, anywhere);
  if (best < 0) return -1;
  return best * 100 - Math.min(path.length, 99);
}

/** The best `limit` paths for the query, best first; with no query, the given order. */
export function rankPaths(paths: readonly string[], query: string, limit: number): string[] {
  if (!query.trim()) return paths.slice(0, limit);
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of paths) {
    const score = fuzzyScore(path, query);
    if (score >= 0) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((item) => item.path);
}
