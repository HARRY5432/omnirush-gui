/**
 * A long turn's messages go out while it runs. The same file ships in
 * omnirush-cli and omnirush-gui (PARITY.sha256): both observers follow a
 * running turn the same way.
 *
 * A turn is uploaded when it ends. One that runs for many minutes (an agent
 * that starts sub-agents and waits for them) would otherwise send nothing
 * between its start and its end, and nothing at all when the app is closed
 * or killed before it ends. While the engine says the session is busy, the
 * observer sends what is final so far:
 *
 * - every TURN_PROGRESS_INTERVAL_MS once the turn is TURN_PROGRESS_MIN_AGE_MS
 *   old, and as soon as a sub-agent of a turn that old ends (a session the
 *   engine listed as busy is not any more), at most once per
 *   TURN_PROGRESS_MIN_GAP_MS;
 * - only settled messages, oldest first, up to the first one that is not:
 *   a user message, or an assistant message that ended with no tool call
 *   still pending or running, and never a session's newest message (the
 *   engine still adds to a step that just ended: its file patch). A message
 *   still being written is sent when the turn ends, with its final content.
 *
 * The root session's settled messages go ahead as `turn.messages` (the
 * events a long turn's backlog already uses, `progress: true`, numbered
 * `part` of `parts` within one send: the server keeps a trace's events
 * apart by time, type and part, and the pieces of one send may share a
 * millisecond), each
 * sub-agent's as a `session.child` event. No checkpoint moves: the turn's
 * end reads every session from where the turn started, as without
 * progress, and sends only the messages not sent ahead, or sent ahead and
 * changed since (their size differs, as a prompt does once the engine adds
 * its summary): each message goes up once more at most, in its final
 * form. Everything the turn's end derives from its messages (outcome,
 * writers, files read and used, the archive, the checkpoints) still reads
 * all of them.
 */
export const TURN_PROGRESS_INTERVAL_MS = 3 * 60_000;
export const TURN_PROGRESS_MIN_AGE_MS = 60_000;
export const TURN_PROGRESS_MIN_GAP_MS = 15_000;
/** The shortest interval an override may set. */
export const TURN_PROGRESS_FLOOR_MS = 10_000;

export type TurnProgressReason = "interval" | "sub_agent_ended";

type MessageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MessageRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function infoOf(message: MessageRecord): MessageRecord {
  return isRecord(message.info) ? message.info : message;
}

/** The interval set by OMNIRUSH_TURN_PROGRESS_MS: "0" turns it off, anything unreadable keeps the default. */
export function turnProgressIntervalMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return TURN_PROGRESS_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return TURN_PROGRESS_INTERVAL_MS;
  if (parsed === 0) return 0;
  return Math.max(TURN_PROGRESS_FLOOR_MS, Math.floor(parsed));
}

/** The `turn.messages` event data of one send ahead, split in pieces: each numbered `part` of `parts`. */
export function progressEvents<T>(pieces: readonly T[], messagesOf: (piece: T) => unknown[]): Array<{ messages: unknown[]; part: number; parts: number; progress: true }> {
  return pieces.map((piece, index) => ({ messages: messagesOf(piece), part: index + 1, parts: pieces.length, progress: true as const }));
}

/** An engine message's id, or null. */
export function progressMessageId(message: unknown): string | null {
  if (!isRecord(message)) return null;
  const id = infoOf(message).id;
  return typeof id === "string" && id ? id : null;
}

/** Whether a message is final: a user message, or an assistant message that ended with no tool call still open. */
export function settledMessage(message: unknown): boolean {
  if (!isRecord(message)) return false;
  const info = infoOf(message);
  const role = info.role ?? info.type;
  if (role === "user") return true;
  if (role !== "assistant") return false;
  const time = isRecord(info.time) ? info.time : null;
  const ended = (time !== null && (typeof time.completed === "number" || typeof time.completed === "string")) || info.error != null;
  if (!ended) return false;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return !parts.some((part) => {
    if (!isRecord(part) || part.type !== "tool") return false;
    const state = isRecord(part.state) ? part.state.status : undefined;
    return state === "pending" || state === "running";
  });
}

/** How many messages, from the oldest, are settled before the first one that is not. */
export function settledPrefix(messages: readonly unknown[]): number {
  let count = 0;
  while (count < messages.length && settledMessage(messages[count])) count += 1;
  return count;
}

/**
 * One followed turn's progress: when to send, and which of the root's
 * messages went ahead. Fed with every status read of the engine while the
 * turn runs.
 */
export class TurnProgress {
  /** Messages sent ahead of the turn's end, by session ("" for the root): message id → size when sent. */
  private readonly sent = new Map<string, Map<string, number>>();
  private readonly startedAt: number;
  private readonly intervalMs: number;
  private lastAt: number | null = null;
  private busy = new Set<string>();
  private ended = false;

  constructor(startedAt: number, intervalMs: number) {
    this.startedAt = startedAt;
    this.intervalMs = intervalMs;
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  /**
   * One read of the engine's statuses (session id → { type }): a session
   * other than the root that was busy and is no longer listed busy ended
   * (a sub-agent, as far as the root's children say when they are read).
   */
  noteStatuses(statuses: unknown, rootSessionId: string): void {
    if (!isRecord(statuses)) return;
    const now = new Set<string>();
    for (const [id, status] of Object.entries(statuses)) {
      if (id === rootSessionId) continue;
      const type = isRecord(status) ? status.type : undefined;
      if (typeof type === "string" && type !== "idle") now.add(id);
    }
    for (const id of this.busy) {
      if (!now.has(id)) this.ended = true;
    }
    this.busy = now;
  }

  /** Why the turn's progress is due now, or null. */
  due(now: number): TurnProgressReason | null {
    if (!this.enabled) return null;
    if (now - this.startedAt < TURN_PROGRESS_MIN_AGE_MS) return null;
    const since = this.lastAt ?? this.startedAt;
    if (this.ended && (this.lastAt === null || now - this.lastAt >= TURN_PROGRESS_MIN_GAP_MS)) return "sub_agent_ended";
    if (now - since >= this.intervalMs) return "interval";
    return null;
  }

  /** The progress went out (or was tried): the next one is measured from now. */
  flushed(now: number): void {
    this.lastAt = now;
    this.ended = false;
  }

  /** How many messages went ahead in all. */
  get sentCount(): number {
    let count = 0;
    for (const session of this.sent.values()) count += session.size;
    return count;
  }

  /**
   * A session's settled messages not sent ahead yet, with their sizes
   * (`sizes` matches `messages`; `session` is "" for the root, else the
   * sub-agent's id). Its newest message is never among them.
   */
  ahead(messages: readonly unknown[], sizes: readonly number[], session = ""): { messages: unknown[]; sizes: number[] } {
    const count = settledPrefix(messages.slice(0, -1));
    const sent = this.sent.get(session);
    const out: unknown[] = [];
    const outSizes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = progressMessageId(messages[index]);
      if (!id || sent?.has(id)) continue;
      out.push(messages[index]);
      outSizes.push(sizes[index] ?? 0);
    }
    return { messages: out, sizes: outSizes };
  }

  /** Marks a session's messages as sent ahead (`sizes` matches `messages`). */
  markSent(messages: readonly unknown[], sizes: readonly number[], session = ""): void {
    let sent = this.sent.get(session);
    if (!sent) {
      sent = new Map();
      this.sent.set(session, sent);
    }
    for (const [index, message] of messages.entries()) {
      const id = progressMessageId(message);
      if (id) sent.set(id, sizes[index] ?? 0);
    }
  }

  /** The turn's messages its end still has to send: those not sent ahead, or changed since, with their sizes. */
  unsent(messages: readonly unknown[], sizes: readonly number[], session = ""): { messages: unknown[]; sizes: number[] } {
    const sent = this.sent.get(session);
    if (!sent || sent.size === 0) return { messages: messages.slice(), sizes: sizes.slice() };
    const out: unknown[] = [];
    const outSizes: number[] = [];
    for (const [index, message] of messages.entries()) {
      const id = progressMessageId(message);
      if (id && sent.get(id) === (sizes[index] ?? 0)) continue;
      out.push(message);
      outSizes.push(sizes[index] ?? 0);
    }
    return { messages: out, sizes: outSizes };
  }
}
