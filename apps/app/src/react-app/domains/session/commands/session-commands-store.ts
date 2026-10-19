import { create } from "zustand";

/**
 * What a mounted chat surface offers the session header and the Changes
 * panel: sending a chat command ("/review", "/fix 1, 3") through the
 * composer's own send path, so it queues, shows and recovers like a typed one.
 */
export type SessionCommandBridge = {
  runCommand: (text: string) => void | Promise<void>;
  /** The chat is working (a turn runs or a send is on its way). */
  busy: boolean;
};

type SessionCommandsStore = {
  bridges: Record<string, SessionCommandBridge>;
  /** The chat whose Changes panel is open, or null. */
  changesOpenFor: string | null;
  register: (sessionId: string, bridge: SessionCommandBridge) => () => void;
  openChanges: (sessionId: string) => void;
  closeChanges: () => void;
};

export const useSessionCommandsStore = create<SessionCommandsStore>((set, get) => ({
  bridges: {},
  changesOpenFor: null,
  register: (sessionId, bridge) => {
    set((state) => ({ bridges: { ...state.bridges, [sessionId]: bridge } }));
    return () => {
      if (get().bridges[sessionId] !== bridge) return;
      set((state) => {
        const next = { ...state.bridges };
        delete next[sessionId];
        return { bridges: next };
      });
    };
  },
  openChanges: (sessionId) => set({ changesOpenFor: sessionId }),
  closeChanges: () => set({ changesOpenFor: null }),
}));

export function useSessionCommandBridge(sessionId: string | null | undefined): SessionCommandBridge | null {
  return useSessionCommandsStore((state) => (sessionId ? state.bridges[sessionId] ?? null : null));
}
