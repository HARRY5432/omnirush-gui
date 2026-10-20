import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findRipgrep, parseSearchOptions, searchWorkspace } from "./routes/editor-search.js";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function project() {
  const root = await mkdtemp(join(tmpdir(), "omnirush-search-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "dist/\n");
  await writeFile(join(root, "src", "a.ts"), "const limit = 50;\nconst unlimited = limit * 2;\nconst é = 'limit';\n");
  await writeFile(join(root, "src", "b.test.ts"), "expect(limit).toBe(50);\n");
  await writeFile(join(root, "dist", "out.js"), "var limit=1;\n");
  await writeFile(join(root, "logo.bin"), new Uint8Array([0, 1, 108, 105, 109, 105, 116]));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

const options = (over: Record<string, unknown>) => parseSearchOptions({ query: "limit", ...over });

describe.each([["ripgrep", findRipgrep()], ["git", null]] as const)("search in files (%s)", (_name, rg) => {
  test("plain, gitignore respected, binary skipped", async () => {
    if (_name === "ripgrep" && !rg) return;
    const root = await project();
    const result = await searchWorkspace(root, options({}), rg);
    expect(result.files.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/b.test.ts"]);
    expect(result.matchCount).toBe(5);
    const third = result.files.find((file) => file.path === "src/a.ts")!.matches.at(-1)!;
    expect(third.text.slice(third.start, third.end)).toBe("limit");
  });

  test("whole word, case, include and exclude", async () => {
    if (_name === "ripgrep" && !rg) return;
    const root = await project();
    const word = await searchWorkspace(root, options({ wholeWord: true, exclude: ["**/*.test.ts"] }), rg);
    expect(word.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(word.matchCount).toBe(3);
    const cased = await searchWorkspace(root, options({ query: "LIMIT", caseSensitive: true }), rg);
    expect(cased.matchCount).toBe(0);
    const included = await searchWorkspace(root, options({ include: ["**/*.test.ts"] }), rg);
    expect(included.files.map((file) => file.path)).toEqual(["src/b.test.ts"]);
  });

  test("regex", async () => {
    if (_name === "ripgrep" && !rg) return;
    const root = await project();
    const result = await searchWorkspace(root, options({ query: "lim[a-z]t \\*", regex: true }), rg);
    expect(result.matchCount).toBe(1);
  });
});

test("bad input is refused", () => {
  expect(() => parseSearchOptions({ query: "" })).toThrow();
  expect(() => parseSearchOptions({ query: "(", regex: true })).toThrow();
  expect(parseSearchOptions({ query: "x", include: ["../etc/*", "/abs", "src/**"] }).include).toEqual(["src/**"]);
});

test("git grep: a file name holding `:1:` is read whole, and a failing git is an error", async () => {
  const root = await project();
  await writeFile(join(root, "src", "we:1:ird.ts"), "limit\n");
  const result = await searchWorkspace(root, options({ include: ["src/we*"] }), null);
  expect(result.files.map((file) => file.path)).toEqual(["src/we:1:ird.ts"]);
  // A pattern git refuses (no closing bracket in either regex syntax) comes back as an error, not "0 results".
  await expect(searchWorkspace(root, { ...options({ regex: true }), query: "lim[it" }, null)).rejects.toThrow();
});

test("ripgrep from the desktop engine's data folder", async () => {
  const userData = await mkdtemp(join(tmpdir(), "omnirush-userdata-"));
  roots.push(userData);
  const name = process.platform === "win32" ? "rg.exe" : "rg";
  await mkdir(join(userData, "engine-data", "omnirush", "bin"), { recursive: true });
  await writeFile(join(userData, "engine-data", "omnirush", "bin", name), "");
  expect(findRipgrep({ PATH: "", OMNIRUSH_DESKTOP_USER_DATA_DIR: userData, HOME: userData })).toBe(join(userData, "engine-data", "omnirush", "bin", name));
});

test("a search tool that cannot start is an error, not an empty result", async () => {
  const root = await project();
  await expect(searchWorkspace(root, options({}), join(root, "no-such-rg"))).rejects.toThrow();
});
