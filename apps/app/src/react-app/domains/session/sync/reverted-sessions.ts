/**
 * Chats with turns hidden by a revert (the engine's `session.revert`). The
 * engine deletes hidden turns for good on the next prompt, so nothing may send
 * into such a chat on its own (a queued draft, a background drain): only a send
 * the person confirmed. Kept in step with every place the app learns the
 * revert cursor: snapshots, session.updated events, revert and restore.
 */
const reverted = new Set<string>();

export function markSessionReverted(sessionId: string, revertMessageId: string | null | undefined): void {
  if (!sessionId) return;
  if (revertMessageId) reverted.add(sessionId);
  else reverted.delete(sessionId);
}

export function isSessionReverted(sessionId: string): boolean {
  return reverted.has(sessionId);
}

export function __resetRevertedSessionsForTest(): void {
  reverted.clear();
}
