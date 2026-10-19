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

/**
 * Measures `element` (the card) and calls `onViewable` once when it
 * qualifies. Resolves the cleanup.
 */
export function observeViewability(element: Element, onViewable: () => void, env: ViewabilityEnv | null = defaultEnv()): () => void {
  if (!env || typeof env.IntersectionObserver !== "function") return () => undefined;
  const { win, doc } = env;
  const timer = createViewabilityTimer(onViewable, env);
  let minimized = false;
  let hidden = false;
  const focus = () => !minimized && !hidden && doc.hasFocus();
  const pageVisible = () => doc.visibilityState === "visible";
  timer.update({ pageVisible: pageVisible(), windowFocused: focus() });

  const observer = new env.IntersectionObserver(
    (entries) => {
      const last = entries[entries.length - 1];
      if (!last) return;
      timer.update({ ratio: last.isIntersecting ? last.intersectionRatio : 0 });
    },
    { threshold: [0, VIEWABLE_RATIO, 1] },
  );
  observer.observe(element);

  const onVisibility = () => timer.update({ pageVisible: pageVisible(), windowFocused: focus() });
  const onFocus = () => timer.update({ windowFocused: focus() });
  const onBlur = () => timer.update({ windowFocused: false });
  const onWindowState = (event: Event) => {
    const detail = (event as CustomEvent<{ focused?: boolean; minimized?: boolean; visible?: boolean }>).detail ?? {};
    minimized = detail.minimized === true;
    hidden = detail.visible === false;
    timer.update({ windowFocused: detail.focused === false ? false : focus(), pageVisible: pageVisible() });
  };
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("focus", onFocus);
  win.addEventListener("blur", onBlur);
  win.addEventListener(WINDOW_STATE_EVENT, onWindowState);

  return () => {
    timer.stop();
    observer.disconnect();
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("focus", onFocus);
    win.removeEventListener("blur", onBlur);
    win.removeEventListener(WINDOW_STATE_EVENT, onWindowState);
  };
}
