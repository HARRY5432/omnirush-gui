import type { ComputerUseSessionState } from "@omnirush/types/desktop-ipc";

import { belongsToChat } from "./describe";
import { ComputerUseLivePanel } from "./live-panel";
import { useComputerUseStatus, useRegisterInlineComputerUse } from "./status-store";

export function isLiveComputerUseSession(session: ComputerUseSessionState): boolean {
  return session.phase === "working" || session.phase === "paused";
}

/** The running sessions this chat shows inline (and claims from the global fallback). */
export function useComputerUseForChat(sessionId: string): ComputerUseSessionState[] {
  useRegisterInlineComputerUse(sessionId);
  const status = useComputerUseStatus();
  return status?.sessions.filter((session) => isLiveComputerUseSession(session) && belongsToChat(session.chat, sessionId)) ?? [];
}

/** Running sessions: what the agent sees, its cursor, and Stop. */
export function ComputerUseInline(props: { sessions: ComputerUseSessionState[] }) {
  return (
    <>
      {props.sessions.map((session) => <ComputerUseLivePanel key={session.id} session={session} />)}
    </>
  );
}
