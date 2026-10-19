import { describe, expect, test } from "bun:test";

import {
  createViewabilityTimer,
  observeViewability,
  qualifies,
  VIEWABLE_MS,
  VIEWABLE_RATIO,
  WINDOW_STATE_EVENT,
} from "../src/app/lib/placement-viewability";

/** A manual clock: timers run only when `advance` passes them. */
function clock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

const ALL = { ratio: 1, pageVisible: true, windowFocused: true };

describe("viewability: the rule", () => {
  test("≥ 50% visible, page visible and window focused", () => {
    expect(VIEWABLE_RATIO).toBe(0.5);
    expect(VIEWABLE_MS).toBe(1_000);
    expect(qualifies(ALL)).toBe(true);
    expect(qualifies({ ...ALL, ratio: 0.5 })).toBe(true);
    expect(qualifies({ ...ALL, ratio: 0.49 })).toBe(false);
    expect(qualifies({ ...ALL, pageVisible: false })).toBe(false);
    expect(qualifies({ ...ALL, windowFocused: false })).toBe(false);
  });
});

describe("viewability: the continuous second", () => {
  test("fires after one continuous second, not before", () => {
    const c = clock();
    let fired = 0;
    const t = createViewabilityTimer(() => fired++, c);
    t.update(ALL);
    c.advance(999);
    expect(fired).toBe(0);
    c.advance(1);
    expect(fired).toBe(1);
    expect(t.fired()).toBe(true);
  });

  test("below the threshold never fires", () => {
    const c = clock();
    let fired = 0;
    const t = createViewabilityTimer(() => fired++, c);
    t.update({ ...ALL, ratio: 0.4 });
    c.advance(10_000);
    expect(fired).toBe(0);
  });

  for (const [name, fail] of [
    ["blur", { windowFocused: false }],
    ["hidden page", { pageVisible: false }],
    ["minimize (window not focused)", { windowFocused: false }],
    ["scrolled out", { ratio: 0 }],
    ["scrolled to under half", { ratio: 0.3 }],
  ] as const) {
    test(`resets on ${name}`, () => {
      const c = clock();
      let fired = 0;
      const t = createViewabilityTimer(() => fired++, c);
      t.update(ALL);
      c.advance(800);
      t.update(fail);
      c.advance(5_000);
      expect(fired).toBe(0);
      expect(c.pending()).toBe(0);
      // Back: a full second again, from zero.
      t.update(ALL);
      c.advance(800);
      expect(fired).toBe(0);
      c.advance(200);
      expect(fired).toBe(1);
    });
  }

  test("several short looks never add up", () => {
    const c = clock();
    let fired = 0;
    const t = createViewabilityTimer(() => fired++, c);
    for (let i = 0; i < 10; i++) {
      t.update(ALL);
      c.advance(900);
      t.update({ windowFocused: false });
      c.advance(100);
    }
    expect(fired).toBe(0);
  });

  test("once per display: scrolling away and back, typing or streaming never count again", () => {
    const c = clock();
    let fired = 0;
    const t = createViewabilityTimer(() => fired++, c);
    t.update(ALL);
    c.advance(1_000);
    expect(fired).toBe(1);
    for (let i = 0; i < 5; i++) {
      t.update({ ratio: 0 });
      c.advance(500);
      t.update({ ratio: 1 });
      c.advance(2_000);
      // Re-renders while typing or streaming send the same conditions again.
      t.update(ALL);
      c.advance(2_000);
    }
    expect(fired).toBe(1);
  });

  test("updates with the same conditions keep the running second (no restart)", () => {
    const c = clock();
    let fired = 0;
    const t = createViewabilityTimer(() => fired++, c);
    t.update(ALL);
    c.advance(600);
    t.update(ALL);
    t.update({ ratio: 0.9 });
    c.advance(400);
    expect(fired).toBe(1);
  });

  test("a stopped timer (unmounted card) never fires", () => {
    const c = clock();
    let fired = 0;
    const t = createViewabilityTimer(() => fired++, c);
    t.update(ALL);
    c.advance(500);
    t.stop();
    c.advance(5_000);
    t.update(ALL);
    c.advance(5_000);
    expect(fired).toBe(0);
  });
});

/** A fake page: an IntersectionObserver, focus, visibility and the main process's window state. */
function page({ focused = true, visible = true } = {}) {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const docListeners = new Map<string, Set<() => void>>();
  let observerCallback: ((entries: { isIntersecting: boolean; intersectionRatio: number }[]) => void) | null = null;
  let disconnected = false;
  const state = { focused, visible };
  const c = clock();
  const env = {
    ...c,
    win: {
      addEventListener: (type: string, fn: (e: Event) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (e: Event) => void) => listeners.get(type)?.delete(fn),
    },
    doc: {
      get visibilityState() {
        return state.visible ? "visible" : "hidden";
      },
      hasFocus: () => state.focused,
      addEventListener: (type: string, fn: () => void) => {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => docListeners.get(type)?.delete(fn),
    },
    IntersectionObserver: class {
      constructor(cb: typeof observerCallback, options: { threshold: number[] }) {
        observerCallback = cb;
        expect(options.threshold).toContain(0.5);
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  };
  const emit = (type: string, detail?: unknown) => {
    for (const fn of listeners.get(type) ?? []) fn(detail === undefined ? new Event(type) : new CustomEvent(type, { detail }));
  };
  return {
    env: env as never,
    clock: c,
    intersect: (ratio: number) => observerCallback?.([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]),
    focus: () => {
      state.focused = true;
      emit("focus");
    },
    blur: () => {
      state.focused = false;
      emit("blur");
    },
    hide: () => {
      state.visible = false;
      for (const fn of docListeners.get("visibilitychange") ?? []) fn();
    },
    show: () => {
      state.visible = true;
      for (const fn of docListeners.get("visibilitychange") ?? []) fn();
    },
    windowState: (detail: { focused: boolean; minimized: boolean; visible: boolean }) => emit(WINDOW_STATE_EVENT, detail),
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0) + [...docListeners.values()].reduce((n, s) => n + s.size, 0),
    disconnected: () => disconnected,
  };
}

const el = {} as Element;

describe("viewability: on the page", () => {
  test("visible card, focused window: viewable after 1 s", () => {
    const p = page();
    let fired = 0;
    observeViewability(el, () => fired++, p.env);
    p.intersect(0.8);
    p.clock.advance(999);
    expect(fired).toBe(0);
    p.clock.advance(1);
    expect(fired).toBe(1);
  });

  test("blurred window: none, until focused for a full second", () => {
    const p = page({ focused: false });
    let fired = 0;
    observeViewability(el, () => fired++, p.env);
    p.intersect(1);
    p.clock.advance(5_000);
    expect(fired).toBe(0);
    p.focus();
    p.clock.advance(1_000);
    expect(fired).toBe(1);
  });

  test("hidden page: none", () => {
    const p = page({ visible: false });
    let fired = 0;
    observeViewability(el, () => fired++, p.env);
    p.intersect(1);
    p.clock.advance(5_000);
    expect(fired).toBe(0);
  });

  test("blur, hide, minimize and scroll-out each reset the second", () => {
    const p = page();
    let fired = 0;
    observeViewability(el, () => fired++, p.env);
    p.intersect(1);
    p.clock.advance(900);
    p.blur();
    p.clock.advance(100);
    p.focus();
    p.clock.advance(900);
    p.hide();
    p.clock.advance(100);
    p.show();
    p.clock.advance(900);
    p.windowState({ focused: false, minimized: true, visible: true });
    p.clock.advance(5_000);
    p.windowState({ focused: true, minimized: false, visible: true });
    p.clock.advance(900);
    p.intersect(0.2);
    p.clock.advance(100);
    p.intersect(1);
    p.clock.advance(900);
    expect(fired).toBe(0);
    p.clock.advance(100);
    expect(fired).toBe(1);
  });

  test("minimized but still reporting focus: no count", () => {
    const p = page();
    let fired = 0;
    observeViewability(el, () => fired++, p.env);
    p.windowState({ focused: true, minimized: true, visible: true });
    p.intersect(1);
    p.clock.advance(5_000);
    expect(fired).toBe(0);
  });

  test("once: scrolling away and back does not count again", () => {
    const p = page();
    let fired = 0;
    observeViewability(el, () => fired++, p.env);
    p.intersect(1);
    p.clock.advance(1_000);
    p.intersect(0);
    p.clock.advance(1_000);
    p.intersect(1);
    p.clock.advance(5_000);
    expect(fired).toBe(1);
  });

  test("no IntersectionObserver: nothing measured, nothing counted", () => {
    const p = page();
    let fired = 0;
    const stop = observeViewability(el, () => fired++, { ...(p.env as object), IntersectionObserver: null } as never);
    p.clock.advance(5_000);
    expect(fired).toBe(0);
    stop();
  });

  test("cleanup removes every listener and the observer", () => {
    const p = page();
    const stop = observeViewability(el, () => undefined, p.env);
    expect(p.listenerCount()).toBeGreaterThan(0);
    stop();
    expect(p.listenerCount()).toBe(0);
    expect(p.disconnected()).toBe(true);
  });
});
