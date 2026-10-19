// omnirush: parallel tasks, each in its own git worktree (shared by the CLI and the desktop app).
//
// PARITY: byte-identical in omnirush-cli assets/extensions/omnirush/workspace/
// and omnirush-gui apps/server/src/workspace/ (see PARITY.sha256 there).
//
// A task is a prompt that runs in a separate checkout of the repository, on its
// own branch, so several can run at once without touching the main checkout:
//
//   ~/code/app                      the main checkout (where the user works)
//   ~/code/app-tasks/<slug>         one worktree per task (branch omnirush/<slug>)
//   ~/code/app-tasks/.omnirush-tasks/<id>.json   the task records
//
// The worktrees sit NEXT TO the repository, never inside it, so a session in the
// main checkout never sees (or uploads) another task's files, and a task's
// session has exactly one project root: its worktree. Each task runs as its own
// session in that folder (the CLI: a separate headless run; the desktop: a
// workspace of its own), so capture, project copies and the sandbox treat it
// like any other project folder.
//
// The result comes back to the main checkout in one of two ways:
//   apply  the task's changes (vs the commit it started from) are applied to
//          the main checkout's working tree, uncommitted, for review
//   merge  the task's changes are committed on its branch, which is merged
//          into the main checkout's current branch (no fast-forward)
// Nothing here commits in the main checkout except `merge`, and nothing ever
// pushes. Removing a task removes its worktree and (unless kept) its branch.
//
// Plain JavaScript (node and bun), no dependencies besides node:*.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const TASKS_VERSION = 1;
/** Where the worktrees of `<repo>` go: a sibling folder `<repo>-tasks`. */
export const TASKS_SUFFIX = "-tasks";
/** The task records, inside the tasks folder (never inside a worktree). */
export const RECORDS_DIR = ".omnirush-tasks";
/** Task branches: `omnirush/<slug>`. */
export const BRANCH_PREFIX = "omnirush/";

/** Trace event on the task's own session when it starts (additive; see docs). */
export const TASK_STARTED_EVENT = "worktree.task_started";
/** Trace event when a task's result is applied or merged into the main checkout (additive). */
export const TASK_MERGED_EVENT = "worktree.task_merged";

/** The states a record goes through. */
export const STATES = Object.freeze(["created", "running", "done", "failed", "stopped", "applied", "merged", "missing"]);
const FINISHED = new Set(["done", "failed", "stopped"]);

const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** Runs git; resolves { code, stdout, stderr } (never rejects for a git error). */
export function runGit(args, { cwd, env, input, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = execFile("git", args, {
      cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (error && typeof error.code !== "number" ? String(error.message) : "") });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function gitOut(args, options) {
  const result = await runGit(args, options);
  if (result.code !== 0) throw new TaskError(firstLine(result.stderr) || `git ${args[0]} failed`, "git_failed");
  return result.stdout.trim();
}

export class TaskError extends Error {
  constructor(message, code = "task_failed", details) {
    super(message);
    this.name = "TaskError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

/**
 * The repository `dir` belongs to, resolved to its MAIN checkout (a task
 * started from inside a task's worktree still belongs to the main repository).
 * Null when `dir` is not in a git repository.
 */
export async function repoOf(dir) {
  const top = await runGit(["rev-parse", "--show-toplevel"], { cwd: dir });
  if (top.code !== 0) return null;
  const common = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir });
  if (common.code !== 0) return null;
  const commonDir = path.resolve(common.stdout.trim());
  const here = path.resolve(top.stdout.trim());
  // The main checkout is the folder holding the common .git directory (a bare repository has none).
  const main = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : here;
  const branch = (await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: main })).stdout.trim() || null;
  const head = (await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: main })).stdout.trim() || null;
  return { top: main, here, commonDir, branch, head, name: path.basename(main), inWorktree: here !== main };
}

/** The sibling folder holding `<repo>`'s task worktrees. */
export function tasksDir(top) {
  return path.join(path.dirname(top), `${path.basename(top)}${TASKS_SUFFIX}`);
}

export function recordsDir(top) {
  return path.join(tasksDir(top), RECORDS_DIR);
}

export function recordPath(top, id) {
  if (!/^[a-z0-9-]{4,64}$/.test(String(id))) throw new TaskError("Unknown task.", "bad_id");
  return path.join(recordsDir(top), `${id}.json`);
}

/** A short, filesystem- and branch-safe name from a title or prompt. */
export function slugify(text, max = 32) {
  const words = String(text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > max) break;
    slug = next;
  }
  return slug || "task";
}

/** A title for a prompt: its first line, trimmed to 60 characters. */
export function titleFor(prompt) {
  const line = firstLine(prompt).replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || "Task";
}

export function newTaskId(now = Date.now(), random = randomBytes(3)) {
  return `${now.toString(36)}-${Buffer.from(random).toString("hex")}`;
}

async function exists(file) {
  return stat(file).then(() => true, () => false);
}

async function writeRecord(file, record) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

/**
 * Creates a task: a new branch from the main checkout's HEAD and a worktree
 * for it in `<repo>-tasks/<slug>`, plus its record. Does not start anything.
 */
export async function createTask({ dir, prompt, title, origin = "cli", parentSessionId = null, now = Date.now() } = {}) {
  const text = String(prompt ?? "").trim();
  if (!text) throw new TaskError("A task needs a prompt.", "no_prompt");
  const repo = await repoOf(dir);
  if (!repo) throw new TaskError("Tasks run in a git repository; this folder is not in one.", "not_git");
  if (!repo.head) throw new TaskError("The repository has no commit yet; commit once, then start a task.", "no_commit");
  const id = newTaskId(now);
  const name = `${slugify(title || text, 24)}-${id.slice(-4)}`;
  const branch = `${BRANCH_PREFIX}${name}`;
  const worktree = path.join(tasksDir(repo.top), name);
  if (await exists(worktree)) throw new TaskError("A task folder with that name exists already; try again.", "exists");
  await mkdir(tasksDir(repo.top), { recursive: true });
  const added = await runGit(["worktree", "add", "-b", branch, worktree, repo.head], { cwd: repo.top });
  if (added.code !== 0) throw new TaskError(firstLine(added.stderr) || "Could not create the task's folder.", "worktree_failed");
  const record = {
    version: TASKS_VERSION, id, title: titleFor(title || text), prompt: text, origin,
    repo: repo.top, repoName: repo.name, path: worktree, branch,
    baseBranch: repo.branch, baseCommit: repo.head,
    state: "created", createdAt: new Date(now).toISOString(), startedAt: null, finishedAt: null,
    sessionId: null, parentSessionId: parentSessionId || null, pid: null, exitCode: null,
    summary: null, log: null, result: null,
  };
  await writeRecord(recordPath(repo.top, id), record);
  return record;
}

/** Merges `patch` into the stored record (re-read first, so concurrent writers keep each other's fields). */
export async function updateTask(record, patch) {
  const file = recordPath(record.repo, record.id);
  const current = JSON.parse(await readFile(file, "utf8").catch(() => "null")) || record;
  const next = { ...current, ...patch };
  await writeRecord(file, next);
  return next;
}

/** Merges `patch` into the record at `file` (a task's run reports through this); null when it is gone. */
export async function updateTaskFile(file, patch) {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (!raw) return null;
  const next = { ...JSON.parse(raw), ...patch };
  await writeRecord(file, next);
  return next;
}

/** Whether a process id is alive (signal 0). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** A record as it is now: a running task whose process is gone is "stopped", a task whose folder is gone "missing". */
export async function reconcile(record, { alive = pidAlive } = {}) {
  let next = record;
  if (!["applied", "merged"].includes(record.state) && !(await exists(record.path))) next = { ...next, state: "missing" };
  else if (record.state === "running" && record.pid && !alive(record.pid)) next = { ...next, state: "stopped" };
  return next;
}

/** Reads one task of the repository `dir` belongs to. */
export async function readTask(dir, id) {
  const repo = await repoOf(dir);
  if (!repo) throw new TaskError("This folder is not in a git repository.", "not_git");
  const raw = await readFile(recordPath(repo.top, id), "utf8").catch(() => null);
  if (!raw) throw new TaskError(`No task ${id}.`, "not_found");
  return reconcile(JSON.parse(raw));
}

/** All tasks of the repository `dir` belongs to, newest first. [] outside git. */
export async function listTasks(dir, options = {}) {
  const repo = options.repo ?? (await repoOf(dir));
  if (!repo) return [];
  const folder = recordsDir(repo.top);
  const names = await readdir(folder).catch(() => []);
  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(path.join(folder, name), "utf8"));
      if (record?.version === TASKS_VERSION && record.id) records.push(await reconcile(record, options));
    } catch {
      // A half-written or foreign file: skipped.
    }
  }
  return records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Finds a task by id or by a unique id/name prefix. */
export async function findTask(dir, ref) {
  const tasks = await listTasks(dir);
  const wanted = String(ref || "").trim();
  const exact = tasks.find((task) => task.id === wanted || path.basename(task.path) === wanted);
  if (exact) return exact;
  const matches = tasks.filter((task) => task.id.startsWith(wanted) || path.basename(task.path).startsWith(wanted));
  if (matches.length === 1) return matches[0];
  throw new TaskError(matches.length ? `"${wanted}" matches ${matches.length} tasks; use more of the id.` : `No task "${wanted}".`, matches.length ? "ambiguous" : "not_found");
}

/**
 * Stages everything in the task's worktree (its own index, never the main
 * checkout's) and returns the changed files vs the commit it started from:
 * [{ status: "A"|"M"|"D"|"R"|..., file }].
 */
export async function taskChanges(task) {
  if (!(await exists(task.path))) return [];
  const added = await runGit(["add", "-A"], { cwd: task.path });
  if (added.code !== 0) throw new TaskError(firstLine(added.stderr) || "Could not read the task's changes.", "git_failed");
  const out = await gitOut(["diff", "--cached", "--name-status", "-M", task.baseCommit], { cwd: task.path });
  return out ? out.split("\n").map((line) => {
    const [status, ...files] = line.split("\t");
    return { status: status[0], file: files[files.length - 1] };
  }) : [];
}

/**
 * How many files differ from the commit the task started from, read without
 * touching the worktree's index (safe while the task runs). Null when unknown.
 */
export async function taskFileCount(task) {
  if (!(await exists(task.path))) return null;
  const status = await runGit(["status", "--porcelain", "--untracked-files=all"], { cwd: task.path });
  const committed = await runGit(["diff", "--name-only", task.baseCommit, "HEAD"], { cwd: task.path });
  if (status.code !== 0 || committed.code !== 0) return null;
  const files = new Set(committed.stdout.split("\n").filter(Boolean));
  for (const line of status.stdout.split("\n")) if (line.length > 3) files.add(line.slice(3).replace(/^.* -> /, ""));
  return files.size;
}

/** The task's changes as a binary-safe patch vs the commit it started from ("" when none). */
export async function taskPatch(task) {
  await taskChanges(task);
  const result = await runGit(["diff", "--cached", "--binary", "-M", task.baseCommit], { cwd: task.path });
  if (result.code !== 0) throw new TaskError(firstLine(result.stderr) || "Could not read the task's changes.", "git_failed");
  return result.stdout;
}

/** A short text diff stat (`git diff --stat`) of the task's changes. */
export async function taskStat(task) {
  await taskChanges(task);
  return gitOut(["diff", "--cached", "--stat", "-M", task.baseCommit], { cwd: task.path }).catch(() => "");
}

/**
 * Brings a finished task's result into the main checkout.
 *   mode "apply": its patch is applied to the working tree (index untouched), all or nothing.
 *   mode "merge": its changes are committed on the task branch, which is merged (--no-ff).
 * Refuses a task that is still running. Returns the updated record plus
 * { files, mode }. On a conflict nothing is left half-done (merge --abort).
 */
export async function bringBack(task, { mode = "apply", message, now = Date.now() } = {}) {
  if (task.state === "running" || task.state === "created") throw new TaskError("The task is still running; wait for it to finish (or stop it) first.", "running");
  if (task.state === "missing") throw new TaskError("The task's folder is gone.", "missing");
  if (task.state === "applied" || task.state === "merged") throw new TaskError(`The task was ${task.state} already.`, "done_already");
  const files = await taskChanges(task);
  if (!files.length) throw new TaskError("The task changed nothing.", "no_changes");
  if (mode === "apply") {
    const patch = await taskPatch(task);
    const check = await runGit(["apply", "--check", "--binary", "-"], { cwd: task.repo, input: patch });
    if (check.code !== 0) throw new TaskError("The changes do not apply cleanly to the main checkout (it changed in the same places). Use merge, or resolve by hand.", "conflict", { stderr: check.stderr.slice(0, 2000) });
    const applied = await runGit(["apply", "--binary", "-"], { cwd: task.repo, input: patch });
    if (applied.code !== 0) throw new TaskError(firstLine(applied.stderr) || "Could not apply the changes.", "apply_failed");
  } else if (mode === "merge") {
    const subject = message || `${task.title}`;
    const committed = await runGit(["commit", "-q", "-m", subject], { cwd: task.path });
    if (committed.code !== 0 && !/nothing to commit/.test(committed.stdout + committed.stderr)) {
      throw new TaskError(firstLine(committed.stderr) || "Could not commit the task's changes.", "commit_failed");
    }
    const merged = await runGit(["merge", "--no-ff", "--no-edit", task.branch], { cwd: task.repo });
    if (merged.code !== 0) {
      await runGit(["merge", "--abort"], { cwd: task.repo });
      throw new TaskError(firstLine(merged.stderr) || firstLine(merged.stdout) || "The merge stopped on a conflict; nothing was changed.", "conflict", { stderr: (merged.stdout + merged.stderr).slice(0, 2000) });
    }
  } else {
    throw new TaskError(`Unknown mode ${mode}.`, "bad_mode");
  }
  const record = await updateTask(task, { state: mode === "apply" ? "applied" : "merged", result: { mode, files: files.length, at: new Date(now).toISOString() } });
  return { record, files, mode };
}

/**
 * Removes a task: its worktree (even with changes left in it), its branch
 * (unless keepBranch) and its record. A running task is refused unless force.
 */
export async function removeTask(task, { keepBranch = false, force = false, alive = pidAlive } = {}) {
  if (task.state === "running" && alive(task.pid) && !force) throw new TaskError("The task is still running; stop it first.", "running");
  if (await exists(task.path)) {
    const removed = await runGit(["worktree", "remove", "--force", task.path], { cwd: task.repo });
    if (removed.code !== 0) {
      // A folder git no longer knows as a worktree: removed by hand, then pruned.
      await rm(task.path, { recursive: true, force: true });
    }
  }
  await runGit(["worktree", "prune"], { cwd: task.repo });
  if (!keepBranch) await runGit(["branch", "-D", task.branch], { cwd: task.repo });
  await rm(recordPath(task.repo, task.id), { force: true });
  return { removed: true, branchKept: keepBranch };
}

/** Removes every task that was applied, merged or whose folder is gone. */
export async function cleanTasks(dir, options = {}) {
  const removed = [];
  for (const task of await listTasks(dir, options)) {
    if (["applied", "merged", "missing"].includes(task.state)) {
      await removeTask(task, options).then(() => removed.push(task.id), () => undefined);
    }
  }
  return removed;
}

/** The trace data of TASK_STARTED_EVENT (no paths, no prompt: the session has those). */
export function taskStartedData(task) {
  return {
    task_id: task.id, origin: task.origin, branch: task.branch,
    base_branch: task.baseBranch, base_commit: task.baseCommit,
    parent_session_id: task.parentSessionId || null,
  };
}

/** The trace data of TASK_MERGED_EVENT. */
export function taskMergedData(task, { mode, files }) {
  return {
    task_id: task.id, origin: task.origin, mode, files_changed: Array.isArray(files) ? files.length : Number(files) || 0,
    task_session_id: task.sessionId || null, branch: task.branch, base_commit: task.baseCommit,
  };
}

/** Whether a task finished (successfully or not) and can be brought back or removed. */
export function isFinished(task) {
  return FINISHED.has(task.state);
}

/** One line for lists: "● running  fix-login-3f2a  Fix the login redirect  (2 min)". */
export function stateLabel(state) {
  return {
    created: "starting", running: "running", done: "done", failed: "failed", stopped: "stopped",
    applied: "applied", merged: "merged", missing: "missing",
  }[state] || state;
}
