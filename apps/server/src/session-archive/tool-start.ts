/**
 * Capture v2: the moment a turn's first tool call starts. While the observer
 * follows a turn it listens to the engine's event stream (v1 `/event`, v2
 * `/api/event`) and calls `onToolStart` once, at the first tool part of that
 * session that is pending or running (v1 `message.part.updated` with a
 * `tool` part, v2 `session.tool.input.started` / `session.tool.called`),
 * with the time the call started (the files it writes are newer).
 * The capture it triggers runs in the background: the tool is never held.
 * Identical in the CLI and the desktop app.
 */

export type ToolStartFetch = (url: string, init: { headers: Headers; signal: AbortSignal }) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const V2_TOOL_EVENTS = /^session\.(?:next\.)?tool\.(?:input\.started|called)$/;

/** The session id of a tool-start event, or null when `payload` is not one. */
export function toolStartSession(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  // /global/event wraps each event as { directory, payload }.
  if (isRecord(payload.payload) && typeof payload.payload.type === "string") return toolStartSession(payload.payload);
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type === "message.part.updated") {
    const properties = isRecord(payload.properties) ? payload.properties : null;
    const part = properties && isRecord(properties.part) ? properties.part : null;
    if (!part || part.type !== "tool") return null;
    const status = isRecord(part.state) ? part.state.status : undefined;
    if (status !== "pending" && status !== "running") return null;
    return typeof part.sessionID === "string" ? part.sessionID : null;
  }
  if (V2_TOOL_EVENTS.test(type)) {
    const data = isRecord(payload.data) ? payload.data : isRecord(payload.properties) ? payload.properties : null;
    return data && typeof data.sessionID === "string" ? data.sessionID : null;
  }
  return null;
}

/**
 * When the tool call of a tool-start event started, in epoch milliseconds:
 * the event's own time (v1 `properties.time`, the part's `state.time.start`,
 * v2 `time`/`timestamp`), or null when it carries none. The earliest one wins:
 * a `pending` part has no start of its own yet, and its event is sent first.
 */
export function toolStartTime(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.payload) && typeof payload.payload.type === "string") return toolStartTime(payload.payload);
  const times: unknown[] = [];
  const properties = isRecord(payload.properties) ? payload.properties : null;
  const data = isRecord(payload.data) ? payload.data : null;
  for (const holder of [payload, properties, data]) {
    if (!holder) continue;
    times.push(holder.time, holder.timestamp);
    const part = isRecord(holder.part) ? holder.part : null;
    const state = part && isRecord(part.state) ? part.state : null;
    if (state && isRecord(state.time)) times.push(state.time.start);
  }
  let earliest: number | null = null;
  for (const time of times) {
    const value = typeof time === "number" ? time : typeof time === "string" ? Date.parse(time) : NaN;
    // Epoch milliseconds from this century only (not seconds, not a monotonic clock).
    if (Number.isFinite(value) && value > 1_500_000_000_000 && value < 4_000_000_000_000 && (earliest === null || value < earliest)) earliest = value;
  }
  return earliest;
}

/** Splits SSE text into the `data:` payloads of complete frames; returns the unfinished rest. */
export function sseFrames(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let rest = buffer;
  for (;;) {
    const match = /\r?\n\r?\n/.exec(rest);
    if (!match) break;
    const frame = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (data) payloads.push(data);
  }
  return { payloads, rest };
}

const MAX_FRAME_CHARS = 4 * 1024 * 1024;

/**
 * Listens until `signal` aborts or the first tool start of `sessionId`
 * (then `onToolStart` runs once and the stream closes). Never throws; a
 * stream that cannot be opened is simply no hook (the turn's end capture
 * still runs).
 */
export async function watchToolStarts(input: {
  url: string;
  headers: Headers;
  sessionId: string;
  signal: AbortSignal;
  fetch: ToolStartFetch;
  /** `at`: when the tool call started (toolStartTime, else when its event arrived). */
  onToolStart: (at: number) => void;
}): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (input.signal.aborted) return;
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    const headers = new Headers(input.headers);
    headers.set("accept", "text/event-stream");
    const response = await input.fetch(input.url, { headers, signal: controller.signal });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const { payloads, rest } = sseFrames(buffer);
      buffer = rest.length > MAX_FRAME_CHARS ? "" : rest;
      for (const text of payloads) {
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          continue;
        }
        if (toolStartSession(payload) === input.sessionId) {
          const received = Date.now();
          const at = toolStartTime(payload);
          try {
            // An event time from a clock running ahead is no later than the event's arrival.
            input.onToolStart(at === null ? received : Math.min(at, received));
          } finally {
            controller.abort();
          }
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
  } catch {
    // Aborted, or the engine went away: no hook for this turn.
  } finally {
    input.signal.removeEventListener("abort", stop);
  }
}
