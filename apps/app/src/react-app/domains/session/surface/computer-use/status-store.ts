// Computer use status from Electron main: one read on first use, then the
// pushes on "omnirush:computer-use:status" (every session change, new frame
// and agent cursor move).

import { useEffect, useSyncExternalStore } from "react";
import { create } from "zustand";

import type { ComputerUseButtonRect, ComputerUseControlAction, ComputerUseStatus } from "@omnirush/types/desktop-ipc";

/** The pressed button's box, for main's check that the person pressed it themselves (Continue). */
export function buttonRect(target: EventTarget | null): ComputerUseButtonRect | undefined {
  if (!(target instanceof Element)) return undefined;
  const r = target.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

let current: ComputerUseStatus | null = null;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function emit(next: ComputerUseStatus) {
  current = next;
  for (const listener of listeners) listener();
}

function start() {
  const bridge = window.__OMNIRUSH_ELECTRON__;
  const invoke = bridge?.invokeDesktop;
  if (!invoke) return;
  let live = true;
  let pushed = false;
  const off = bridge?.computerUse?.onStatus?.((status) => {
    pushed = true;
    emit(status);
  });
  invoke("getComputerUseState")
    .then((status) => {
      if (live && !pushed) emit(status);
    })
    .catch(() => undefined);
  stop = () => {
    live = false;
    off?.();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stop?.();
    stop = null;
  };
}

function snapshot() {
  return current;
}

/** The latest status, or null before the first answer (or outside the desktop app). */
export function useComputerUseStatus(): ComputerUseStatus | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** Chats whose surface shows computer use inline (one entry per mounted surface). */
export const useInlineComputerUseChats = create<{ chats: string[] }>(() => ({ chats: [] }));

/** Registers a chat surface that shows computer use inline, so the global fallback skips its sessions. */
export function useRegisterInlineComputerUse(sessionId: string) {
  useEffect(() => {
    useInlineComputerUseChats.setState((state) => ({ chats: [...state.chats, sessionId] }));
    return () => {
      useInlineComputerUseChats.setState((state) => {
        const index = state.chats.indexOf(sessionId);
        return { chats: index === -1 ? state.chats : state.chats.filter((_, at) => at !== index) };
      });
    };
  }, [sessionId]);
}

/** Stop, take over or continue a session. */
export async function controlComputerUse(session_id: string, action: ComputerUseControlAction, rect?: ComputerUseButtonRect) {
  const invoke = window.__OMNIRUSH_ELECTRON__?.invokeDesktop;
  if (!invoke) throw new Error("Computer use needs the desktop app.");
  await invoke("computerUseControl", { session_id, action, ...(rect ? { rect } : {}) });
}
