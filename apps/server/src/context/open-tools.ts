// Tool calls the engine left open (pending or running) when a turn ended
// without them: the model's stream died after it asked for a tool, the user
// stopped the turn, or the app quit while a tool ran. The engine closes them
// itself on a clean stop ("Tool execution aborted", metadata.interrupted);
// when its cleanup never ran (a killed engine) or had not run yet when the
// turn was read, the uploaded copy closes them the same way, so no tool call
// reads as still running in a turn that is over. Identical in the CLI and
// the desktop app.

export const TOOL_ABORTED_ERROR = "Tool execution aborted";

const OPEN_STATUSES = new Set(["pending", "running"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Whether an assistant message is over: it completed, failed or has a finish reason. */
function messageEnded(info: Record<string, unknown>): boolean {
  const time = isRecord(info.time) ? info.time : {};
  return finiteNumber(time.completed) !== null || info.error != null || (typeof info.finish === "string" && info.finish !== "");
}

/**
 * The messages with every open tool part of an ended turn closed as aborted
 * (status "error", error "Tool execution aborted", metadata.interrupted, an
 * end time: the message's completion, else `now`). `engineIdle`: the session
 * no longer runs (idle, quit, recovered after a kill), so every open tool
 * part is over; otherwise only those of assistant messages that ended.
 * Messages without an open tool part are returned as they are.
 */
export function closeOpenToolParts<T>(messages: readonly T[], options: { engineIdle: boolean; now?: number }): { messages: T[]; closed: number } {
  let closed = 0;
  const out = messages.map((message) => {
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) return message;
    const info = message.info;
    if ((info.role ?? info.type) !== "assistant") return message;
    if (!options.engineIdle && !messageEnded(info)) return message;
    let changed = false;
    const time = isRecord(info.time) ? info.time : {};
    const end = finiteNumber(time.completed) ?? options.now ?? Date.now();
    const parts = message.parts.map((part: unknown) => {
      if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state) || !OPEN_STATUSES.has(String(part.state.status))) return part;
      const state = part.state;
      const started = isRecord(state.time) ? finiteNumber(state.time.start) : null;
      const metadata = isRecord(state.metadata) ? state.metadata : {};
      changed = true;
      closed += 1;
      return {
        ...part,
        state: {
          ...state,
          status: "error",
          input: isRecord(state.input) ? state.input : {},
          error: TOOL_ABORTED_ERROR,
          metadata: { ...metadata, interrupted: true },
          time: { start: started ?? end, end: Math.max(end, started ?? end) },
        },
      };
    });
    return changed ? ({ ...message, parts } as T) : message;
  });
  return { messages: out, closed };
}
