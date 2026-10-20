/**
 * "An undo or redo just changed the project's files": every successful
 * revert / unrevert of a chat says so, and the code editor re-reads its open
 * files (a file without unsaved changes takes the disk text; one with unsaved
 * changes is flagged as changed on disk, Reload offered first).
 */
export type FilesRewound = {
  kind: "undo" | "redo";
  sessionId: string;
  /** The files the engine says it restored or merged (undo only; a redo re-reads every open file). */
  files: string[];
};

type Listener = (event: FilesRewound) => void;
const listeners = new Set<Listener>();

export function onFilesRewound(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyFilesRewound(event: FilesRewound): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A listener never fails the undo.
    }
  }
}

/** The files a revert answer names as restored or merged. */
export function rewoundFiles(session: unknown): string[] {
  const revert = (session as { revert?: { restored?: unknown; merged?: unknown } | null } | null)?.revert;
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  return [...new Set([...list(revert?.restored), ...list(revert?.merged)])];
}
