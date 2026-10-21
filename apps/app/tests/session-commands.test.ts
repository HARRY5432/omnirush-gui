import { describe, expect, test } from "bun:test";

import { NOT_TRACKED_MESSAGE, projectTracksFiles, undoNotice } from "../src/react-app/domains/session/commands/undo-notice";
import { commandTemplateLabel, parseReviewReply, reviewForTurn } from "../src/react-app/domains/session/commands/review-message";
import { contextUse, sandboxLabel, uploadsLine } from "../src/react-app/domains/session/commands/context-usage";
import { MAX_DIFF_LINES, changeTotals, normalizeChanges, patchLineCount, patchLines } from "../src/react-app/domains/session/commands/changes";
import { chatUndoKey } from "../src/react-app/domains/session/commands/undo-key";

describe("undoNotice", () => {
  test("says what happened to each file, in the CLI's words", () => {
    expect(undoNotice({ restored: ["src/a.ts", "b.md"], merged: [], kept: [] }, true)).toEqual({
      title: "Undid the last turn",
      message: "Restored 2 files: src/a.ts, b.md. Redo puts it back.",
      variant: "success",
    });
    expect(undoNotice({ restored: ["a.ts"], merged: ["c.ts"], kept: ["d.ts"] }, true)).toEqual({
      title: "Undid the last turn",
      message: "Restored 2 files: a.ts, c.ts. Your own edits in c.ts were kept. Left 1 file as it is: d.ts (edited after the turn, and the turn's change could not be taken out cleanly). Redo puts it back.",
      variant: "warning",
    });
    expect(undoNotice({ restored: ["1", "2", "3", "4", "5"] }, true).message).toBe("Restored 5 files: 1, 2, 3 and 2 more. Redo puts it back.");
    expect(undoNotice({ kept: ["x", "y"] }, true).message).toBe("Left 2 files as they are: x, y (edited after the turn, and the turn's change could not be taken out cleanly). Redo puts it back.");
    expect(undoNotice({ restored: ["a"], outside: ["log.txt"] }, true)).toEqual({
      title: "Undid the last turn",
      message: "Restored 1 file: a. Not touched: log.txt (changed during the turn by something other than the agent's file edits). Redo puts it back.",
      variant: "warning",
    });
  });

  test("a turn that changed nothing, and a folder that is not a git repository", () => {
    expect(undoNotice({}, true).message).toBe("The last turn changed no files. Redo puts it back.");
    expect(undoNotice(undefined, true).message).toBe("The last turn changed no files. Redo puts it back.");
    expect(undoNotice({ restored: ["a"] }, false)).toEqual({ title: "Undid the last turn", message: NOT_TRACKED_MESSAGE, variant: "warning" });
    expect(NOT_TRACKED_MESSAGE).toBe("The chat was rewound. This folder is not a git repository, so file changes are not tracked and no file was restored.");
  });

  test("a git project is one with a worktree other than /", () => {
    expect(projectTracksFiles({ worktree: "/home/me/app" })).toBe(true);
    expect(projectTracksFiles({ worktree: "/" })).toBe(false);
    expect(projectTracksFiles({})).toBe(false);
    expect(projectTracksFiles(null)).toBe(false);
  });
});

const REVIEW = [
  "Reviewed: uncommitted changes (3 files)",
  "",
  "### High",
  "1. src/server.ts:42 - Missing await on save",
  "   The response is sent before the write finishes when the disk is slow.",
  "",
  "### Low",
  "2. `README.md:3` - Typo in the title",
  "3. src/util.ts - Unused import",
  "",
  "Reply **fix these** to fix them all (or for example **fix 1, 3**), or run /fix.",
].join("\n");

describe("parseReviewReply", () => {
  test("reads the issues, their severity and the fix offer", () => {
    const review = parseReviewReply(REVIEW);
    expect(review?.reviewed).toBe("uncommitted changes (3 files)");
    expect(review?.fixable).toBe(true);
    expect(review?.counts).toEqual({ critical: 0, high: 1, medium: 0, low: 2 });
    expect(review?.issues).toEqual([
      { number: 1, severity: "high", path: "src/server.ts", line: 42, title: "Missing await on save" },
      { number: 2, severity: "low", path: "README.md", line: 3, title: "Typo in the title" },
      { number: 3, severity: "low", path: "src/util.ts", line: null, title: "Unused import" },
    ]);
  });

  test("a clean review offers no fix; other replies are not reviews", () => {
    const clean = parseReviewReply("Reviewed: uncommitted changes (1 files)\n\nNo issues found.");
    expect(clean?.clean).toBe(true);
    expect(clean?.fixable).toBe(false);
    expect(parseReviewReply("Here is the plan:\n1. src/a.ts - do this")).toBeNull();
    expect(parseReviewReply("")).toBeNull();
    expect(parseReviewReply(null)).toBeNull();
  });
});

describe("reviewForTurn", () => {
  const REVIEW_PROMPT = "You are a code reviewer. Your job is...\n\nInput: \n";
  test("only a reply to the review command, opening with Reviewed:, offers Fix these", () => {
    expect(reviewForTurn(REVIEW_PROMPT, REVIEW)?.fixable).toBe(true);
    expect(reviewForTurn("/review", REVIEW)?.fixable).toBe(true);
    const plan = [
      "Here is the plan, most important first:",
      "### High",
      "1. src/server.ts:42 - Add the retry",
      "### Low",
      "2. README.md:3 - Mention it",
      "Reply **fix these** to fix them all (or for example **fix 1, 3**), or run /fix.",
    ].join("\n");
    expect(reviewForTurn("make a prioritized plan for the retry work", plan)).toBeNull();
    expect(reviewForTurn("make a prioritized plan", REVIEW)).toBeNull();
    expect(reviewForTurn(REVIEW_PROMPT, plan)).toBeNull();
    expect(reviewForTurn(undefined, REVIEW)).toBeNull();
  });
});

describe("commandTemplateLabel", () => {
  test("names the review and fix commands their prompts came from", () => {
    expect(commandTemplateLabel("You are a code reviewer. Your job is...\n\n---\n\nInput: \n\n---")).toBe("/review");
    expect(commandTemplateLabel("You are a code reviewer. Your job is...\n\nInput: main\n")).toBe("/review main");
    expect(commandTemplateLabel("Fix the issues from the code review above. \n\nIf issue numbers...")).toBe("/fix");
    expect(commandTemplateLabel("Fix the issues from the code review above. 1, 3\n\nIf issue numbers...")).toBe("/fix 1, 3");
    expect(commandTemplateLabel("please fix the bug")).toBeNull();
  });
});

describe("contextUse", () => {
  const limit = (providerID: string, modelID: string) => (providerID === "omnirush" && modelID === "m" ? 400_000 : undefined);

  test("the newest reply with output against the model's window", () => {
    const use = contextUse([
      { role: "user" },
      { role: "assistant", providerID: "omnirush", modelID: "m", tokens: { input: 1_000, output: 10, reasoning: 0 } },
      { role: "user" },
      { role: "assistant", providerID: "omnirush", modelID: "m", tokens: { input: 15_000, output: 2_000, reasoning: 1_000, cache: { read: 2_500, write: 500 } } },
      { role: "assistant", providerID: "omnirush", modelID: "m", tokens: { input: 99, output: 0, reasoning: 0 } },
    ], limit);
    expect(use?.used).toBe(21_000);
    expect(use?.text).toBe("21,000 of 400,000 tokens (5%) · 379,000 left");
    expect(use?.warning).toBe(false);
  });

  test("warns from 85%, and counts without a known window", () => {
    expect(contextUse([{ role: "assistant", providerID: "omnirush", modelID: "m", tokens: { input: 340_000, output: 1, reasoning: 0 } }], limit)?.warning).toBe(true);
    expect(contextUse([{ role: "assistant", providerID: "x", modelID: "y", tokens: { input: 5, output: 5, reasoning: 0 } }], limit)?.text).toBe("10 tokens");
    expect(contextUse([{ role: "user" }], limit)).toBeNull();
  });

  test("uploads and sandbox lines, in the CLI's words", () => {
    expect(uploadsLine({ uploads: 0, archives: 0 })).toBe("nothing waiting");
    expect(uploadsLine({ uploads: 2, archives: 1 })).toBe("3 waiting to be sent");
    expect(uploadsLine({ uploads: 0, archives: 0 }, { signedOut: true })).toBe("paused · sign in to send");
    expect(uploadsLine({ uploads: 2, archives: 0 }, { signedOut: true })).toBe("2 waiting · sign in to send");
    expect(uploadsLine(null)).toBeNull();
    expect(sandboxLabel(null)).toBe("off");
    expect(sandboxLabel({ on: false })).toBe("off");
    expect(sandboxLabel({ on: true, state: "ready", backend: { id: "docker" } })).toBe("on · docker");
    expect(sandboxLabel({ on: true, state: "ready", backend: null, runtime: { ok: true, name: "podman" } })).toBe("on · podman");
    expect(sandboxLabel({ on: true, state: "unavailable", backend: { id: "docker" } })).toBe("off (fell back to this machine)");
    expect(sandboxLabel({ on: true, state: "starting" })).toBe("on");
  });
});

describe("changes", () => {
  test("normalizes both diff shapes and totals them", () => {
    const files = normalizeChanges([
      { file: "b.ts", patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1, status: "modified" },
      { file: "a.ts", additions: 3, deletions: 0, status: "added" },
      { additions: 1, deletions: 1 },
    ]);
    expect(files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(files[0]?.status).toBe("added");
    expect(changeTotals(files)).toEqual({ files: 2, additions: 4, deletions: 1 });
    expect(normalizeChanges(null)).toEqual([]);
  });

  test("long patches are counted cheaply against the render cap", () => {
    expect(patchLineCount("")).toBe(0);
    expect(patchLineCount("a\nb\nc")).toBe(3);
    const big = Array.from({ length: MAX_DIFF_LINES + 10 }, (_, i) => `+line ${i}`).join("\n");
    expect(patchLineCount(big)).toBeGreaterThan(MAX_DIFF_LINES);
  });

  test("patch lines carry old and new line numbers", () => {
    const lines = patchLines("Index: a.ts\n===\n--- a.ts\n+++ a.ts\n@@ -3,3 +3,3 @@\n keep\n-old\n+new\n tail\n");
    expect(lines.map((line) => [line.kind, line.oldLine, line.newLine, line.text])).toEqual([
      ["hunk", null, null, "@@ -3,3 +3,3 @@"],
      ["context", 3, 3, "keep"],
      ["del", 4, null, "old"],
      ["add", null, 4, "new"],
      ["context", 5, 5, "tail"],
    ]);
  });
});

describe("chatUndoKey", () => {
  const key = (init: Partial<KeyboardEvent> & { target?: unknown; repeat?: boolean }) => ({
    key: "z", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, target: null, ...init,
  }) as Parameters<typeof chatUndoKey>[0];
  // An element whose ancestors match these selectors.
  const el = (tagName: string, ...inside: string[]) => ({
    tagName,
    isContentEditable: false,
    closest: (selector: string) => (selector.split(", ").some((part) => inside.includes(part)) ? {} : null),
  });
  const transcript = el("DIV", "[data-chat-transcript]");

  test("Cmd/Ctrl+Z undoes and Shift redoes with focus in the transcript", () => {
    expect(chatUndoKey(key({ metaKey: true, target: transcript }), true)).toBe("undo");
    expect(chatUndoKey(key({ ctrlKey: true, target: transcript }), false)).toBe("undo");
    expect(chatUndoKey(key({ ctrlKey: true, shiftKey: true, target: transcript }), false)).toBe("redo");
    expect(chatUndoKey(key({ ctrlKey: true, target: transcript }), true)).toBeNull();
    expect(chatUndoKey(key({ metaKey: true, key: "y", target: transcript }), true)).toBeNull();
  });

  test("anything with keys of its own keeps them, inside the transcript too", () => {
    expect(chatUndoKey(key({ metaKey: true, target: el("TEXTAREA", "textarea", "[data-chat-transcript]") }), true)).toBeNull();
    expect(chatUndoKey(key({ metaKey: true, target: { ...transcript, isContentEditable: true } }), true)).toBeNull();
    expect(chatUndoKey(key({ metaKey: true, target: el("BUTTON", "button", "[data-chat-transcript]") }), true)).toBeNull();
    expect(chatUndoKey(key({ ctrlKey: true, target: el("DIV", ".monaco-editor", "[data-chat-transcript]") }), false)).toBeNull();
    expect(chatUndoKey(key({ metaKey: true, target: el("DIV", "[data-composer-shell]") }), true)).toBeNull();
  });

  test("never from the IDE, the page itself or anywhere outside the transcript", () => {
    expect(chatUndoKey(key({ metaKey: true, target: el("DIV", "[role=treeitem]", "[data-editor-panel]") }), true)).toBeNull();
    expect(chatUndoKey(key({ metaKey: true, target: el("DIV", "[data-editor-panel]") }), true)).toBeNull();
    expect(chatUndoKey(key({ metaKey: true, target: el("DIV", "[role=tab]") }), true)).toBeNull();
    expect(chatUndoKey(key({ metaKey: true, target: el("BODY") }), true)).toBeNull();
    expect(chatUndoKey(key({ metaKey: true, target: el("DIV", "[data-session-pane]") }), true)).toBeNull();
    expect(chatUndoKey(key({ metaKey: true, target: null }), true)).toBeNull();
  });

  test("a held key undoes one turn at most, not one per auto-repeat", () => {
    expect(chatUndoKey(key({ metaKey: true, target: transcript, repeat: true }), true)).toBeNull();
    expect(chatUndoKey(key({ metaKey: true, shiftKey: true, target: transcript, repeat: true }), true)).toBeNull();
  });
});
