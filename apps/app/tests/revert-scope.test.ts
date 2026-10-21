import { describe, expect, test } from "bun:test";

import { revertConfirmText, revertNeedsConfirm, turnsFromRevertPoint } from "../src/react-app/domains/session/surface/revert-scope";

const chat = [
  { id: "u1", role: "user" },
  { id: "a1", role: "assistant" },
  { id: "u2", role: "user" },
  { id: "a2", role: "assistant" },
  { id: "a2b", role: "assistant" },
  { id: "u3", role: "user" },
  { id: "a3", role: "assistant" },
];

describe("turnsFromRevertPoint", () => {
  test("counts the person's prompts from the revert point on", () => {
    expect(turnsFromRevertPoint(chat, "u3")).toBe(1);
    expect(turnsFromRevertPoint(chat, "u2")).toBe(2);
    expect(turnsFromRevertPoint(chat, "u1")).toBe(3);
  });

  test("a reply rewinds to the prompt before it, as the engine does", () => {
    expect(turnsFromRevertPoint(chat, "a3")).toBe(1);
    expect(turnsFromRevertPoint(chat, "a2b")).toBe(2);
    expect(turnsFromRevertPoint(chat, "a1")).toBe(3);
  });

  test("a message not on screen is unknown", () => {
    expect(turnsFromRevertPoint(chat, "gone")).toBeNull();
    expect(turnsFromRevertPoint([], "u1")).toBeNull();
  });
});

describe("revertNeedsConfirm", () => {
  test("the newest turn goes at once; more, or an unknown point, asks", () => {
    expect(revertNeedsConfirm(1)).toBe(false);
    expect(revertNeedsConfirm(2)).toBe(true);
    expect(revertNeedsConfirm(null)).toBe(true);
  });

  test("the question names the turns and the file changes", () => {
    expect(revertConfirmText("revert", 5)).toBe("Revert to this point? This hides the last 5 turns of this chat and takes back the file changes they made. Restore brings them back, until you send a new message.");
    expect(revertConfirmText("edit", 3)).toBe("Send this in place of the earlier message? It removes the last 3 turns of this chat and takes back the file changes they made. This cannot be undone.");
    expect(revertConfirmText("edit", null)).toContain("every turn from there on");
  });
});
