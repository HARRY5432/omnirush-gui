import { describe, expect, test } from "bun:test";

import { createTurnActivity } from "./turn-activity.js";

type Busy = { sessions: string[]; unknown: number };

function harness(initial: Busy | Error = { sessions: [], unknown: 0 }) {
  let clock = 1_000;
  let answer: Busy | Error = initial;
  const changes: boolean[] = [];
  const activity = createTurnActivity({
    busy: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
    onChange: (running) => changes.push(running),
    pollMs: 5,
    graceMs: 1_000,
    unknownLimitMs: 10_000,
    now: () => clock,
  });
  return {
    activity,
    changes,
    advance: (ms: number) => { clock += ms; },
    answer: (next: Busy | Error) => { answer = next; },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("turn activity", () => {
  test("running from the prompt dispatch until the engine runs no session", async () => {
    const h = harness({ sessions: ["ses_1"], unknown: 0 });
    expect(h.activity.running).toBe(false);
    h.activity.promptDispatched();
    expect(h.changes).toEqual([true]);
    h.activity.promptDispatched();
    expect(h.changes).toEqual([true]);
    h.advance(5_000);
    await settle();
    expect(h.activity.running).toBe(true);
    // The turn ended (finished, stopped or failed: the engine is idle either way).
    h.answer({ sessions: [], unknown: 0 });
    await settle();
    expect(h.changes).toEqual([true, false]);
    h.activity.stop();
  });

  test("a prompt still on its way is not let go (grace after the last dispatch)", async () => {
    const h = harness({ sessions: [], unknown: 0 });
    h.activity.promptDispatched();
    await settle();
    expect(h.activity.running).toBe(true);
    h.advance(1_001);
    await settle();
    expect(h.changes).toEqual([true, false]);
    h.activity.stop();
  });

  test("an unreadable status counts as running, for a limited time", async () => {
    const h = harness(new Error("engine gone"));
    h.activity.promptDispatched();
    h.advance(2_000);
    await settle();
    expect(h.activity.running).toBe(true);
    h.advance(10_001);
    await settle();
    expect(h.changes).toEqual([true, false]);
    h.activity.stop();
  });

  test("stop ends it (the server stops)", () => {
    const h = harness({ sessions: ["ses_1"], unknown: 0 });
    h.activity.promptDispatched();
    h.activity.stop();
    expect(h.changes).toEqual([true, false]);
    h.activity.promptDispatched();
    expect(h.changes).toEqual([true, false]);
  });

  test("a listener that throws never stops the server", () => {
    const activity = createTurnActivity({ busy: async () => ({ sessions: [], unknown: 0 }), onChange: () => { throw new Error("boom"); } });
    expect(() => activity.promptDispatched()).not.toThrow();
    activity.stop();
  });
});
