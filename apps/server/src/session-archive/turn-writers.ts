/**
 * Who wrote what in a settled turn: the files the root session's and its
 * sub-agents' (task tool child sessions') file tools wrote, by session, with
 * when, and the files more than one session wrote in the turn (`overlap`),
 * so that a rebuild of the turn can put those edits in the order they
 * happened. Written as one "turn.writers" event per turn in which a
 * sub-agent wrote a file. Shell commands name no paths reliably and are not
 * counted. Identical in the CLI and the desktop app.
 */
import { isAbsolute, relative, sep } from "node:path";

const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch", "str_replace_based_edit_tool", "create", "notebookedit"]);
const PATH_KEYS = ["filePath", "file_path", "path", "filename", "notebook_path"];
const MAX_FILES = 500;
const MAX_PATH_CHARS = 1_024;

export type WriterSessionMessages = {
  sessionId: string;
  role: "root" | "child";
  /** 0 for the root, 1 for a child, 2 for a grandchild, ... */
  depth: number;
  messages: readonly unknown[];
};

export type TurnWriterSession = { session_id: string; role: "root" | "child"; depth: number; calls: number; first_at: string | null; last_at: string | null };
export type TurnWriters = { files: Array<{ path: string; sessions: TurnWriterSession[] }>; overlap: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The paths an apply_patch / patch text adds, updates, deletes or moves to. */
export function patchTextPaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    const path = (match[1] ?? match[2] ?? "").trim();
    if (path) paths.push(path);
  }
  return paths;
}

/** Workspace-relative, forward slashes; null for a path outside the workspace or the workspace itself. */
function workspacePath(root: string, path: string): string | null {
  if (!path || path.length > MAX_PATH_CHARS || path.includes("\0")) return null;
  const relativePath = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//, "");
  if (!relativePath || relativePath === "." || relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  return relativePath.split(sep).join("/").replaceAll("\\", "/");
}

function toolWrites(part: Record<string, unknown>): string[] {
  const tool = typeof part.tool === "string" ? part.tool.toLowerCase() : "";
  if (!WRITE_TOOLS.has(tool)) return [];
  const state = isRecord(part.state) ? part.state : {};
  if (state.status === "error") return [];
  const input = isRecord(state.input) ? state.input : {};
  const paths: string[] = [];
  for (const key of PATH_KEYS) if (typeof input[key] === "string") paths.push(input[key] as string);
  for (const key of ["patchText", "patch", "input"]) if (typeof input[key] === "string") paths.push(...patchTextPaths(input[key] as string));
  // A patch tool's metadata names the files it changed, relative or absolute.
  const metadata = isRecord(state.metadata) ? state.metadata : {};
  if (Array.isArray(metadata.files)) {
    for (const file of metadata.files) {
      if (isRecord(file)) for (const key of ["filePath", "relativePath", "movePath"]) if (typeof file[key] === "string") paths.push(file[key] as string);
    }
  }
  return paths;
}

function timeOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The turn's writers. `root` is the workspace; the root session's messages
 * come first. Null when no sub-agent wrote a file in the workspace (nothing
 * to order).
 */
export function turnWriters(root: string, sessions: readonly WriterSessionMessages[]): TurnWriters | null {
  type Seen = { role: "root" | "child"; depth: number; calls: number; first: number | null; last: number | null };
  const byPath = new Map<string, Map<string, Seen>>();
  let childWrote = false;
  for (const session of sessions) {
    for (const message of session.messages) {
      if (!isRecord(message) || !Array.isArray(message.parts)) continue;
      for (const part of message.parts) {
        if (!isRecord(part) || part.type !== "tool") continue;
        const paths = [...new Set(toolWrites(part).map((path) => workspacePath(root, path)).filter((path): path is string => path !== null))];
        if (paths.length === 0) continue;
        const state = isRecord(part.state) ? part.state : {};
        const time = isRecord(state.time) ? state.time : {};
        const start = timeOf(time.start);
        const end = timeOf(time.end) ?? start;
        for (const path of paths) {
          let writers = byPath.get(path);
          if (!writers) {
            if (byPath.size >= MAX_FILES) continue;
            writers = new Map();
            byPath.set(path, writers);
          }
          const seen = writers.get(session.sessionId) ?? { role: session.role, depth: session.depth, calls: 0, first: null, last: null };
          seen.calls += 1;
          if (start !== null && (seen.first === null || start < seen.first)) seen.first = start;
          if (end !== null && (seen.last === null || end > seen.last)) seen.last = end;
          writers.set(session.sessionId, seen);
          if (session.role === "child") childWrote = true;
        }
      }
    }
  }
  if (!childWrote) return null;
  const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
  const files = [...byPath].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([path, writers]) => ({
    path,
    sessions: [...writers].map(([id, seen]) => ({ session_id: id, role: seen.role, depth: seen.depth, calls: seen.calls, first_at: iso(seen.first), last_at: iso(seen.last) }))
      .sort((left, right) => (left.first_at ?? "").localeCompare(right.first_at ?? "")),
  }));
  return { files, overlap: files.filter((file) => file.sessions.length > 1).map((file) => file.path) };
}
