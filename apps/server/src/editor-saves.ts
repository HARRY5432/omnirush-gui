/**
 * The files the person saved through the desktop editor, per workspace folder
 * (in memory, while the server runs), and what an undo of a chat's turns does
 * with them: an undo ("revert") of turns during or after which the person
 * saved a file passes that file to the engine as `keep`, so the undo never
 * takes the person's save back (the engine still merges a file that one of
 * the turns' edit/write/patch tools named too; redo skips kept files as well).
 *
 * Nothing in a chat's trace changes: `keep` only goes to the engine.
 */
import { resolve } from "node:path";

/** The most files remembered per folder (the oldest saves are let go first). */
export const EDITOR_SAVES_MAX_FILES = 2_000;
/** The most paths one undo passes to the engine. */
export const REVERT_KEEP_MAX = 2_000;

export class EditorSaveLog {
  private byRoot = new Map<string, Map<string, number>>();

  /** A save (or delete) of `relativePath` in the workspace folder `root`. */
  record(root: string, relativePath: string, at: number = Date.now()): void {
    const key = resolve(root);
    let files = this.byRoot.get(key);
    if (!files) {
      files = new Map();
      this.byRoot.set(key, files);
    }
    const absolute = resolve(key, relativePath);
    // Re-inserted so the map's order is the save order (the oldest is let go first).
    files.delete(absolute);
    files.set(absolute, at);
    while (files.size > EDITOR_SAVES_MAX_FILES) {
      const oldest = files.keys().next().value;
      if (oldest === undefined) break;
      files.delete(oldest);
    }
  }

  /** Whether anything in `root` was saved through the editor (an undo elsewhere asks the engine nothing more). */
  has(root: string): boolean {
    return (this.byRoot.get(resolve(root))?.size ?? 0) > 0;
  }

  /** The absolute paths of files in `root` last saved at or after `since` (ms). */
  savedSince(root: string, since: number): string[] {
    const files = this.byRoot.get(resolve(root));
    if (!files) return [];
    const out: string[] = [];
    for (const [path, at] of files) if (at >= since) out.push(path);
    return out;
  }
}

function decode(body: ArrayBuffer | undefined): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The message an undo request ("revert") rewinds to, or null when the body names none. */
export function revertMessageId(body: ArrayBuffer | undefined): string | null {
  const parsed = decode(body);
  return typeof parsed?.messageID === "string" && parsed.messageID ? parsed.messageID : null;
}

/**
 * The undo request's body with `saved` added to its `keep` list (merged with
 * any it already has), or null when there is nothing to add (the body is then
 * sent unchanged).
 */
export function withRevertKeep(body: ArrayBuffer | undefined, saved: readonly string[]): ArrayBuffer | null {
  if (saved.length === 0) return null;
  const parsed = decode(body);
  if (!parsed) return null;
  const existing = Array.isArray(parsed.keep) ? parsed.keep.filter((item): item is string => typeof item === "string") : [];
  const keep = [...new Set([...existing, ...saved])].slice(0, Math.max(REVERT_KEEP_MAX, existing.length));
  if (keep.length === existing.length) return null;
  const encoded = new TextEncoder().encode(JSON.stringify({ ...parsed, keep }));
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

/**
 * An undo request's body with the files the person saved through the editor
 * since the rewound message was sent added to its `keep` list (the engine then
 * leaves them as saved), or the body unchanged.
 */
export async function revertBodyWithEditorSaves(input: {
  saves: EditorSaveLog;
  root: string;
  body: ArrayBuffer | undefined;
  messageCreated: (messageId: string) => Promise<number | null>;
}): Promise<ArrayBuffer | undefined> {
  if (!input.saves.has(input.root)) return input.body;
  const messageId = revertMessageId(input.body);
  if (!messageId) return input.body;
  const created = await input.messageCreated(messageId);
  if (created === null) return input.body;
  return withRevertKeep(input.body, input.saves.savedSince(input.root, created)) ?? input.body;
}
