import { afterEach, describe, expect, test } from "bun:test";

import { __resetRevertedSessionsForTest, isSessionReverted, markSessionReverted } from "../src/react-app/domains/session/sync/reverted-sessions";

afterEach(() => __resetRevertedSessionsForTest());

describe("reverted sessions", () => {
  test("a revert cursor holds the chat, its clearing releases it", () => {
    expect(isSessionReverted("ses_a")).toBe(false);
    markSessionReverted("ses_a", "msg_1");
    expect(isSessionReverted("ses_a")).toBe(true);
    expect(isSessionReverted("ses_b")).toBe(false);
    markSessionReverted("ses_a", undefined);
    expect(isSessionReverted("ses_a")).toBe(false);
    markSessionReverted("ses_a", "msg_2");
    markSessionReverted("ses_a", null);
    expect(isSessionReverted("ses_a")).toBe(false);
  });
});
