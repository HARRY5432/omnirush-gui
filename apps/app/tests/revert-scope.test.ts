import { describe, expect, test } from "bun:test";

import { editConfirmText, editTargetText, hiddenDeleteConfirmText, revertConfirmText, revertNeedsConfirm, revertPointMessageId, turnsFromRevertPoint } from "../src/react-app/domains/session/surface/revert-scope";

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

  test("the questions name the later turns and the file changes", () => {
    expect(revertConfirmText(5, false)).toBe("Hide this and the 4 later turns, and undo their file changes? Restore brings them back until you send a new message.");
    expect(revertConfirmText(2, true)).toBe("Hide this and the 1 later turn, and undo their file changes? The running turn stops first. Restore brings them back until you send a new message.");
    expect(revertConfirmText(1, false)).toBe("Hide this turn, and undo their file changes? Restore brings them back until you send a new message.");
    expect(revertConfirmText(null, false)).toContain("every later turn");
    expect(editTargetText(3)).toBe("Editing an earlier message: sending will remove the 2 later turns and undo their file changes.");
    expect(editTargetText(1)).toBe("Editing your last message: sending replaces it and undoes its file changes.");
    expect(editConfirmText(4)).toBe("Send this in place of the earlier message? It removes the 3 later turns for good and undoes their file changes.");
    expect(editConfirmText(1, 20)).toBe("Send this in place of your last message? It undoes that turn's file changes. The 20 hidden messages go for good too.");
    expect(editConfirmText(3, 1)).toContain("The 1 hidden message goes for good too.");
    expect(hiddenDeleteConfirmText(6)).toBe("Sending removes the 6 hidden messages for good; their file changes stay undone. Send and remove them? (Cancel keeps them: Restore brings them back.)");
  });
});

describe("revertPointMessageId", () => {
  test("a reply rewinds at the prompt that started its turn, so the turn's earlier steps go too", () => {
    expect(revertPointMessageId(chat, "a2b")).toBe("u2");
    expect(revertPointMessageId(chat, "a3")).toBe("u3");
    expect(revertPointMessageId(chat, "u1")).toBe("u1");
    expect(revertPointMessageId(chat, "gone")).toBeNull();
    expect(revertPointMessageId([{ id: "a0", role: "assistant" }], "a0")).toBeNull();
  });
});
