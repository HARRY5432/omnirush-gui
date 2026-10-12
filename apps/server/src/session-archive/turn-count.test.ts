// One turn count for the CLI and the desktop app (turn-prompts.ts, byte-identical
// in both, listed in PARITY.sha256). The CLI's test/turn-count.test.js counts
// the same list to the same numbers.
import { describe, expect, test } from "bun:test";

import { completedTurnCount, promptTurnAt } from "./turn-prompts.js";

const user = (id: string, created: number, parts: unknown[] = [{ type: "text", text: "do it" }], extra: Record<string, unknown> = {}) => ({ info: { id, role: "user", time: { created }, ...extra }, parts });
const done = (id: string, created: number) => ({ info: { id, role: "assistant", time: { created, completed: created + 1 }, finish: "stop" }, parts: [{ type: "step-finish" }] });
const running = (id: string, created: number) => ({ info: { id, role: "assistant", time: { created } }, parts: [] });

const SESSION = [
  user("m1", 10), done("m2", 11),
  user("m3", 20, [{ type: "compaction" }]), done("m4", 21),
  user("m5", 30, [{ type: "text", text: "notice", synthetic: true }]), done("m6", 31),
  user("m7", 40), done("m8", 41), done("m9", 42),
  user("m10", 50),
  user("m11", 60, [{ type: "text", text: "summarize" }], { agent: "compaction" }), done("m12", 61),
  user("m13", 70), running("m14", 71),
];

describe("turn count (shared with the CLI)", () => {
  test("compaction and synthetic messages are no turn; a stopped prompt is one; the running one is not yet", () => {
    expect(completedTurnCount(SESSION)).toBe(3);
    expect(promptTurnAt(SESSION, 45)).toBe(2);
    expect(promptTurnAt(SESSION, 75)).toBe(4);
    expect(completedTurnCount(null)).toBeNull();
  });
});
