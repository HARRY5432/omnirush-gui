import { describe, expect, test } from "bun:test";

import { diffLines, gutterLabel, gutterMarks } from "../src/react-app/domains/session/editor/line-diff";

describe("git gutter line diff", () => {
  test("no change, no marks", () => {
    expect(gutterMarks("a\nb\nc\n", "a\nb\nc\n")).toEqual([]);
  });

  test("added, changed and removed lines", () => {
    const head = "one\ntwo\nthree\nfour\nfive\n";
    const current = "one\nTWO\nthree\nnew a\nnew b\nfour\n";
    expect(gutterMarks(head, current)).toEqual([
      { kind: "change", startLine: 2, endLine: 2, removed: 1 },
      { kind: "add", startLine: 4, endLine: 5, removed: 0 },
      { kind: "delete", startLine: 6, endLine: 6, removed: 1 },
    ]);
  });

  test("lines removed at the top sit on line 0", () => {
    expect(gutterMarks("x\ny\nz\n", "y\nz\n")).toEqual([{ kind: "delete", startLine: 0, endLine: 0, removed: 1 }]);
  });

  test("a change longer than the old block marks the rest as added", () => {
    expect(gutterMarks("a\nb\nc\n", "a\nB1\nB2\nB3\nc\n")).toEqual([
      { kind: "change", startLine: 2, endLine: 2, removed: 1 },
      { kind: "add", startLine: 3, endLine: 4, removed: 0 },
    ]);
  });

  test("past the cap the gutter gives up", () => {
    const head = Array.from({ length: 50 }, (_, i) => `h${i}`).join("\n");
    const current = Array.from({ length: 50 }, (_, i) => `c${i}`).join("\n");
    expect(diffLines(head.split("\n"), current.split("\n"), 10)).toBeNull();
  });

  test("labels say what changed", () => {
    expect(gutterLabel({ kind: "add", startLine: 4, endLine: 5, removed: 0 })).toBe("2 lines added since the last commit");
    expect(gutterLabel({ kind: "delete", startLine: 6, endLine: 6, removed: 1 })).toBe("1 line removed here since the last commit");
  });
});
