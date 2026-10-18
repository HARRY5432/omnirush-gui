import { describe, expect, test } from "bun:test";

import { closeOpenToolParts, TOOL_ABORTED_ERROR } from "./context/open-tools.js";

// The same cases as the CLI's test/tool-abort.test.js (open-tools.ts is shared, PARITY.sha256).
const tool = (status: string, extra: Record<string, unknown> = {}) => ({ id: "prt_1", type: "tool", tool: "edit", callID: "call_a|fc_b", state: { status, input: { filePath: "a.ts" }, ...extra } });
const dropped = (part: unknown) => ({
  info: { id: "a1", role: "assistant", time: { created: 10, completed: 50 }, finish: "error", error: { name: "APIError" } },
  parts: [{ type: "step-start" }, part, { type: "step-finish", reason: "error" }],
});

describe("closeOpenToolParts", () => {
  test("a running call of an answer that ended is closed as aborted, at the answer's end", () => {
    const { messages, closed } = closeOpenToolParts([dropped(tool("running", { time: { start: 40 } }))], { engineIdle: false });
    expect(closed).toBe(1);
    expect((messages[0] as { parts: Array<{ state: unknown }> }).parts[1]!.state).toEqual({
      status: "error", input: { filePath: "a.ts" }, error: TOOL_ABORTED_ERROR, metadata: { interrupted: true }, time: { start: 40, end: 50 },
    });
  });

  test("an answer still streaming keeps its calls open while the engine runs, and not once it stopped", () => {
    const live = { info: { id: "a1", role: "assistant", time: { created: 10 } }, parts: [tool("pending")] };
    expect(closeOpenToolParts([live], { engineIdle: false })).toEqual({ messages: [live], closed: 0 });
    const idle = closeOpenToolParts([live], { engineIdle: true, now: 99 });
    expect(idle.closed).toBe(1);
    expect((idle.messages[0] as unknown as { parts: Array<{ state: { time: unknown } }> }).parts[0]!.state.time).toEqual({ start: 99, end: 99 });
    expect(live.parts[0]!.state.status).toBe("pending");
  });

  test("finished calls and user messages are untouched", () => {
    const done = dropped(tool("completed", { output: "ok", time: { start: 1, end: 2 } }));
    const user = { info: { id: "u1", role: "user" }, parts: [{ type: "tool", state: { status: "running" } }] };
    const { messages, closed } = closeOpenToolParts([user, done], { engineIdle: true });
    expect(closed).toBe(0);
    expect(messages[0]).toBe(user);
    expect(messages[1]).toBe(done);
  });
});
