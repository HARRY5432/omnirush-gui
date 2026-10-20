/**
 * Accepting and rejecting one hunk of a review diff, on line arrays (a
 * Monaco model's lines; a final newline is a trailing empty line). The hunk
 * is Monaco's ILineChange: an end line of 0 on one side means no lines there
 * (an insertion or a deletion after the start line).
 *
 * - accept: the "before" side takes the hunk's new lines (the change stays,
 *   and is no longer shown as pending);
 * - reject: the file takes the hunk's old lines back.
 */
export type LineHunk = {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
};

function sideRange(start: number, end: number): { from: number; count: number } {
  // An empty side sits after line `start`: insert at index `start`.
  if (end === 0) return { from: start, count: 0 };
  return { from: start - 1, count: end - start + 1 };
}

/** The hunk's lines on each side. */
export function hunkLines(original: string[], modified: string[], hunk: LineHunk): { old: string[]; new: string[] } {
  const o = sideRange(hunk.originalStartLineNumber, hunk.originalEndLineNumber);
  const m = sideRange(hunk.modifiedStartLineNumber, hunk.modifiedEndLineNumber);
  return { old: original.slice(o.from, o.from + o.count), new: modified.slice(m.from, m.from + m.count) };
}

/** The "before" lines with the hunk accepted. */
export function acceptHunk(original: string[], modified: string[], hunk: LineHunk): string[] {
  const o = sideRange(hunk.originalStartLineNumber, hunk.originalEndLineNumber);
  const { new: lines } = hunkLines(original, modified, hunk);
  const next = [...original];
  next.splice(o.from, o.count, ...lines);
  return next;
}

/** The file's lines with the hunk rejected. */
export function rejectHunk(original: string[], modified: string[], hunk: LineHunk): string[] {
  const m = sideRange(hunk.modifiedStartLineNumber, hunk.modifiedEndLineNumber);
  const { old: lines } = hunkLines(original, modified, hunk);
  const next = [...modified];
  next.splice(m.from, m.count, ...lines);
  return next;
}

/** Added and removed line counts of a hunk. */
export function hunkCounts(hunk: LineHunk): { added: number; removed: number } {
  const added = hunk.modifiedEndLineNumber === 0 ? 0 : hunk.modifiedEndLineNumber - hunk.modifiedStartLineNumber + 1;
  const removed = hunk.originalEndLineNumber === 0 ? 0 : hunk.originalEndLineNumber - hunk.originalStartLineNumber + 1;
  return { added, removed };
}
