/**
 * How much of a chat a revert takes back. The engine rewinds to the person's
 * prompt at or before the chosen message (packages/opencode/src/session/
 * revert.ts): every turn from there on is hidden, the files go back to how
 * they were before it, and the next prompt deletes the hidden turns for good.
 * Reverting or editing the newest turn is a small step; anything further back
 * asks first, saying how many turns go.
 */
type ScopeMessage = { id: string; role: string };

/** Turns (the person's prompts) a revert at this message takes back; null when the message is not on screen. */
export function turnsFromRevertPoint(messages: readonly ScopeMessage[], messageId: string): number | null {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return null;
  let start = index;
  while (start > 0 && messages[start]?.role !== "user") start -= 1;
  let turns = 0;
  for (let at = start; at < messages.length; at += 1) {
    if (messages[at]?.role === "user") turns += 1;
  }
  return Math.max(turns, 1);
}

/** More than the newest turn, or a point not on screen (an older part of a long chat): ask first. */
export function revertNeedsConfirm(turns: number | null): boolean {
  return turns === null || turns > 1;
}

function turnsLabel(turns: number | null): string {
  return turns === null ? "every turn from there on" : `the last ${turns} turns`;
}

/** The question before a revert or an edit of an earlier message goes ahead. */
export function revertConfirmText(kind: "revert" | "edit", turns: number | null): string {
  if (kind === "edit") {
    return `Send this in place of the earlier message? It removes ${turnsLabel(turns)} of this chat and takes back the file changes they made. This cannot be undone.`;
  }
  return `Revert to this point? This hides ${turnsLabel(turns)} of this chat and takes back the file changes they made. Restore brings them back, until you send a new message.`;
}
