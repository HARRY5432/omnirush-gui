import { describe, expect, test } from "bun:test";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { getAssistantRenderGroups } from "../src/components/chat/utils";
import {
  belongsToChat,
  describeComputerUseAction,
  formatMinutesLeft,
  pointsOf,
  scalePoints,
} from "../src/react-app/domains/session/surface/computer-use/describe";

describe("computer use action in plain words", () => {
  test("pointer actions", () => {
    expect(describeComputerUseAction({ type: "click", x: 120.4, y: 48 })).toBe("Click at 120, 48");
    expect(describeComputerUseAction({ type: "double_click", x: 1, y: 2 })).toBe("Double click at 1, 2");
    expect(describeComputerUseAction({ type: "right_click", x: 1, y: 2, modifiers: ["shift"] })).toBe("Right click at 1, 2 holding Shift");
    expect(describeComputerUseAction({ type: "move", x: 5, y: 6 })).toBe("Move the pointer at 5, 6");
  });

  test("drag, scroll, type, key and wait", () => {
    expect(describeComputerUseAction({ type: "drag", path: [{ x: 10, y: 10 }, { x: 50, y: 20 }, { x: 200, y: 40 }] })).toBe("Drag from 10, 10 to 200, 40");
    expect(describeComputerUseAction({ type: "scroll", x: 400, y: 300, delta: 3 })).toBe("Scroll down 3 steps at 400, 300");
    expect(describeComputerUseAction({ type: "scroll", x: 4, y: 3, delta: -1, axis: "horizontal" })).toBe("Scroll left 1 step at 4, 3");
    expect(describeComputerUseAction({ type: "type", text: "hello world" })).toBe('Type "hello world"');
    expect(describeComputerUseAction({ type: "key", key: "v", modifiers: ["ctrl"] })).toBe("Press Ctrl+V");
    expect(describeComputerUseAction({ type: "key", key: "Enter" })).toBe("Press Enter");
    expect(describeComputerUseAction({ type: "wait", ms: 500 })).toBe("Wait 500 ms");
  });

  test("anything else stays generic", () => {
    expect(describeComputerUseAction(null)).toBe("Do an action");
    expect(describeComputerUseAction({ type: "launch" })).toBe("Do an action");
  });
});

describe("computer use points", () => {
  test("a drag's path or a single point", () => {
    expect(pointsOf({ type: "drag", path: [{ x: 1, y: 2 }, { x: "3", y: 4 }, { x: 5, y: 6 }] })).toEqual([{ x: 1, y: 2 }, { x: 5, y: 6 }]);
    expect(pointsOf({ type: "click", x: 7, y: 8 })).toEqual([{ x: 7, y: 8 }]);
    expect(pointsOf({ type: "type", text: "a" })).toEqual([]);
  });

  test("scales frame pixels to the shown size", () => {
    expect(scalePoints([{ x: 640, y: 400 }, { x: 0, y: 800 }], { width: 1280, height: 800 }, { width: 320, height: 200 })).toEqual([
      { x: 160, y: 100 },
      { x: 0, y: 200 },
    ]);
    expect(scalePoints([{ x: 320, y: 200 }], { width: 1280, height: 800 }, { width: 100, height: 100 })).toEqual([{ x: 25, y: 25 }]);
    expect(scalePoints([{ x: 1, y: 1 }], { width: 0, height: 800 }, { width: 100, height: 100 })).toEqual([]);
  });
});

describe("computer use chat scope and time", () => {
  test("no chat shows everywhere, a chat only in itself", () => {
    expect(belongsToChat(null, "ses_a")).toBe(true);
    expect(belongsToChat("ses_a", "ses_a")).toBe(true);
    expect(belongsToChat("ses_b", "ses_a")).toBe(false);
  });

  test("minutes left", () => {
    expect(formatMinutesLeft(30)).toBe("less than a minute");
    expect(formatMinutesLeft(605)).toBe("10 min");
  });
});

describe("computer use screenshots in the transcript", () => {
  const act: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "computer-use_computer_act",
    toolCallId: "call_1",
    state: "output-available",
    input: { intent: "Open the menu", action: { type: "click", x: 1, y: 1 } },
    output: '{"ok":true}',
  };
  const shot: UIMessage["parts"][number] = { type: "file", mediaType: "image/png", url: "data:image/png;base64,AAAA" };

  test("an image right after a computer use call joins its tool line", () => {
    const groups = getAssistantRenderGroups([act, shot], false);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "tool", attachments: [shot] });
  });

  test("other tools keep their files as separate groups", () => {
    const other: DynamicToolUIPart = { ...act, toolName: "github_search" };
    expect(getAssistantRenderGroups([other, shot], false).map((group) => group.kind)).toEqual(["tool", "file"]);
  });
});
