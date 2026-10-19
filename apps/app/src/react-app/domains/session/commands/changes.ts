// The Changes panel's data: the engine's file diffs (session.diff for this
// chat or its last turn, vcs.diff for the working tree), normalized.

export type ChangesSource = "chat" | "turn" | "tree";

export type ChangedFile = {
  path: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  patch: string;
};

type RawDiff = { file?: unknown; path?: unknown; patch?: unknown; additions?: unknown; deletions?: unknown; status?: unknown };

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/** The engine's diff items as the panel lists them, by path; items without a path are left out. */
export function normalizeChanges(items: unknown): ChangedFile[] {
  if (!Array.isArray(items)) return [];
  const out: ChangedFile[] = [];
  for (const raw of items as RawDiff[]) {
    if (!raw || typeof raw !== "object") continue;
    const path = typeof raw.file === "string" ? raw.file : typeof raw.path === "string" ? raw.path : "";
    if (!path.trim()) continue;
    const status = raw.status === "added" || raw.status === "deleted" ? raw.status : "modified";
    out.push({ path, status, additions: count(raw.additions), deletions: count(raw.deletions), patch: typeof raw.patch === "string" ? raw.patch : "" });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function changeTotals(files: readonly ChangedFile[]) {
  return files.reduce(
    (total, file) => ({ files: total.files + 1, additions: total.additions + file.additions, deletions: total.deletions + file.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

export const CHANGES_EMPTY: Record<ChangesSource, string> = {
  chat: "This chat has not changed any files yet.",
  turn: "The last turn changed no files.",
  tree: "No changes.",
};

export const CHANGES_SOURCE_LABEL: Record<ChangesSource, string> = {
  chat: "This chat",
  turn: "Last turn",
  tree: "Working tree",
};

export type PatchLine = { kind: "add" | "del" | "hunk" | "context" | "meta"; text: string; oldLine: number | null; newLine: number | null };

/** A unified patch as display lines with old/new line numbers; the file headers are left out. */
export function patchLines(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    if (text.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      oldLine = match ? Number(match[1]) : 0;
      newLine = match ? Number(match[2]) : 0;
      inHunk = true;
      lines.push({ kind: "hunk", text, oldLine: null, newLine: null });
      continue;
    }
    if (!inHunk) continue;
    if (text.startsWith("\\")) {
      lines.push({ kind: "meta", text, oldLine: null, newLine: null });
    } else if (text.startsWith("+")) {
      lines.push({ kind: "add", text: text.slice(1), oldLine: null, newLine: newLine++ });
    } else if (text.startsWith("-")) {
      lines.push({ kind: "del", text: text.slice(1), oldLine: oldLine++, newLine: null });
    } else if (text.startsWith(" ") || text === "") {
      if (text === "" && lines.length && lines[lines.length - 1]?.kind === "hunk") continue;
      lines.push({ kind: "context", text: text.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else if (text.startsWith("diff --git") || text.startsWith("Index:")) {
      inHunk = false;
    }
  }
  // A trailing newline in the patch leaves one empty context line behind.
  while (lines.length && lines[lines.length - 1]?.kind === "context" && lines[lines.length - 1]?.text === "") lines.pop();
  return lines;
}
