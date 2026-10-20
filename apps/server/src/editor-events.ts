/**
 * The trace events the desktop editor adds to a chat it is used beside
 * (documented for the converter in e2e/harness-new-events.md):
 *
 * - "user_edit": the user saved a file in the editor (or rejected an agent
 *   change, `source: "review"`) between turns. `{path, source, added,
 *   removed, created?, deleted?, diff?, diff_truncated?}`. `diff` is the
 *   unified diff of the save, as `{path, diff}` the same file-aware shape the
 *   trace scrub already redacts per file (a "turn.diff" `files[]` item);
 *   left out when the change is too large to diff or the file is binary.
 * - "user_review": the user accepted or rejected an agent change in the
 *   review view. `{path, decision, scope, added, removed}` (the hunk's line
 *   counts; no text).
 *
 * A chat whose editor is never used carries neither.
 */
import { editorLineDiff } from "./editor-diff.js";
import type { EditorUserEdit, EditorUserReview } from "./routes/editor.js";
import { isKnownBinaryPath } from "./session-archive/binary.js";

/** A save's diff larger than this is left out of the event (the counts stay). */
export const MAX_USER_EDIT_DIFF_BYTES = 64 * 1024;

export type UserEditEvent = {
  path: string;
  source: "editor" | "review";
  added: number;
  removed: number;
  created?: true;
  deleted?: true;
  diff?: string;
  diff_truncated?: true;
};

export function editorUserEditEvent(edit: Pick<EditorUserEdit, "path" | "before" | "after" | "source">): UserEditEvent | null {
  const before = edit.before ?? "";
  const after = edit.after ?? "";
  if (edit.before !== null && edit.after !== null && before === after) return null;
  const stats = editorLineDiff(edit.path, before, after);
  const event: UserEditEvent = { path: edit.path, source: edit.source, added: stats.added, removed: stats.removed };
  if (edit.before === null && edit.after !== null) event.created = true;
  if (edit.after === null) event.deleted = true;
  if (isKnownBinaryPath(edit.path)) return event;
  if (stats.diff === null || Buffer.byteLength(stats.diff, "utf8") > MAX_USER_EDIT_DIFF_BYTES) {
    event.diff_truncated = true;
    return event;
  }
  if (stats.diff) event.diff = stats.diff;
  return event;
}

export function editorUserReviewEvent(review: Pick<EditorUserReview, "path" | "decision" | "scope" | "added" | "removed">) {
  return { path: review.path, decision: review.decision, scope: review.scope, added: review.added, removed: review.removed };
}
