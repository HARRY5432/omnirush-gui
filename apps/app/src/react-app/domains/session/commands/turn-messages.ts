/**
 * Which user messages start a turn someone sent. A compaction adds user
 * messages of its own (the compaction request, and the automatic "continue"
 * after a compaction mid-turn); undo, redo and the prompt put back in the
 * composer skip them, so one undo takes back the whole turn.
 */
type MessageLike = { info: unknown; parts: ReadonlyArray<unknown> };

type PartLike = { type?: unknown; synthetic?: unknown; providerMetadata?: { opencode?: { synthetic?: unknown } } };

const isSynthetic = (part: PartLike) => part.synthetic === true || part.providerMetadata?.opencode?.synthetic === true;

/** A user message the person sent (not a compaction's request, its summary or its automatic follow-up). */
export function isPersonUserMessage(message: MessageLike | null | undefined): boolean {
  if (!message) return false;
  const info = message.info as { role?: unknown; summary?: unknown; mode?: unknown; agent?: unknown } | null;
  if (info?.role !== "user") return false;
  if (info.summary === true || info.mode === "compaction" || info.agent === "compaction") return false;
  const parts = message.parts as ReadonlyArray<PartLike>;
  if (parts.some((part) => part.type === "compaction" || part.type === "data-compaction")) return false;
  const text = parts.filter((part) => part.type === "text");
  return !(text.length > 0 && text.length === parts.length && text.every(isSynthetic));
}

/** The user messages that start turns, oldest first. */
export function personUserMessages<T extends MessageLike>(messages: readonly T[]): T[] {
  return messages.filter((message) => isPersonUserMessage(message));
}
