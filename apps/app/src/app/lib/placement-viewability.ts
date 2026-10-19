// Sponsored placements: the viewable measurement (desktop only).
//
// A display is viewable once at least half of its card has been on screen
// for one continuous second while the page is visible and the app window is
// focused (not minimized, not hidden). Any condition failing resets the
// second. It fires at most once per display: scrolling away and back, typing
// or a streaming reply never count it again. Without IntersectionObserver
// nothing is measured (and nothing counted).

/** At least this share of the card in the viewport. */
export const VIEWABLE_RATIO = 0.5;
/** For this long, continuously. */
export const VIEWABLE_MS = 1_000;
/** Main → page window state (apps/desktop/electron/placements-desktop.mjs WINDOW_STATE_CHANNEL, re-sent by the preload). */
export const WINDOW_STATE_EVENT = "omnirush:placements:window";

export type ViewabilityConditions = {
  /** The card's intersection ratio with the viewport (0 when not intersecting). */
  ratio: number;
  /** document.visibilityState === "visible" */
  pageVisible: boolean;
  /** document.hasFocus() / window focus, and the window not minimized or hidden. */
  windowFocused: boolean;
};

export function qualifies(c: ViewabilityConditions): boolean {
  return c.ratio >= VIEWABLE_RATIO && c.pageVisible && c.windowFocused;
}

type TimerFns = {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => number;
};

export type ViewabilityTimer = {
  /** New measurements (any subset); starts, keeps or resets the continuous second. */
  update: (next: Partial<ViewabilityConditions>) => void;
  /** Stops for good (unmounted). */
  stop: () => void;
  /** Whether it fired. */
  fired: () => boolean;
};

/** The continuous-second timer: `onViewable` at most once. */
export function createViewabilityTimer(
  onViewable: () => void,
  { setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t as ReturnType<typeof setTimeout>), now = Date.now }: TimerFns = {},
): ViewabilityTimer {
  let conditions: ViewabilityConditions = { ratio: 0, pageVisible: false, windowFocused: false };
  let timer: unknown = null;
  let since = 0;
  let done = false;
  let stopped = false;

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const arm = (ms: number) => {
    timer = setTimer(() => {
      timer = null;
      if (done || stopped || !qualifies(conditions)) return;
      // A timer may run late, never early; checked against the clock anyway.
      const left = VIEWABLE_MS - (now() - since);
      if (left > 0) {
        arm(left);
        return;
      }
      done = true;
      onViewable();
    }, ms);
  };

  return {
    update(next) {
      if (done || stopped) return;
      conditions = { ...conditions, ...next };
      if (!qualifies(conditions)) {
        cancel();
        return;
      }
      if (timer === null) {
        since = now();
        arm(VIEWABLE_MS);
      }
    },
    stop() {
      stopped = true;
      cancel();
    },
    fired: () => done,
  };
}

type ObserverEntry = { isIntersecting: boolean; intersectionRatio: number };
type ObserverCtor = new (callback: (entries: ObserverEntry[]) => void, options: { threshold: number[] }) => { observe: (el: Element) => void; disconnect: () => void };

export type ViewabilityEnv = {
  win: Pick<Window, "addEventListener" | "removeEventListener">;
  doc: Pick<Document, "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener">;
  IntersectionObserver?: ObserverCtor | null;
} & TimerFns;

function defaultEnv(): ViewabilityEnv | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return { win: window, doc: document, IntersectionObserver: (globalThis as { IntersectionObserver?: ObserverCtor }).IntersectionObserver ?? null };
}

type WindowState = {
  /** The last focus / blur the window reported (null: none yet; document.hasFocus() decides). */
  focused: boolean | null;
  minimized: boolean;
  visible: boolean;
};
type WindowTracker = { state: WindowState; listen: (fn: () => void) => () => void };

const trackers = new WeakMap<object, WindowTracker>();

/**
 * The app window's state, followed from the page's start (not from a card's
 * mount): the main process keeps the page "visible" while the window is
 * hidden or minimized (no background throttling), so its own report
 * (WINDOW_STATE_EVENT) and the focus / blur events are remembered here for
 * every card that mounts later.
 */
export function trackPlacementWindow(win: ViewabilityEnv["win"] | null = typeof window === "undefined" ? null : window): WindowTracker | null {
  if (!win) return null;
  const known = trackers.get(win);
  if (known) return known;
  const state: WindowState = { focused: null, minimized: false, visible: true };
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const fn of listeners) fn();
  };
  win.addEventListener("focus", () => {
    state.focused = true;
    changed();
  });
  win.addEventListener("blur", () => {
    state.focused = false;
    changed();
  });
  win.addEventListener(WINDOW_STATE_EVENT, (event: Event) => {
    const detail: unknown = "detail" in event ? event.detail : null;
    if (!detail || typeof detail !== "object") return;
    const next = detail as { focused?: unknown; minimized?: unknown; visible?: unknown };
    if (typeof next.focused === "boolean") state.focused = next.focused;
    if (typeof next.minimized === "boolean") state.minimized = next.minimized;
    if (typeof next.visible === "boolean") state.visible = next.visible;
    changed();
  });
  const tracker: WindowTracker = {
    state,
    listen(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  trackers.set(win, tracker);
  return tracker;
}

/**
 * Measures `element` (the card) and calls `onViewable` once when it
 * qualifies. Resolves the cleanup.
 */
export function observeViewability(element: Element, onViewable: () => void, env: ViewabilityEnv | null = defaultEnv()): () => void {
  if (!env || typeof env.IntersectionObserver !== "function") return () => undefined;
  const { doc } = env;
  const tracker = trackPlacementWindow(env.win);
  if (!tracker) return () => undefined;
  const timer = createViewabilityTimer(onViewable, env);
  const shown = () => tracker.state.visible && !tracker.state.minimized;
  // Any signal of "not focused" wins: the window's last report and the document's own focus.
  const conditions = () => ({
    pageVisible: doc.visibilityState === "visible" && shown(),
    windowFocused: shown() && tracker.state.focused !== false && doc.hasFocus(),
  });
  timer.update(conditions());

  const observer = new env.IntersectionObserver(
    (entries) => {
      const last = entries[entries.length - 1];
      if (!last) return;
      timer.update({ ratio: last.isIntersecting ? last.intersectionRatio : 0 });
    },
    { threshold: [0, VIEWABLE_RATIO, 1] },
  );
  observer.observe(element);

  const update = () => timer.update(conditions());
  const unlisten = tracker.listen(update);
  doc.addEventListener("visibilitychange", update);

  return () => {
    timer.stop();
    observer.disconnect();
    unlisten();
    doc.removeEventListener("visibilitychange", update);
  };
}
