/**
 * Line diff for the editor's git gutter: which lines of the current text were added or changed since HEAD, and
 * where lines were removed. Myers' O(ND) diff on whole lines, with a cap so a huge rewrite costs a bounded amount.
 */
export type GutterMark = {
  kind: "add" | "change" | "delete";
  /** 1-based line range in the current text. A deletion sits on the line before the removed lines (0 = top). */
  startLine: number;
  endLine: number;
  /** Lines removed from HEAD at this spot (change and delete). */
  removed: number;
};

/**
 * Beyond this many differing lines the gutter gives up (null): a whole-file rewrite needs no per-line marks. The
 * trace kept for the walk back is O(D²) numbers (about 4 MB at this cap), whatever the file's length.
 */
export const MAX_EDIT_DISTANCE = 1_000;

type Edit = { kind: "equal" | "insert" | "delete"; count: number };

/** Myers diff of two line arrays as runs of equal / inserted / deleted lines, or null past the cap. */
export function diffLines(before: readonly string[], after: readonly string[], maxD = MAX_EDIT_DISTANCE): Edit[] | null {
  // Common prefix and suffix first: most edits touch a small region.
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  const n = a.length;
  const m = b.length;
  const middle: Edit[] = [];
  if (n === 0 && m > 0) middle.push({ kind: "insert", count: m });
  else if (m === 0 && n > 0) middle.push({ kind: "delete", count: n });
  else if (n > 0 && m > 0) {
    const max = n + m;
    const offset = max;
    const v = new Int32Array(2 * max + 2);
    // trace[d]: v for diagonals -(d+1)..d+1 before step d (the walk back reads k-1 and k+1), at index k + d + 1.
    const trace: Int32Array[] = [];
    let found = -1;
    for (let d = 0; d <= Math.min(max, maxD); d += 1) {
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
    // Walk back through the trace.
    const steps: Array<"equal" | "insert" | "delete"> = [];
    let x = n;
    let y = m;
    for (let d = found; d > 0; d -= 1) {
      const vd = trace[d]!;
      const at = (k: number) => vd[k + d + 1]!;
      const k = x - y;
      const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      const prevX = at(prevK);
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        steps.push("equal");
        x -= 1;
        y -= 1;
      }
      steps.push(x === prevX ? "insert" : "delete");
      x = prevX;
      y = prevY;
    }
    while (x > 0 && y > 0) {
      steps.push("equal");
      x -= 1;
      y -= 1;
    }
    steps.reverse();
    for (const step of steps) {
      const last = middle[middle.length - 1];
      if (last && last.kind === step) last.count += 1;
      else middle.push({ kind: step, count: 1 });
    }
  }
  const edits: Edit[] = [];
  if (prefix) edits.push({ kind: "equal", count: prefix });
  edits.push(...middle);
  if (suffix) edits.push({ kind: "equal", count: suffix });
  return edits;
}

/** Gutter marks for the current text against HEAD, or null when the difference is too large to mark line by line. */
export function gutterMarks(head: string, current: string): GutterMark[] | null {
  const edits = diffLines(splitLines(head), splitLines(current));
  if (!edits) return null;
  const marks: GutterMark[] = [];
  let line = 0; // lines of the current text consumed
  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i]!;
    if (edit.kind === "equal") {
      line += edit.count;
      continue;
    }
    // A delete followed by an insert (or the reverse) is a change of the overlapping lines.
    const next = edits[i + 1];
    const removed = edit.kind === "delete" ? edit.count : next?.kind === "delete" ? next.count : 0;
    const added = edit.kind === "insert" ? edit.count : next?.kind === "insert" ? next.count : 0;
    if (next && next.kind !== "equal") i += 1;
    if (added && removed) {
      const changed = Math.min(added, removed);
      marks.push({ kind: "change", startLine: line + 1, endLine: line + changed, removed });
      if (added > changed) marks.push({ kind: "add", startLine: line + changed + 1, endLine: line + added, removed: 0 });
      line += added;
    } else if (added) {
      marks.push({ kind: "add", startLine: line + 1, endLine: line + added, removed: 0 });
      line += added;
    } else {
      marks.push({ kind: "delete", startLine: line, endLine: line, removed });
    }
  }
  return marks;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  // A final newline is not an extra empty line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The hover text of a mark. */
export function gutterLabel(mark: GutterMark): string {
  const count = mark.endLine - mark.startLine + 1;
  const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  if (mark.kind === "add") return `${lines(count)} added since the last commit`;
  if (mark.kind === "change") return `${lines(count)} changed since the last commit`;
  return `${lines(mark.removed)} removed here since the last commit`;
}
