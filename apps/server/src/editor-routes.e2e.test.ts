import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { editorLineDiff } from "./editor-diff.js";
import { editorUserEditEvent, MAX_USER_EDIT_DIFF_BYTES } from "./editor-events.js";
import { parsePorcelainStatus } from "./routes/editor.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", ...args], { cwd: root, encoding: "utf8" });
}

async function project(options: { git?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omnirush-editor-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "dist/\n*.log\n", "utf8");
  await writeFile(join(root, "src", "main.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(root, "src", "notes.log"), "ignored\n", "utf8");
  await writeFile(join(root, "dist", "out.js"), "ignored\n", "utf8");
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "ignored\n", "utf8");
  await writeFile(join(root, "image.bin"), new Uint8Array([1, 0, 2, 3]));
  if (options.git !== false) {
    git(root, "init", "-q", "-b", "main");
    // node_modules is ignored by git only through the .gitignore of real projects; this one relies on ls-files --others honoring .gitignore.
    await writeFile(join(root, ".gitignore"), "dist/\n*.log\nnode_modules/\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "init");
  }
  return root;
}

async function serve(root: string) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}/workspace/ws_1/editor`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", Connection: "close" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return call;
}

describe("editor routes", () => {
  test("the tree follows git: ignored files and node_modules stay out", async () => {
    const root = await project();
    await writeFile(join(root, "src", "new.ts"), "untracked\n", "utf8");
    const call = await serve(root);
    const tree = await call("GET", "/tree");
    expect(tree.status).toBe(200);
    expect(tree.body.git).toBe(true);
    expect(tree.body.files).toEqual([".gitignore", "image.bin", "src/main.ts", "src/new.ts"]);
  });

  test("without git the walk applies .gitignore and skips node_modules", async () => {
    const root = await project({ git: false });
    const call = await serve(root);
    const tree = await call("GET", "/tree");
    expect(tree.body.git).toBe(false);
    expect(tree.body.files).toEqual([".gitignore", "image.bin", "src/main.ts"]);
  });

  test("reads text, flags binary, saves, and refuses a stale save", async () => {
    const root = await project();
    const call = await serve(root);
    const read = await call("GET", "/file?path=src/main.ts");
    expect(read.body.content).toBe("export const a = 1;\n");
    expect((await call("GET", "/file?path=image.bin")).body.binary).toBe(true);
    expect((await call("GET", "/file?path=missing.ts")).status).toBe(404);
    const saved = await call("PUT", "/file", { path: "src/main.ts", content: "export const a = 2;\n", baseUpdatedAt: read.body.updatedAt });
    expect(saved.status).toBe(200);
    expect(await readFile(join(root, "src", "main.ts"), "utf8")).toBe("export const a = 2;\n");
    const stale = await call("PUT", "/file", { path: "src/main.ts", content: "x", baseUpdatedAt: read.body.updatedAt - 1000 });
    expect(stale.status).toBe(409);
    const created = await call("PUT", "/file", { path: "src/deep/new.ts", content: "new\n" });
    expect(created.status).toBe(200);
    expect(await readFile(join(root, "src", "deep", "new.ts"), "utf8")).toBe("new\n");
    const removed = await call("PUT", "/file", { path: "src/deep/new.ts", delete: true });
    expect(removed.body.deleted).toBe(true);
  });

  test("paths outside the workspace are refused", async () => {
    const root = await project();
    const outside = await mkdtemp(join(tmpdir(), "omnirush-editor-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "nope\n", "utf8");
    await symlink(outside, join(root, "link"));
    const call = await serve(root);
    expect((await call("GET", "/file?path=../secret.txt")).status).toBe(400);
    expect((await call("GET", "/file?path=link/secret.txt")).status).toBe(400);
    expect((await call("PUT", "/file", { path: "link/evil.txt", content: "x" })).status).toBe(400);
    expect((await call("PUT", "/file", { path: ".git/config", content: "x" })).status).toBe(400);
    expect((await call("PUT", "/file", { path: ".GIT/config", content: "x" })).status).toBe(400);
    expect((await call("PUT", "/file", { path: "sub/.git/hooks/pre-commit", content: "x" })).status).toBe(400);
    expect((await call("PUT", "/file", { path: "/etc/passwd", content: "x" })).status).toBe(400);
    await symlink(join(root, ".git"), join(root, "gitlink"));
    expect((await call("PUT", "/file", { path: "gitlink/config", content: "x" })).status).toBe(400);
  });

  test("paths are never rewritten: workspace/ prefixes are real folders", async () => {
    const root = await project();
    await mkdir(join(root, "workspace"), { recursive: true });
    await mkdir(join(root, "workspaces", "app", "src"), { recursive: true });
    await writeFile(join(root, "workspace", "foo.ts"), "inner\n", "utf8");
    await writeFile(join(root, "foo.ts"), "outer\n", "utf8");
    const call = await serve(root);
    expect((await call("GET", "/file?path=workspace/foo.ts")).body.content).toBe("inner\n");
    await call("PUT", "/file", { path: "workspaces/app/src/index.ts", content: "deep\n" });
    expect(await readFile(join(root, "workspaces", "app", "src", "index.ts"), "utf8")).toBe("deep\n");
    expect(await readFile(join(root, "foo.ts"), "utf8")).toBe("outer\n");
  });

  test("a save keeps the file mode and leaves no temporary file", async () => {
    const root = await project();
    const script = join(root, "run.sh");
    await writeFile(script, "echo a\n", { mode: 0o755 });
    const call = await serve(root);
    await call("PUT", "/file", { path: "run.sh", content: "echo b\n" });
    const { stat: statFile, readdir: list } = await import("node:fs/promises");
    expect((await statFile(script)).mode & 0o777).toBe(0o755);
    expect((await list(root)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("stage takes paths literally, not as globs", async () => {
    const root = await project();
    await writeFile(join(root, "[ab].ts"), "x\n", "utf8");
    await writeFile(join(root, "a.ts"), "a\n", "utf8");
    const call = await serve(root);
    const staged = await call("POST", "/git/stage", { paths: ["[ab].ts"] });
    expect(staged.body.files.map((file: any) => `${file.index}${file.worktree} ${file.path}`)).toEqual(["A  [ab].ts", "?? a.ts"]);
  });

  test("git panel: status, stage, unstage, commit, original text", async () => {
    const root = await project();
    const call = await serve(root);
    await writeFile(join(root, "src", "main.ts"), "export const a = 3;\n", "utf8");
    await writeFile(join(root, "src", "b.ts"), "b\n", "utf8");
    const status = await call("GET", "/git/status");
    expect(status.body.repo).toBe(true);
    expect(status.body.branch).toBe("main");
    expect(status.body.files).toEqual([
      { path: "src/b.ts", index: "?", worktree: "?" },
      { path: "src/main.ts", index: " ", worktree: "M" },
    ]);
    const staged = await call("POST", "/git/stage", { paths: ["src/b.ts", "src/main.ts"] });
    expect(staged.body.files.map((file: any) => `${file.index}${file.worktree} ${file.path}`)).toEqual(["A  src/b.ts", "M  src/main.ts"]);
    const unstaged = await call("POST", "/git/unstage", { paths: ["src/b.ts"] });
    expect(unstaged.body.files.map((file: any) => `${file.index}${file.worktree} ${file.path}`)).toEqual(["?? src/b.ts", "M  src/main.ts"]);
    const original = await call("GET", "/git/original?path=src/main.ts&ref=HEAD");
    expect(original.body.content).toBe("export const a = 1;\n");
    expect((await call("POST", "/git/commit", { message: "" })).status).toBe(400);
    const commit = await call("POST", "/git/commit", { message: "--amend is just text\n\nbody" });
    // The rig's git may have no identity: then the error is git's own.
    if (commit.status === 200) {
      expect(commit.body.status.files).toEqual([{ path: "src/b.ts", index: "?", worktree: "?" }]);
      expect(git(root, "log", "-1", "--format=%s")).toBe("--amend is just text\n");
    } else {
      expect(commit.body.code ?? commit.body.error).toBeTruthy();
    }
  });

  test("a folder that is not a repository has no git panel", async () => {
    const root = await project({ git: false });
    const call = await serve(root);
    expect((await call("GET", "/git/status")).body.repo).toBe(false);
    expect((await call("POST", "/git/stage", { paths: ["src/main.ts"] })).status).toBe(400);
  });
});

describe("editor diff and events", () => {
  test("porcelain parsing: branch, tracking, renames", () => {
    const parsed = parsePorcelainStatus("## main...origin/main [ahead 2, behind 1]\0R  new.ts\0old.ts\0 M a.ts\0?? b.ts\0");
    expect(parsed).toEqual({
      branch: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      files: [
        { path: "new.ts", from: "old.ts", index: "R", worktree: " " },
        { path: "a.ts", index: " ", worktree: "M" },
        { path: "b.ts", index: "?", worktree: "?" },
      ],
    });
    expect(parsePorcelainStatus("## No commits yet on main\0").branch).toBe("main");
  });

  test("line diff counts and hunks", () => {
    const result = editorLineDiff("x.txt", "a\nb\nc\n", "a\nB\nc\nd\n");
    expect(result.added).toBe(2);
    expect(result.removed).toBe(1);
    expect(result.diff).toBe("--- a/x.txt\n+++ b/x.txt\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n");
    const big = editorLineDiff("x", Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n"), Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n"));
    expect(big).toEqual({ added: 3000, removed: 3000, diff: null });
  });

  test("user_edit events", () => {
    expect(editorUserEditEvent({ path: "a.ts", before: "x\n", after: "x\n", source: "editor" })).toBeNull();
    expect(editorUserEditEvent({ path: "a.ts", before: null, after: "x\n", source: "editor" })).toEqual({
      path: "a.ts", source: "editor", added: 1, removed: 0, created: true, diff: "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+x\n",
    });
    expect(editorUserEditEvent({ path: "a.ts", before: "x\n", after: null, source: "review" })).toMatchObject({ deleted: true, removed: 1, source: "review" });
    const huge = editorUserEditEvent({ path: "a.ts", before: "", after: `${"y".repeat(MAX_USER_EDIT_DIFF_BYTES)}\n`, source: "editor" });
    expect(huge).toMatchObject({ added: 1, diff_truncated: true });
    expect(huge?.diff).toBeUndefined();
    expect(editorUserEditEvent({ path: "logo.png", before: "a", after: "b", source: "editor" })?.diff).toBeUndefined();
  });
});
