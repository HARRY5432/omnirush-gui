// What "Undo last turn" and "Redo" say they did to the project's files.
// The same wording as the OmniRush CLI's undo notice (engine tui
// util/undo-notice.ts), with "Redo" for the button in place of "/redo".

export type RevertOutcome = {
  restored?: readonly string[] | null;
  merged?: readonly string[] | null;
  kept?: readonly string[] | null;
  outside?: readonly string[] | null;
};

export type UndoNotice = {
  title: string;
  message: string;
  variant: "success" | "warning";
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const list = (files: readonly string[], max = 3) =>
  files.length <= max ? files.join(", ") : `${files.slice(0, max).join(", ")} and ${files.length - max} more`;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export const NOT_TRACKED_MESSAGE =
  "The chat was rewound. This folder is not a git repository, so file changes are not tracked and no file was restored.";

/**
 * The toast after an undo. `revert` is the engine's answer (the session's
 * `revert`); `tracked` is false when the folder's file changes are not
 * tracked (it is not a git repository).
 */
export function undoNotice(revert: RevertOutcome | null | undefined, tracked: boolean): UndoNotice {
  if (!tracked) return { title: "Undid the last turn", message: NOT_TRACKED_MESSAGE, variant: "warning" };
  const restored = strings(revert?.restored);
  const merged = strings(revert?.merged);
  const kept = strings(revert?.kept);
  const outside = strings(revert?.outside);
  const lines: string[] = [];
  const changed = restored.length + merged.length;
  if (changed) lines.push(`Restored ${plural(changed, "file")}: ${list([...restored, ...merged])}.`);
  if (merged.length) lines.push(`Your own edits in ${list(merged)} were kept.`);
  if (kept.length) {
    lines.push(
      `Left ${plural(kept.length, "file")} as ${kept.length === 1 ? "it is" : "they are"}: ${list(kept)} (edited after the turn, and the turn's change could not be taken out cleanly).`,
    );
  }
  if (outside.length) lines.push(`Not touched: ${list(outside)} (changed during the turn by something other than the agent's file edits).`);
  if (!lines.length) lines.push("The last turn changed no files.");
  lines.push("Redo puts it back.");
  return { title: "Undid the last turn", message: lines.join(" "), variant: kept.length || outside.length ? "warning" : "success" };
}

export const REDO_NOTICE = "Redid the last turn";

/** Whether the engine tracks this project's file changes: a git worktree (an untracked folder's project worktree is "/"). */
export function projectTracksFiles(project: { worktree?: string | null } | null | undefined): boolean {
  const worktree = project?.worktree?.trim() ?? "";
  return Boolean(worktree) && worktree !== "/";
}
