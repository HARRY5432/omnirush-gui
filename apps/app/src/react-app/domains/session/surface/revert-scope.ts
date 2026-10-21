/**
 * How much of a chat a revert takes back. The engine rewinds to the person's
 * prompt at or before the chosen message (packages/opencode/src/session/
 * revert.ts): every turn from there on is hidden, the files go back to how
 * they were before it, and the next prompt deletes the hidden turns for good.
 */
type ScopeMessage = { id: string; role: string };

function revertPointIndex(messages: readonly ScopeMessage[], messageId: string): number {
  let index = messages.findIndex((message) => message.id === messageId);
  while (index > 0 && messages[index]?.role !== "user") index -= 1;
  return index;
}

/**
 * The person's prompt a revert at this message rewinds to (itself for a prompt, the prompt that started the
 * turn for a reply). Reverting at the prompt also takes back the file changes of the turn's earlier steps,
 * which a revert at a reply's last step leaves on disk. Null when the message is not on screen.
 */
export function revertPointMessageId(messages: readonly ScopeMessage[], messageId: string): string | null {
  const index = revertPointIndex(messages, messageId);
  const message = index < 0 ? null : messages[index];
  return message?.role === "user" ? message.id : null;
}

/** Turns (the person's prompts) a revert at this message takes back, its own included; null when not on screen. */
export function turnsFromRevertPoint(messages: readonly ScopeMessage[], messageId: string): number | null {
  const start = revertPointIndex(messages, messageId);
  if (start < 0) return null;
  let turns = 0;
  for (let at = start; at < messages.length; at += 1) {
    if (messages[at]?.role === "user") turns += 1;
  }
  return Math.max(turns, 1);
}

/** More than the newest turn, or a point not on screen (an older part of a long chat). */
export function revertNeedsConfirm(turns: number | null): boolean {
  return turns === null || turns > 1;
}

function laterTurns(turns: number | null): string {
  if (turns === null) return "every later turn";
  const later = turns - 1;
  return `the ${later} later turn${later === 1 ? "" : "s"}`;
}

/** The question before a revert from a message's Revert button. */
export function revertConfirmText(turns: number | null, running: boolean): string {
  const scope = turns === 1 ? "Hide this turn" : `Hide this and ${laterTurns(turns)}`;
  const stop = running ? " The running turn stops first." : "";
  return `${scope}, and undo their file changes?${stop} Restore brings them back until you send a new message.`;
}

/** The bar above the composer while it holds an edit of an earlier message. */
export function editTargetText(turns: number | null): string {
  if (turns === 1) return "Editing your last message: sending replaces it and undoes its file changes.";
  return `Editing an earlier message: sending will remove ${laterTurns(turns)} and undo their file changes.`;
}

/** The question before an edit of an earlier message goes out. */
export function editConfirmText(turns: number | null, hidden = 0): string {
  const hiddenToo = hidden > 0 ? ` The ${hidden} hidden message${hidden === 1 ? " goes" : "s go"} for good too.` : "";
  if (turns === 1) return `Send this in place of your last message? It undoes that turn's file changes.${hiddenToo}`;
  return `Send this in place of the earlier message? It removes ${laterTurns(turns)} for good and undoes their file changes.${hiddenToo}`;
}

/** The question before a send that would delete hidden (reverted) messages for good. */
export function hiddenDeleteConfirmText(hidden: number): string {
  return `Sending removes the ${hidden} hidden message${hidden === 1 ? "" : "s"} for good; their file changes stay undone. Send and remove them? (Cancel keeps them: Restore brings them back.)`;
}
