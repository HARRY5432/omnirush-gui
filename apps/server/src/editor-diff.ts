/**
 * Line diff for the desktop editor's user edits (routes/editor.ts): how many
 * lines a save added and removed, and the unified diff text of the change.
 * Myers' O(ND) algorithm over the lines that differ after the common prefix
 * and suffix are cut; past `maxEdits` differing lines it stops and reports
 * the counts from a cheap multiset comparison instead, without a diff.
 */

export type LineDiffStats = {
  added: number;
  removed: number;
  /** Unified diff text (`--- a/path`, `+++ b/path`, `@@` hunks), or null when the change was too large to diff. */
  diff: string | null;
};

/** Diffs larger than this many edit steps are summarised by counts only. */
export const MAX_EDITOR_DIFF_EDITS = 1_500;
const CONTEXT_LINES = 3;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

type Op = { kind: " " | "-" | "+"; line: string };

/** Myers' greedy diff of two line arrays, or null past `maxEdits` edit steps. */
function myers(a: string[], b: string[], maxEdits: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Per step, the slice of `v` for diagonals -d-1..d+1 (what backtracking reads): O(D^2) memory.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d]!;
    const at = (diagonal: number) => prev[diagonal + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: " ", line: a[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) ops.push({ kind: "+", line: b[y - 1]! });
    else ops.push({ kind: "-", line: a[x - 1]! });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: " ", line: a[x - 1]! });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

/** Lines in `a` not matched in `b` (as a multiset), and the other way round. */
function multisetCounts(a: string[], b: string[]): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of b) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added += 1;
  }
  let removed = 0;
  for (const left of counts.values()) removed += left;
  return { added, removed };
}

function hunkHeader(oldStart: number, oldCount: number, newStart: number, newCount: number): string {
  const range = (start: number, count: number) => (count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`);
  return `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`;
}

/** The unified diff of `before` -> `after` for `path`, with line counts. */
export function editorLineDiff(path: string, before: string, after: string, maxEdits = MAX_EDITOR_DIFF_EDITS): LineDiffStats {
  if (before === after) return { added: 0, removed: 0, diff: "" };
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const middle = myers(midA, midB, maxEdits);
  if (!middle) return { ...multisetCounts(midA, midB), diff: null };
  const ops: Op[] = [
    ...a.slice(0, prefix).map((line) => ({ kind: " " as const, line })),
    ...middle,
    ...a.slice(a.length - suffix).map((line) => ({ kind: " " as const, line })),
  ];
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "+") added += 1;
    else if (op.kind === "-") removed += 1;
  }
  // Only a final-newline change: the lines match but the texts do not.
  if (added === 0 && removed === 0) {
    return { added: 0, removed: 0, diff: `--- a/${path}\n+++ b/${path}\n\\ final newline changed\n` };
  }
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < ops.length) {
    if (ops[i]!.kind === " ") {
      oldLine += 1;
      newLine += 1;
      i += 1;
      continue;
    }
    // A hunk: up to CONTEXT_LINES before, changes joined while the gap is at most 2 * CONTEXT_LINES.
    const start = Math.max(0, i - CONTEXT_LINES);
    let end = i;
    while (end < ops.length) {
      if (ops[end]!.kind !== " ") {
        end += 1;
        continue;
      }
      let gap = end;
      while (gap < ops.length && ops[gap]!.kind === " ") gap += 1;
      if (gap >= ops.length || gap - end > 2 * CONTEXT_LINES) {
        end = Math.min(ops.length, end + CONTEXT_LINES);
        break;
      }
      end = gap;
    }
    const lead = i - start;
    const hunkOldStart = oldLine - lead;
    const hunkNewStart = newLine - lead;
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let j = start; j < end; j += 1) {
      const op = ops[j]!;
      body.push(`${op.kind}${op.line}`);
      if (op.kind !== "+") oldCount += 1;
      if (op.kind !== "-") newCount += 1;
    }
    lines.push(hunkHeader(hunkOldStart, oldCount, hunkNewStart, newCount), ...body);
    for (let j = i; j < end; j += 1) {
      const op = ops[j]!;
      if (op.kind !== "+") oldLine += 1;
      if (op.kind !== "-") newLine += 1;
    }
    i = end;
  }
  return { added, removed, diff: `${lines.join("\n")}\n` };
}
