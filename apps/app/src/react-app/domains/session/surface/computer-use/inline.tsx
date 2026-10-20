import type { ComputerUseRequest, ComputerUseSessionState } from "@omnirush/types/desktop-ipc";

import { belongsToChat } from "./describe";
import { ComputerUseLivePanel } from "./live-panel";
import { ComputerUseRequestCard } from "./request-card";
import { useComputerUseStatus, useRegisterInlineComputerUse } from "./status-store";

export type ComputerUseForChat = {
  requests: ComputerUseRequest[];
  sessions: ComputerUseSessionState[];
};

export function isLiveComputerUseSession(session: ComputerUseSessionState): boolean {
  return session.phase === "working" || session.phase === "paused";
}

/** The requests and running sessions this chat shows inline (and claims from the global fallback). */
export function useComputerUseForChat(sessionId: string): ComputerUseForChat {
  useRegisterInlineComputerUse(sessionId);
  const status = useComputerUseStatus();
  return {
    requests: status?.requests.filter((request) => belongsToChat(request.chat, sessionId)) ?? [],
    sessions: status?.sessions.filter((session) => isLiveComputerUseSession(session) && belongsToChat(session.chat, sessionId)) ?? [],
  };
}

/** Running sessions first, then the approvals waiting for the person. */
export function ComputerUseInline(props: ComputerUseForChat) {
  return (
    <>
      {props.sessions.map((session) => <ComputerUseLivePanel key={session.id} session={session} />)}
      {props.requests.map((request) => <ComputerUseRequestCard key={request.request_id} request={request} />)}
    </>
  );
}
