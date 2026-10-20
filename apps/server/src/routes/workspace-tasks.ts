import path from "node:path";

import { ApiError } from "../errors.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { workspaceIdForPath } from "../workspaces.js";
import { projectName, relativeAge } from "../workspace/home-view.mjs";
import {
  bringBack,
  createTask,
  isFinished,
  listTasks,
  readTask,
  removeTask,
  repoOf,
  stateLabel,
  TaskError,
  taskFileCount,
  taskMergedData,
  taskStartedData,
  taskStat,
  TASK_MERGED_EVENT,
  TASK_STARTED_EVENT,
  updateTask,
  type TaskRecord,
} from "../workspace/worktree-tasks.mjs";
import { addRoute, type Route } from "./registry.js";
import { addLocalWorkspace, forgetLocalWorkspace } from "./workspaces.js";

/** At most this many tasks of one repository run at once (the CLI's limit too). */
export const MAX_RUNNING_TASKS = 4;
/** A task whose engine session is not busy yet right after its prompt is still starting, not done. */
const START_GRACE_MS = 5_000;
/** A task that never got its prompt (the app closed in between) stops counting as starting. */
const NEVER_STARTED_MS = 2 * 60_000;
/** How long removing a running task waits for its stopped chat to end. */
const STOP_WAIT_MS = 15_000;
const REPLY_MAX_CHARS = 4_000;

/** What the routes need from the engine, per task workspace (server.ts supplies it; tests fake it). */
export interface TaskEngine {
  /** Whether the session is working now; null when the engine could not say. */
  sessionBusy(workspace: WorkspaceInfo, sessionId: string): Promise<boolean | null>;
  abort(workspace: WorkspaceInfo, sessionId: string): Promise<void>;
  /** The text of the session's last assistant reply ("" when none). */
  lastReply(workspace: WorkspaceInfo, sessionId: string): Promise<string>;
}

interface RegisterWorkspaceTaskRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  onWorkspacesChanged: () => void;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  serializeWorkspace: (workspace: WorkspaceInfo) => unknown;
  stopWorkspaceWork?: (config: ServerConfig, workspace: WorkspaceInfo) => Promise<void>;
  engine: TaskEngine;
  /** Records a trace event on a session the uploader has open; a no-op otherwise. */
  recordTrace: (sessionId: string, type: string, data: Record<string, unknown>) => void;
}

export type TaskView = {
  id: string;
  title: string;
  prompt: string;
  state: TaskRecord["state"];
  label: string;
  branch: string;
  baseBranch: string | null;
  baseCommit: string;
  /** The main checkout had uncommitted changes when the task started: they are not in the task. */
  startedDirty: boolean;
  name: string;
  path: string;
  workspaceId: string | null;
  sessionId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  age: string;
  files: number | null;
  finished: boolean;
  result: TaskRecord["result"];
};

function taskWorkspaceOf(config: ServerConfig, record: TaskRecord): WorkspaceInfo | null {
  const id = workspaceIdForPath(record.path);
  return config.workspaces.find((entry) => entry.id === id && entry.task?.taskId === record.id) ?? null;
}

function sinceMs(iso: string | null, now: number): number {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
}

/**
 * A desktop task's state as it is now: running while its session works, done
 * once it is idle (and running again when the person continues it), stopped
 * when its prompt never arrived. Changes are saved into the record.
 */
export async function liveTask(record: TaskRecord, workspace: WorkspaceInfo | null, engine: TaskEngine, now = Date.now()): Promise<TaskRecord> {
  // Each change is decided again on the stored record: its first prompt may be noted at the same time.
  if (record.state === "created" && !record.sessionId && sinceMs(record.createdAt, now) > NEVER_STARTED_MS) {
    return updateTask(record, (current) => current.state === "created" && !current.sessionId
      ? { state: "stopped", finishedAt: new Date(now).toISOString() }
      : {});
  }
  if (!workspace || !record.sessionId || (record.state !== "running" && record.state !== "done")) return record;
  const busy = await engine.sessionBusy(workspace, record.sessionId).catch(() => null);
  if (busy === true && record.state === "done") {
    return updateTask(record, (current) => current.state === "done" ? { state: "running", finishedAt: null } : {});
  }
  if (busy === false && record.state === "running" && sinceMs(record.startedAt, now) > START_GRACE_MS) {
    return updateTask(record, (current) => current.state === "running" ? { state: "done", finishedAt: new Date(now).toISOString() } : {});
  }
  return record;
}

export async function taskView(config: ServerConfig, record: TaskRecord, now = Date.now()): Promise<TaskView> {
  return {
    id: record.id,
    title: record.title,
    prompt: record.prompt,
    state: record.state,
    label: stateLabel(record.state),
    branch: record.branch,
    baseBranch: record.baseBranch,
    baseCommit: record.baseCommit,
    startedDirty: record.startedDirty === true,
    name: projectName(record.path),
    path: record.path,
    workspaceId: taskWorkspaceOf(config, record)?.id ?? null,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    age: relativeAge(Date.parse(record.startedAt || record.createdAt), now),
    // A task brought back or gone has nothing left to count (its result says how many).
    files: record.state === "applied" || record.state === "merged" ? record.result?.files ?? null
      : record.state === "missing" ? null
      : await taskFileCount(record).catch(() => null),
    finished: isFinished(record),
    result: record.result,
  };
}

function taskApiError(error: unknown): never {
  if (error instanceof TaskError) {
    const status = error.code === "not_found" ? 404
      : error.code === "not_git" || error.code === "no_commit" || error.code === "no_prompt" || error.code === "bad_id" ? 400
      : 409;
    throw new ApiError(status, `task_${error.code}`, error.message, error.details === undefined ? undefined : { details: error.details });
  }
  throw error;
}

/**
 * The first prompt of a task's own chat: the task records which chat it is
 * and that it runs, and that chat's trace gets "worktree.task_started" once.
 * Only for task workspaces; every other prompt is untouched.
 */
/** Tasks whose first prompt was noted already: later prompts in their chats skip the record read. */
const startedTasks = new Set<string>();

export async function noteTaskPrompt(
  workspace: WorkspaceInfo,
  sessionId: string,
  recordTrace: (sessionId: string, type: string, data: Record<string, unknown>) => void,
  now = Date.now(),
): Promise<void> {
  const link = workspace.task;
  if (!link || startedTasks.has(link.taskId)) return;
  const record = await readTask(workspace.path, link.taskId).catch(() => null);
  if (!record || record.sessionId) {
    if (record) startedTasks.add(link.taskId);
    return;
  }
  let first = false;
  const started = await updateTask(record, (current) => {
    if (current.sessionId) return {};
    first = true;
    return { sessionId, state: "running", startedAt: new Date(now).toISOString() };
  }).catch(() => null);
  if (started) startedTasks.add(link.taskId);
  if (started && first) recordTrace(sessionId, TASK_STARTED_EVENT, taskStartedData(started));
}

export function registerWorkspaceTaskRoutes(options: RegisterWorkspaceTaskRoutesOptions): void {
  const { routes, config, jsonResponse, readJsonBody, ensureWritable, resolveWorkspace, engine } = options;

  /** The workspace the board was opened in (a task's own workspace counts as its repository's). */
  const repoWorkspace = (id: string) => resolveWorkspace(config, id).then((workspace) => {
    if (workspace.workspaceType === "remote") throw new ApiError(400, "task_remote", "Parallel tasks run on this computer's folders only.");
    return workspace;
  });

  const findRecord = async (workspace: WorkspaceInfo, taskId: string) => {
    const record = await readTask(workspace.path, taskId).catch(taskApiError);
    // Only a record of this workspace's own repository (a copied or edited record names another).
    const repo = await repoOf(workspace.path);
    if (!repo || path.resolve(record.repo) !== repo.top) throw new ApiError(404, "task_not_found", "No such task in this repository.");
    return liveTask(record, taskWorkspaceOf(config, record), engine);
  };

  /** Whether the task's chat works now (continued after it finished): its files are then still changing. */
  const chatWorking = async (record: TaskRecord) => {
    const taskWorkspace = taskWorkspaceOf(config, record);
    if (!taskWorkspace || !record.sessionId) return false;
    return (await engine.sessionBusy(taskWorkspace, record.sessionId).catch(() => null)) === true;
  };

  /** Stops the task's work (and waits for its chat to end), removes its folder, branch and record, and its workspace. */
  const removeOne = async (record: TaskRecord) => {
    const workspace = taskWorkspaceOf(config, record);
    if (workspace && record.sessionId && (record.state === "running" || record.state === "created")) {
      await engine.abort(workspace, record.sessionId).catch(() => undefined);
      const deadline = Date.now() + STOP_WAIT_MS;
      while (Date.now() < deadline && (await engine.sessionBusy(workspace, record.sessionId).catch(() => false))) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (workspace) await options.stopWorkspaceWork?.(config, workspace).catch(() => undefined);
    await removeTask(record, { force: true }).catch(taskApiError);
    if (workspace) await forgetLocalWorkspace(config, workspace.id);
  };

  addRoute(routes, "GET", "/workspaces/:id/tasks", "host", async (ctx) => {
    const workspace = await repoWorkspace(ctx.params.id);
    const repo = await repoOf(workspace.path);
    if (!repo) return jsonResponse({ git: false, repo: null, branch: null, hasCommit: false, tasks: [] });
    const records = await listTasks(workspace.path, { repo });
    const now = Date.now();
    const live = await Promise.all(records.map((record) => liveTask(record, taskWorkspaceOf(config, record), engine, now)));
    return jsonResponse({
      git: true,
      repo: repo.name,
      branch: repo.branch,
      hasCommit: Boolean(repo.head),
      tasks: await Promise.all(live.map((record) => taskView(config, record, now))),
    });
  });

  addRoute(routes, "POST", "/workspaces/:id/tasks", "host", async (ctx) => {
    ensureWritable(config);
    const workspace = await repoWorkspace(ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
    const parentSessionId = typeof body.parentSessionId === "string" && body.parentSessionId.trim() ? body.parentSessionId.trim() : null;
    if (!prompt) throw new ApiError(400, "task_no_prompt", "A task needs a prompt.");
    const running = (await listTasks(workspace.path)).filter((record) => record.state === "running" || record.state === "created");
    if (running.length >= MAX_RUNNING_TASKS) {
      throw new ApiError(409, "task_busy", `${MAX_RUNNING_TASKS} tasks are running already; wait for one to finish.`);
    }
    const record = await createTask({ dir: workspace.path, prompt, title, origin: "desktop", parentSessionId }).catch(taskApiError);
    const parentWorkspaceId = workspace.task?.parentWorkspaceId ?? workspace.id;
    const { workspace: taskWorkspace } = await addLocalWorkspace(config, {
      folderPath: record.path,
      name: projectName(record.path),
      preset: workspace.preset || "starter",
      actor: ctx.actor,
      task: { parentWorkspaceId, taskId: record.id },
    }).catch(async (error: unknown) => {
      // No workspace for it: nothing half-made is left behind.
      await removeTask(record, { force: true }).catch(() => undefined);
      throw error;
    });
    options.onWorkspacesChanged();
    return jsonResponse({ task: await taskView(config, record), workspace: options.serializeWorkspace(taskWorkspace) }, 201);
  });

  addRoute(routes, "GET", "/workspaces/:id/tasks/:taskId", "host", async (ctx) => {
    const workspace = await repoWorkspace(ctx.params.id);
    const record = await findRecord(workspace, ctx.params.taskId);
    const taskWorkspace = taskWorkspaceOf(config, record);
    const reply = taskWorkspace && record.sessionId
      ? (await engine.lastReply(taskWorkspace, record.sessionId).catch(() => "")).slice(0, REPLY_MAX_CHARS)
      : "";
    // Reading the changes stages them in the task's own index: never while it works.
    const stat = record.state === "running" || record.state === "created" || (await chatWorking(record)) ? "" : await taskStat(record).catch(() => "");
    return jsonResponse({ task: await taskView(config, record), stat, reply });
  });

  for (const mode of ["apply", "merge"] as const) {
    addRoute(routes, "POST", `/workspaces/:id/tasks/:taskId/${mode}`, "host", async (ctx) => {
      ensureWritable(config);
      const workspace = await repoWorkspace(ctx.params.id);
      const record = await findRecord(workspace, ctx.params.taskId);
      if (await chatWorking(record)) throw new ApiError(409, "task_running", "The task's chat is still working; wait for it or stop it.");
      const done = await bringBack(record, { mode }).catch(taskApiError);
      if (done.record.sessionId) options.recordTrace(done.record.sessionId, TASK_MERGED_EVENT, taskMergedData(done.record, done));
      return jsonResponse({ mode, files: done.files, task: await taskView(config, done.record) });
    });
  }

  addRoute(routes, "POST", "/workspaces/:id/tasks/:taskId/stop", "host", async (ctx) => {
    ensureWritable(config);
    const workspace = await repoWorkspace(ctx.params.id);
    const record = await findRecord(workspace, ctx.params.taskId);
    const taskWorkspace = taskWorkspaceOf(config, record);
    if (record.state !== "running" && record.state !== "created") return jsonResponse({ stopped: false, task: await taskView(config, record) });
    if (taskWorkspace && record.sessionId) await engine.abort(taskWorkspace, record.sessionId).catch(() => undefined);
    const stopped = await updateTask(record, { state: "stopped", finishedAt: new Date().toISOString() });
    return jsonResponse({ stopped: true, task: await taskView(config, stopped) });
  });

  addRoute(routes, "DELETE", "/workspaces/:id/tasks/:taskId", "host", async (ctx) => {
    ensureWritable(config);
    const workspace = await repoWorkspace(ctx.params.id);
    const record = await findRecord(workspace, ctx.params.taskId);
    await removeOne(record);
    options.onWorkspacesChanged();
    return jsonResponse({ ok: true, removed: record.id });
  });

  addRoute(routes, "POST", "/workspaces/:id/tasks/clean", "host", async (ctx) => {
    ensureWritable(config);
    const workspace = await repoWorkspace(ctx.params.id);
    const removed: string[] = [];
    for (const record of await listTasks(workspace.path)) {
      if (record.state !== "applied" && record.state !== "merged" && record.state !== "missing") continue;
      await removeOne(record).then(() => removed.push(record.id), () => undefined);
    }
    if (removed.length) options.onWorkspacesChanged();
    return jsonResponse({ removed });
  });
}
