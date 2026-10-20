/**
 * What the chat commands "review" and "undo" record in a session's trace, as
 * additive schema-1 events (SessionUploader.recordCommand). PARITY: the same
 * names, fields and rules as omnirush-cli's src/command-events.js.
 *
 *   turn.undone  {schema, message_id, repeat, restored, merged, kept, outside, files: {restored, merged, kept, outside}}
 *   turn.redone  {schema, message_id}
 *   review.run   {schema, target, has_arguments}
 *   review.fix   {schema, issues}
 *
 * A session that never runs them carries none of these events.
 */

export type CommandEventType = "turn.undone" | "turn.redone" | "review.run" | "review.fix";
export type CommandEvent = { type: CommandEventType; data: Record<string, unknown> };
export type ReviewTarget = "uncommitted" | "commit" | "branch" | "pr" | "other";

/** What a review was asked to look at, from its arguments. */
export function reviewTarget(args: unknown): ReviewTarget {
  const text = String(args ?? "").trim();
  if (!text) return "uncommitted";
  if (/github\.com|\/pull\//i.test(text) || /^#?\d+$/.test(text)) return "pr";
  if (/^[0-9a-f]{7,40}$/i.test(text)) return "commit";
  if (/^[\w./-]+$/.test(text)) return "branch";
  return "other";
}

function parseBody(body: unknown): unknown {
  if (body instanceof ArrayBuffer) body = new TextDecoder().decode(body);
  else if (body instanceof Uint8Array) body = new TextDecoder().decode(body);
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * The event a dispatched engine command records, or null for any other
 * command or prompt. `body` is the POST /session/:id/command body.
 */
export function commandEvent(body: unknown): CommandEvent | null {
  const parsed = parseBody(body) as { command?: unknown; arguments?: unknown } | null;
  if (!parsed || typeof parsed !== "object") return null;
  const name = typeof parsed.command === "string" ? parsed.command.replace(/^\//, "") : null;
  const args = typeof parsed.arguments === "string" ? parsed.arguments.trim() : "";
  if (name === "review") return { type: "review.run", data: { target: reviewTarget(args), has_arguments: Boolean(args) } };
  if (name === "fix") return { type: "review.fix", data: { issues: args ? "some" : "all" } };
  return null;
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/**
 * The event of a successful undo ("revert") or redo ("unrevert"). `session`
 * is the engine's answer; `previous` the revert point the session had before
 * (null when none). Null when the answer is not a session.
 */
export function revertEvent(kind: "revert" | "unrevert", session: unknown, previous: string | null = null): CommandEvent | null {
  if (!session || typeof session !== "object") return null;
  if (kind === "unrevert") return { type: "turn.redone", data: { message_id: previous ?? null } };
  const revert = (session as { revert?: unknown }).revert;
  if (!revert || typeof revert !== "object") return null;
  const record = revert as Record<string, unknown>;
  const files = { restored: list(record.restored), merged: list(record.merged), kept: list(record.kept), outside: list(record.outside) };
  return {
    type: "turn.undone",
    data: {
      message_id: typeof record.messageID === "string" ? record.messageID : null,
      repeat: Boolean(previous),
      restored: files.restored.length,
      merged: files.merged.length,
      kept: files.kept.length,
      outside: files.outside.length,
      files,
    },
  };
}

/** The session and kind of an undo / redo request (POST /session/:id/revert|unrevert), or null. */
export function revertRequest(method: string, normalizedPath: string): { sessionId: string; kind: "revert" | "unrevert" } | null {
  if (method !== "POST") return null;
  const match = normalizedPath.match(/^\/session\/([^/]+)\/(revert|unrevert)$/);
  if (!match?.[1] || !match[2]) return null;
  return { sessionId: match[1], kind: match[2] as "revert" | "unrevert" };
}
