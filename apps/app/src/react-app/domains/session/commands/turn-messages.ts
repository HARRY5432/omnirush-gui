/**
 * Which user messages start a turn someone sent. A compaction adds user
 * messages of its own: the compaction request (its `compaction` part) and the
 * automatic "continue" after a compaction mid-turn (its text part's
 * `compaction_continue` marker). After compacting an overflowing context the
 * engine may also send the person's prompt again (same text, right after the
 * compaction): that replay counts as the original prompt. Undo, redo and the
 * prompt put back in the composer go by these turns, so one undo takes back
 * the whole turn. PARITY: the engine's TUI (packages/tui/src/util/undo-notice.ts
 * isPersonPrompt / undoTarget).
 */
type MessageLike = { info: unknown; parts: ReadonlyArray<unknown> };

type PartLike = { type?: unknown; synthetic?: unknown; text?: unknown; metadata?: { compaction_continue?: unknown } | null };

const partsOf = (message: MessageLike) => message.parts as ReadonlyArray<PartLike>;
const isUser = (message: MessageLike) => (message.info as { role?: unknown } | null)?.role === "user";
const isCompaction = (message: MessageLike) => partsOf(message).some((part) => part.type === "compaction" || part.type === "data-compaction");

/** A user message the person sent (not a compaction's request or its automatic follow-up). */
export function isPersonUserMessage(message: MessageLike | null | undefined): boolean {
  if (!message || !isUser(message)) return false;
  if (isCompaction(message)) return false;
  return !partsOf(message).some((part) => part.type === "text" && part.metadata?.compaction_continue === true);
}

/** The text the person typed (synthetic text left out), to recognise a replayed prompt. */
function promptText(message: MessageLike): string {
  return partsOf(message)
    .filter((part) => part.type === "text" && !part.synthetic)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

/**
 * The user messages that start turns, oldest first: the person's prompts,
 * with a prompt the engine replayed after a compaction counted as the
 * original (left out here).
 */
export function personUserMessages<T extends MessageLike>(messages: readonly T[]): T[] {
  const users = messages.filter((message) => isUser(message));
  return users.filter((message, index) => {
    if (!isPersonUserMessage(message)) return false;
    const compaction = users[index - 1];
    const earlier = users[index - 2];
    if (!compaction || !earlier || !isCompaction(compaction) || !isPersonUserMessage(earlier)) return true;
    const text = promptText(message);
    return !text || text !== promptText(earlier);
  });
}
