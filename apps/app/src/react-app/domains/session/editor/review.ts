/**
 * The agent's changes for review: the engine records each turn's file
 * changes as unified patches (session diff per user message). The editor
 * shows a file's change as a diff of "before" (the file as it was before the
 * turn) against the file on disk; "before" is the disk text with the turn's
 * patch undone. A patch that no longer fits the file (edited since) yields
 * null and the file is listed without a reviewable diff.
 */

export type PatchLine = { kind: " " | "-" | "+"; text: string };
export type PatchHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: PatchLine[] };
export type ParsedPatch = { hunks: PatchHunk[]; oldNoNewline: boolean; newNoNewline: boolean };

export type TurnFileChange = {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  patch: string;
};

/** The hunks of a unified patch (one file). */
export function parseUnifiedPatch(patch: string): ParsedPatch {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let last: PatchLine["kind"] | null = null;
  let oldNoNewline = false;
  let newNoNewline = false;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      last = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" applies to the line before it.
      if (last === "-" ) oldNoNewline = true;
      else if (last === "+") newNoNewline = true;
      else if (last === " ") {
        oldNoNewline = true;
        newNoNewline = true;
      }
      continue;
    }
    const kind = line[0];
    if (kind === " " || kind === "-" || kind === "+") {
      current.lines.push({ kind, text: line.slice(1) });
      last = kind;
    } else if (line === "" ) {
      // A trailing empty line of the patch text, or an empty context line some writers emit without the space.
      const expectedOld = current.lines.filter((item) => item.kind !== "+").length;
      const expectedNew = current.lines.filter((item) => item.kind !== "-").length;
      if (expectedOld < current.oldLines && expectedNew < current.newLines) {
        current.lines.push({ kind: " ", text: "" });
        last = " ";
      }
    }
  }
  return { hunks, oldNoNewline, newNoNewline };
}

function splitText(text: string): { lines: string[]; finalNewline: boolean } {
  if (text === "") return { lines: [], finalNewline: false };
  const finalNewline = text.endsWith("\n");
  const lines = (finalNewline ? text.slice(0, -1) : text).split("\n");
  return { lines, finalNewline };
}

function joinText(lines: string[], finalNewline: boolean): string {
  if (lines.length === 0) return "";
  return lines.join("\n") + (finalNewline ? "\n" : "");
}

function matchesAt(haystack: string[], at: number, needle: string[]): boolean {
  if (at < 0 || at + needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i += 1) if (haystack[at + i] !== needle[i]) return false;
  return true;
}

/** Where `needle` sits in `haystack`, searching outward from `hint`; -1 when absent. */
function locate(haystack: string[], needle: string[], hint: number): number {
  if (needle.length === 0) return Math.max(0, Math.min(hint, haystack.length));
  const limit = haystack.length;
  for (let offset = 0; offset <= limit; offset += 1) {
    if (matchesAt(haystack, hint - offset, needle)) return hint - offset;
    if (offset > 0 && matchesAt(haystack, hint + offset, needle)) return hint + offset;
  }
  return -1;
}

/**
 * The text before a patch, from the text after it (the patch undone), or
 * null when the patch does not fit `after`.
 */
export function reversePatch(after: string, patch: string): string | null {
  const parsed = parseUnifiedPatch(patch);
  if (parsed.hunks.length === 0) return null;
  const { lines, finalNewline } = splitText(after);
  const result = [...lines];
  // Last hunk first: earlier line numbers stay valid.
  for (const hunk of [...parsed.hunks].reverse()) {
    const newSide = hunk.lines.filter((line) => line.kind !== "-").map((line) => line.text);
    const oldSide = hunk.lines.filter((line) => line.kind !== "+").map((line) => line.text);
    const at = locate(result, newSide, Math.max(0, hunk.newStart - 1));
    if (at < 0) return null;
    result.splice(at, newSide.length, ...oldSide);
  }
  // The old text's final newline: what the patch says, else the same as now.
  const oldFinalNewline = result.length === 0 ? false : parsed.oldNoNewline ? false : parsed.newNoNewline ? true : finalNewline || lines.length === 0;
  return joinText(result, oldFinalNewline);
}

/** The text after a patch, from the text before it (for a deleted file: its whole old text is in the patch). */
export function applyPatch(before: string, patch: string): string | null {
  const parsed = parseUnifiedPatch(patch);
  if (parsed.hunks.length === 0) return null;
  const { lines, finalNewline } = splitText(before);
  const result = [...lines];
  for (const hunk of [...parsed.hunks].reverse()) {
    const newSide = hunk.lines.filter((line) => line.kind !== "-").map((line) => line.text);
    const oldSide = hunk.lines.filter((line) => line.kind !== "+").map((line) => line.text);
    const at = locate(result, oldSide, Math.max(0, hunk.oldStart - 1));
    if (at < 0) return null;
    result.splice(at, oldSide.length, ...newSide);
  }
  const newFinalNewline = result.length === 0 ? false : parsed.newNoNewline ? false : parsed.oldNoNewline ? true : finalNewline || lines.length === 0;
  return joinText(result, newFinalNewline);
}

/**
 * Each file's text before the reviewed turns, from its current text: the
 * turns' patches undone newest first. `turns` is oldest first. A file whose
 * patches do not fit maps to undefined (no reviewable diff); a file the
 * turns created maps to null (it did not exist).
 */
export function baselinesForTurns(
  turns: TurnFileChange[][],
  current: (path: string) => string | null,
): Map<string, string | null | undefined> {
  const baselines = new Map<string, string | null | undefined>();
  const texts = new Map<string, string | null>();
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    for (const change of turns[index]!) {
      if (!texts.has(change.path)) texts.set(change.path, current(change.path));
      const now = texts.get(change.path);
      if (now === undefined) continue;
      if (baselines.get(change.path) === undefined && baselines.has(change.path)) continue;
      let before: string | null | undefined;
      if (change.status === "added") before = null;
      else if (change.status === "deleted") before = reversePatch("", change.patch) ?? undefined;
      else before = now === null ? undefined : reversePatch(now, change.patch) ?? undefined;
      baselines.set(change.path, before);
      if (before !== undefined) texts.set(change.path, before);
    }
  }
  return baselines;
}

/** One engine `FileDiff`/`SnapshotFileDiff` item as a change, or null when it names no file. */
export function turnFileChange(raw: unknown): TurnFileChange | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const path = typeof item.file === "string" ? item.file : typeof item.path === "string" ? item.path : null;
  if (!path || typeof item.patch !== "string") return null;
  const status = item.status === "added" || item.status === "deleted" ? item.status : "modified";
  return {
    path: path.replace(/\\/g, "/").replace(/^\.\//, ""),
    status,
    additions: typeof item.additions === "number" ? item.additions : 0,
    deletions: typeof item.deletions === "number" ? item.deletions : 0,
    patch: item.patch,
  };
}
