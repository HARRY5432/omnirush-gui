import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { matchRoute, type RequestContext, type Route } from "./routes/registry.js";
import { liveTask, noteTaskPrompt, registerWorkspaceTaskRoutes, type TaskEngine } from "./routes/workspace-tasks.js";
import { startServer } from "./server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { readTask, TASK_MERGED_EVENT, TASK_STARTED_EVENT, tasksDir } from "./workspace/worktree-tasks.mjs";
import { workspaceIdForPath } from "./workspaces.js";

const roots: string[] = [];
const savedEnv = { ...process.env };

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = "test@example.invalid";
  process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_COMMITTER_EMAIL = "test@example.invalid";
});

afterAll(async () => {
  process.env = savedEnv;
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeRepo(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "omnirush-tasks-"));
  roots.push(root);
  const repo = join(root, "app");
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "README.md"), "hello\n");
  await writeFile(join(repo, "notes.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  return { root, repo };
}

function makeConfig(root: string, workspaces: WorkspaceInfo[]): ServerConfig {
  process.env.OMNIRUSH_DATA_DIR = join(root, "data");
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_tasks_client",
    hostToken: "owt_tasks_host",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces,
    authorizedRoots: workspaces.map((workspace) => workspace.path),
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

function localWorkspace(path: string): WorkspaceInfo {
  return { id: workspaceIdForPath(path), name: basename(path), path, preset: "starter", workspaceType: "local" };
}

type Harness = {
  config: ServerConfig;
  traces: Array<{ sessionId: string; type: string; data: Record<string, unknown> }>;
  busy: Map<string, boolean>;
  aborted: string[];
  stopped: string[];
  changes: number;
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
};

function harness(config: ServerConfig): Harness {
  const routes: Route[] = [];
  const state: Harness = {
    config, traces: [], busy: new Map(), aborted: [], stopped: [], changes: 0,
    call: async () => ({ status: 0, json: {} }),
  };
  const engine: TaskEngine = {
    sessionBusy: async (_workspace, sessionId) => state.busy.get(sessionId) ?? false,
    abort: async (_workspace, sessionId) => { state.aborted.push(sessionId); },
    lastReply: async () => "All done: added the file.",
  };
  registerWorkspaceTaskRoutes({
    routes,
    config,
    onWorkspacesChanged: () => { state.changes += 1; },
    jsonResponse: (data, status = 200) => Response.json(data, { status }),
    readJsonBody: async (request) => request.json(),
    ensureWritable: () => undefined,
    resolveWorkspace: async (routeConfig, id) => {
      const found = routeConfig.workspaces.find((workspace) => workspace.id === id);
      if (!found) throw new Error("workspace not found");
      return found;
    },
    serializeWorkspace: (workspace) => workspace,
    stopWorkspaceWork: async (_config, workspace) => { state.stopped.push(workspace.id); },
    engine,
    recordTrace: (sessionId, type, data) => { state.traces.push({ sessionId, type, data }); },
  });
  state.call = async (method, path, body) => {
    const matched = matchRoute(routes, method, path);
    if (!matched) throw new Error(`no route ${method} ${path}`);
    const url = new URL(`http://127.0.0.1${path}`);
    const request = new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    // Only the fields these routes read: the request, its params and the server config.
    const ctx = { request, url, params: matched.params, config } as unknown as RequestContext;
    try {
      const response = await matched.handler(ctx);
      return { status: response.status, json: await response.json() };
    } catch (error) {
      const failure = error as { status?: number; code?: string; message?: string };
      return { status: failure.status ?? 500, json: { code: failure.code, message: failure.message } };
    }
  };
  return state;
}

describe("parallel tasks (desktop)", () => {
  let repo = "";
  let root = "";
  let h: Harness;
  let mainId = "";

  beforeAll(async () => {
    ({ root, repo } = await makeRepo());
    const main = localWorkspace(repo);
    mainId = main.id;
    h = harness(makeConfig(root, [main]));
  });

  test("a folder outside git has no tasks and says why", async () => {
    const plain = join(root, "plain");
    await mkdir(plain);
    const config = makeConfig(root, [localWorkspace(plain)]);
    const other = harness(config);
    const listed = await other.call("GET", `/workspaces/${config.workspaces[0]!.id}/tasks`);
    expect(listed.status).toBe(200);
    expect(listed.json.git).toBe(false);
    const created = await other.call("POST", `/workspaces/${config.workspaces[0]!.id}/tasks`, { prompt: "x" });
    expect(created.status).toBe(400);
    expect(created.json.code).toBe("task_not_git");
  });

  test("creating a task makes a worktree next to the repository and registers it as its own workspace", async () => {
    const created = await h.call("POST", `/workspaces/${mainId}/tasks`, { prompt: "Add a greeting file" });
    expect(created.status).toBe(201);
    const task = created.json.task as Record<string, string>;
    expect(dirname(task.path)).toBe(tasksDir(repo));
    expect(existsSync(join(task.path, ".git"))).toBe(true);
    expect(task.branch.startsWith("omnirush/")).toBe(true);
    expect(task.state).toBe("created");
    const workspace = h.config.workspaces.find((entry) => entry.path === task.path);
    expect(workspace?.task).toEqual({ parentWorkspaceId: mainId, taskId: task.id });
    expect(task.workspaceId).toBe(workspace!.id);
    expect(h.config.authorizedRoots).toContain(task.path);
    const saved = JSON.parse(await readFile(join(root, "server.json"), "utf8")) as { workspaces: WorkspaceInfo[] };
    expect(saved.workspaces.find((entry) => entry.path === task.path)?.task).toEqual({ parentWorkspaceId: mainId, taskId: task.id });
    // The main checkout is untouched.
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  test("the first prompt of the task's chat records its session and worktree.task_started once", async () => {
    const workspace = h.config.workspaces.find((entry) => entry.task)!;
    await noteTaskPrompt(workspace, "ses_task1", (sessionId, type, data) => h.traces.push({ sessionId, type, data }), Date.now() - 10_000);
    await noteTaskPrompt(workspace, "ses_task1", (sessionId, type, data) => h.traces.push({ sessionId, type, data }));
    await noteTaskPrompt(workspace, "ses_other", (sessionId, type, data) => h.traces.push({ sessionId, type, data }));
    const started = h.traces.filter((trace) => trace.type === TASK_STARTED_EVENT);
    expect(started.length).toBe(1);
    expect(started[0]!.sessionId).toBe("ses_task1");
    expect(started[0]!.data.origin).toBe("desktop");
    expect(JSON.stringify(started[0]!.data)).not.toContain(repo);
    const record = await readTask(repo, workspace.task!.taskId);
    expect(record.sessionId).toBe("ses_task1");
    expect(record.state).toBe("running");
  });

  test("a prompt in an ordinary workspace changes nothing", async () => {
    const before = h.traces.length;
    await noteTaskPrompt(localWorkspace(repo), "ses_main", (sessionId, type, data) => h.traces.push({ sessionId, type, data }));
    expect(h.traces.length).toBe(before);
  });

  test("the board shows running while the chat works and done once it is idle, with the changed files", async () => {
    const workspace = h.config.workspaces.find((entry) => entry.task)!;
    h.busy.set("ses_task1", true);
    let listed = await h.call("GET", `/workspaces/${mainId}/tasks`);
    let task = (listed.json.tasks as Array<Record<string, unknown>>)[0]!;
    expect(task.state).toBe("running");
    const refused = await h.call("POST", `/workspaces/${mainId}/tasks/${String(task.id)}/apply`);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("task_running");
    await writeFile(join(workspace.path, "greeting.txt"), "hi\n");
    await writeFile(join(workspace.path, "notes.txt"), "one\ntwo\n");
    h.busy.set("ses_task1", false);
    listed = await h.call("GET", `/workspaces/${mainId}/tasks`);
    task = (listed.json.tasks as Array<Record<string, unknown>>)[0]!;
    expect(task.state).toBe("done");
    expect(task.files).toBe(2);
    expect(listed.json.repo).toBe("app");
    expect(listed.json.branch).toBe("main");
    const shown = await h.call("GET", `/workspaces/${mainId}/tasks/${String(task.id)}`);
    expect(String(shown.json.stat)).toContain("greeting.txt");
    expect(shown.json.reply).toBe("All done: added the file.");
  });

  test("apply puts the changes into the main checkout uncommitted and records worktree.task_merged on the task's chat", async () => {
    const id = (await readTask(repo, h.config.workspaces.find((entry) => entry.task)!.task!.taskId)).id;
    const applied = await h.call("POST", `/workspaces/${mainId}/tasks/${id}/apply`);
    expect(applied.status).toBe(200);
    expect(readFileSync(join(repo, "greeting.txt"), "utf8")).toBe("hi\n");
    expect(git(repo, "log", "--oneline").split("\n").length).toBe(1);
    const merged = h.traces.filter((trace) => trace.type === TASK_MERGED_EVENT);
    expect(merged.length).toBe(1);
    expect(merged[0]!.sessionId).toBe("ses_task1");
    expect(merged[0]!.data).toMatchObject({ mode: "apply", files_changed: 2, origin: "desktop" });
    expect((applied.json.task as Record<string, unknown>).state).toBe("applied");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "applied");
  });

  test("a conflicting apply changes nothing and says so; merge brings a clean task in as a merge commit", async () => {
    const created = await h.call("POST", `/workspaces/${mainId}/tasks`, { prompt: "Edit the readme" });
    const task = created.json.task as Record<string, string>;
    const workspace = h.config.workspaces.find((entry) => entry.task?.taskId === task.id)!;
    await noteTaskPrompt(workspace, "ses_task2", () => undefined, Date.now() - 10_000);
    await writeFile(join(task.path, "README.md"), "hello from the task\n");
    await writeFile(join(repo, "README.md"), "hello from main\n");
    const conflict = await h.call("POST", `/workspaces/${mainId}/tasks/${task.id}/apply`);
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe("task_conflict");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("hello from main\n");
    git(repo, "checkout", "--", "README.md");
    const merged = await h.call("POST", `/workspaces/${mainId}/tasks/${task.id}/merge`);
    expect(merged.status).toBe(200);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("hello from the task\n");
    expect(git(repo, "log", "-1", "--format=%P").split(" ").length).toBe(2);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  test("stop aborts the task's chat; remove deletes the worktree, branch, record and workspace; clean removes finished ones", async () => {
    const created = await h.call("POST", `/workspaces/${mainId}/tasks`, { prompt: "Something long" });
    const task = created.json.task as Record<string, string>;
    const workspace = h.config.workspaces.find((entry) => entry.task?.taskId === task.id)!;
    await noteTaskPrompt(workspace, "ses_task3", () => undefined);
    h.busy.set("ses_task3", true);
    const stopped = await h.call("POST", `/workspaces/${mainId}/tasks/${task.id}/stop`);
    expect(stopped.json.stopped).toBe(true);
    expect(h.aborted).toContain("ses_task3");
    expect((stopped.json.task as Record<string, unknown>).state).toBe("stopped");
    const removed = await h.call("DELETE", `/workspaces/${mainId}/tasks/${task.id}`);
    expect(removed.status).toBe(200);
    expect(existsSync(task.path)).toBe(false);
    expect(git(repo, "branch", "--list", task.branch)).toBe("");
    expect(h.config.workspaces.some((entry) => entry.task?.taskId === task.id)).toBe(false);
    expect(h.config.authorizedRoots).not.toContain(task.path);
    expect(h.stopped).toContain(workspace.id);

    const cleaned = await h.call("POST", `/workspaces/${mainId}/tasks/clean`);
    expect((cleaned.json.removed as string[]).length).toBe(2);
    expect(h.config.workspaces.filter((entry) => entry.task)).toEqual([]);
    expect(readdirSync(tasksDir(repo)).filter((name) => !name.startsWith("."))).toEqual([]);
    const listed = await h.call("GET", `/workspaces/${mainId}/tasks`);
    expect(listed.json.tasks).toEqual([]);
  });

  test("removing a running task stops its chat and waits for it to end first; a dirty checkout is noted on the task", async () => {
    await writeFile(join(repo, "README.md"), "edited, not committed\n");
    const created = await h.call("POST", `/workspaces/${mainId}/tasks`, { prompt: "Runs a while" });
    const task = created.json.task as Record<string, unknown>;
    expect(task.startedDirty).toBe(true);
    expect(String(task.baseCommit)).toMatch(/^[0-9a-f]{40}$/);
    git(repo, "checkout", "--", "README.md");
    const workspace = h.config.workspaces.find((entry) => entry.task?.taskId === task.id)!;
    await noteTaskPrompt(workspace, "ses_task4", () => undefined);
    h.busy.set("ses_task4", true);
    const order: string[] = [];
    const before = h.aborted.length;
    setTimeout(() => { order.push("ended"); h.busy.set("ses_task4", false); }, 600);
    const removed = await h.call("DELETE", `/workspaces/${mainId}/tasks/${String(task.id)}`);
    order.push("removed");
    expect(removed.status).toBe(200);
    expect(h.aborted.slice(before)).toEqual(["ses_task4"]);
    expect(order).toEqual(["ended", "removed"]);
    expect(existsSync(String(task.path))).toBe(false);
  });

  test("a task whose prompt never arrived stops counting as starting", async () => {
    const created = await h.call("POST", `/workspaces/${mainId}/tasks`, { prompt: "Never sent" });
    const task = created.json.task as Record<string, string>;
    const record = await readTask(repo, task.id);
    const later = await liveTask(record, null, { sessionBusy: async () => null, abort: async () => undefined, lastReply: async () => "" }, Date.now() + 3 * 60_000);
    expect(later.state).toBe("stopped");
    await h.call("DELETE", `/workspaces/${mainId}/tasks/${task.id}`);
  });
});

describe("parallel task routes on the server", () => {
  test("listed for the host, refused without its token", async () => {
    const { root, repo } = await makeRepo();
    const config = makeConfig(root, [localWorkspace(repo)]);
    const server = await startServer(config) as { port: number; stop: (close?: boolean) => void | Promise<void> };
    try {
      const url = `http://127.0.0.1:${server.port}/workspaces/${config.workspaces[0]!.id}/tasks`;
      const denied = await fetch(url, { headers: { Authorization: `Bearer ${config.token}` } });
      expect(denied.status).toBe(401);
      const allowed = await fetch(url, { headers: { Authorization: `Bearer ${config.token}`, "X-OmniRush-Host-Token": config.hostToken } });
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toMatchObject({ git: true, repo: "app", tasks: [] });
    } finally {
      await server.stop(true);
    }
  });
});

test("CLI/desktop parity: the workspace modules match PARITY.sha256 (the same list ships in the CLI)", () => {
  const dir = join(import.meta.dir, "workspace");
  const lines = readFileSync(join(dir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
  const listed = new Map(lines.map((line) => { const [hash, name] = line.split(/\s+/); return [name!, hash!]; }));
  const files = readdirSync(dir).filter((name) => name.endsWith(".mjs")).sort();
  expect([...listed.keys()].sort()).toEqual(files);
  expect(files).toEqual(["home-view.mjs", "worktree-tasks.mjs"]);
  for (const name of files) {
    expect(createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")).toBe(listed.get(name)!);
  }
});
