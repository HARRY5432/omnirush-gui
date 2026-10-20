import { ComputerUseInline, isLiveComputerUseSession } from "./computer-use/inline";
import { useComputerUseStatus, useInlineComputerUseChats } from "./computer-use/status-store";

/**
 * Fallback for computer use approvals and running sessions no open chat shows
 * inline (another chat, or no chat on screen), so an approval and Stop are
 * never out of sight.
 */
export function ComputerUseControls() {
  const status = useComputerUseStatus();
  const chats = useInlineComputerUseChats((state) => state.chats);
  const unseen = (chat: string | null) => (chat === null ? chats.length === 0 : !chats.includes(chat));
  const requests = status?.requests.filter((request) => unseen(request.chat)) ?? [];
  const sessions = status?.sessions.filter((session) => isLiveComputerUseSession(session) && unseen(session.chat)) ?? [];
  if (!requests.length && !sessions.length) return null;
  return (
    <aside
      aria-label="Computer use"
      className="fixed bottom-6 right-6 z-50 flex max-h-[calc(100vh-3rem)] w-[26rem] max-w-[calc(100vw-3rem)] flex-col overflow-y-auto rounded-2xl border border-dls-border bg-background shadow-lg"
    >
      <ComputerUseInline requests={requests} sessions={sessions} />
    </aside>
  );
}
