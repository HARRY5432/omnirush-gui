import { describe, expect, test } from "bun:test";

import {
  applyPatch,
  baselinesForTurns,
  parseUnifiedPatch,
  reversePatch,
  turnFileChange,
  type TurnFileChange,
} from "../src/react-app/domains/session/editor/review";
import { fuzzyScore, rankPaths } from "../src/react-app/domains/session/editor/quick-open-rank";
import { acceptHunk, hunkCounts, rejectHunk } from "../src/react-app/domains/session/editor/hunk-ops";

// The engine's patch for the rig's ED turn 1 (session diff of the user message).
const ORDERS_PATCH = "Index: src/orders.ts\n===================================================================\n--- src/orders.ts\t\n+++ src/orders.ts\t\n@@ -1,6 +1,7 @@\n import { db } from \"./db\";\n \n export async function list(query: { limit?: number }) {\n-  const rows = await db.orders.findMany();\n-  return rows;\n+  const limit = Math.min(Number(query.limit ?? 50), 200);\n+  const rows = await db.orders.findMany({ take: limit + 1 });\n+  return { items: rows.slice(0, limit), more: rows.length > limit };\n }\n";
const BEFORE = "import { db } from \"./db\";\n\nexport async function list(query: { limit?: number }) {\n  const rows = await db.orders.findMany();\n  return rows;\n}\n";
const AFTER = "import { db } from \"./db\";\n\nexport async function list(query: { limit?: number }) {\n  const limit = Math.min(Number(query.limit ?? 50), 200);\n  const rows = await db.orders.findMany({ take: limit + 1 });\n  return { items: rows.slice(0, limit), more: rows.length > limit };\n}\n";

describe("editor review patches", () => {
  test("parses hunks", () => {
    const parsed = parseUnifiedPatch(ORDERS_PATCH);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 6, newStart: 1, newLines: 7 });
    expect(parsed.hunks[0]!.lines.filter((line) => line.kind === "+")).toHaveLength(3);
  });

  test("undoes and redoes a turn", () => {
    expect(reversePatch(AFTER, ORDERS_PATCH)).toBe(BEFORE);
    expect(applyPatch(BEFORE, ORDERS_PATCH)).toBe(AFTER);
  });

  test("finds a hunk that moved (lines added above since)", () => {
    expect(reversePatch(`// header\n// more\n${AFTER}`, ORDERS_PATCH)).toBe(`// header\n// more\n${BEFORE}`);
  });

  test("a patch that no longer fits gives null", () => {
    expect(reversePatch(AFTER.replace("take: limit + 1", "take: limit"), ORDERS_PATCH)).toBeNull();
  });

  test("added and deleted files", () => {
    const added = "@@ -0,0 +1,2 @@\n+one\n+two\n";
    expect(reversePatch("one\ntwo\n", added)).toBe("");
    const deleted = "@@ -1,2 +0,0 @@\n-one\n-two\n";
    expect(reversePatch("", deleted)).toBe("one\ntwo\n");
  });

  test("no newline at end of file", () => {
    const patch = "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n";
    expect(reversePatch("b\n", patch)).toBe("a");
  });

  test("baselines across turns, newest undone first", () => {
    const turn1: TurnFileChange[] = [{ path: "a.txt", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-v0\n+v1\n" }];
    const turn2: TurnFileChange[] = [
      { path: "a.txt", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-v1\n+v2\n" },
      { path: "new.txt", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+n\n" },
    ];
    const disk: Record<string, string> = { "a.txt": "v2\n", "new.txt": "n\n" };
    const both = baselinesForTurns([turn1, turn2], (path) => disk[path] ?? null);
    expect(both.get("a.txt")).toBe("v0\n");
    expect(both.get("new.txt")).toBeNull();
    const last = baselinesForTurns([turn2], (path) => disk[path] ?? null);
    expect(last.get("a.txt")).toBe("v1\n");
  });

  test("engine diff items", () => {
    expect(turnFileChange({ file: "./src/x.ts", patch: "@@", additions: 1, deletions: 0, status: "added" })).toEqual({
      path: "src/x.ts", status: "added", additions: 1, deletions: 0, patch: "@@",
    });
    expect(turnFileChange({ file: "x" })).toBeNull();
  });
});

describe("quick open ranking", () => {
  test("prefers file-name matches and contiguous runs", () => {
    const ranked = rankPaths(["docs/order-status.md", "src/routes/orders.ts", "test/orders.test.ts", "src/other.ts"], "ord", 10);
    expect(ranked).toHaveLength(3);
    expect(rankPaths(["docs/order-status.md", "src/routes/orders.ts", "test/orders.test.ts"], "orders.ts", 10)[0]).toBe("src/routes/orders.ts");
    expect(ranked).not.toContain("src/other.ts");
    expect(fuzzyScore("src/routes/orders.ts", "sro")).toBeGreaterThan(0);
    expect(fuzzyScore("abc", "abd")).toBe(-1);
  });
});

describe("hunk accept and reject", () => {
  const original = ["a", "b", "c", "d", ""];
  const modified = ["a", "B", "c", "x", "d", ""];
  const change = { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 };
  const insertion = { originalStartLineNumber: 3, originalEndLineNumber: 0, modifiedStartLineNumber: 4, modifiedEndLineNumber: 4 };

  test("accept moves the before side", () => {
    expect(acceptHunk(original, modified, change)).toEqual(["a", "B", "c", "d", ""]);
    expect(acceptHunk(original, modified, insertion)).toEqual(["a", "b", "c", "x", "d", ""]);
  });

  test("reject restores the file", () => {
    expect(rejectHunk(original, modified, change)).toEqual(["a", "b", "c", "x", "d", ""]);
    expect(rejectHunk(original, modified, insertion)).toEqual(["a", "B", "c", "d", ""]);
    const deletion = { originalStartLineNumber: 2, originalEndLineNumber: 3, modifiedStartLineNumber: 1, modifiedEndLineNumber: 0 };
    expect(rejectHunk(["a", "b", "c", "d"], ["a", "d"], deletion)).toEqual(["a", "b", "c", "d"]);
    expect(hunkCounts(deletion)).toEqual({ added: 0, removed: 2 });
  });
});
