/**
 * The desktop editor's search in files: ripgrep (on PATH, or the copy the
 * engine downloads to its data folder), else `git grep`. It runs as the user,
 * reads only inside the workspace, honours .gitignore, skips binary files,
 * and caps matches and time. Replacing is done by the editor itself (it
 * edits the open documents and saves them through the editor's file route).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { engineDataDir, userDataHome } from "../engine-data-home.js";
import { ApiError } from "../errors.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { addRoute, type Route } from "./registry.js";

export const SEARCH_MAX_MATCHES = 5_000;
export const SEARCH_MAX_FILES = 1_000;
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_LINE_CHARS = 400;
const MAX_QUERY = 1_000;
const MAX_GLOBS = 50;

export type SearchOptions = {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string[];
  exclude: string[];
  maxMatches: number;
};

/** One match: 1-based line, 0-based UTF-16 columns into `text` (the line, cut to 400 chars around the match). */
export type SearchMatch = { line: number; text: string; start: number; end: number; textOffset: number };
export type SearchFileResult = { path: string; matches: SearchMatch[] };
export type SearchResult = { engine: "ripgrep" | "git" | "none"; files: SearchFileResult[]; matchCount: number; truncated: boolean; timedOut: boolean };

type RegisterOptions = {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
};

/** ripgrep: on PATH, or the copy the engine downloads into its data folder (the desktop engine's own, else the default one). */
export function findRipgrep(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = process.platform === "win32" ? "rg.exe" : "rg";
  if (env.OMNIRUSH_RG && existsSync(env.OMNIRUSH_RG)) return env.OMNIRUSH_RG;
  for (const dir of (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  for (const dataDir of [engineDataDir(env), join(userDataHome(env), "omnirush")]) {
    const engineCopy = join(dataDir, "bin", name);
    if (existsSync(engineCopy)) return engineCopy;
  }
  return null;
}

function globList(value: unknown): string[] {
  const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item && !item.includes("\0") && !item.startsWith("/") && !/^[A-Za-z]:/.test(item) && !item.split(/[\\/]/).includes(".."))
    .slice(0, MAX_GLOBS);
}

export function parseSearchOptions(body: Record<string, unknown>): SearchOptions {
  const query = typeof body.query === "string" ? body.query : "";
  if (!query || query.length > MAX_QUERY) throw new ApiError(400, "invalid_payload", "A search text is required");
  if (body.regex === true) {
    try {
      new RegExp(query);
    } catch {
      throw new ApiError(400, "invalid_regex", "This is not a valid regular expression");
    }
  }
  const max = typeof body.maxMatches === "number" && Number.isFinite(body.maxMatches) ? Math.floor(body.maxMatches) : SEARCH_MAX_MATCHES;
  return {
    query,
    regex: body.regex === true,
    caseSensitive: body.caseSensitive === true,
    wholeWord: body.wholeWord === true,
    include: globList(body.include),
    exclude: globList(body.exclude),
    maxMatches: Math.min(Math.max(max, 1), SEARCH_MAX_MATCHES),
  };
}

function cutLine(text: string, start: number, end: number): { text: string; start: number; end: number; textOffset: number } {
  const clean = text.replace(/\r?\n$/, "");
  if (clean.length <= MAX_LINE_CHARS) return { text: clean, start, end, textOffset: 0 };
  const from = Math.max(0, Math.min(start - 80, clean.length - MAX_LINE_CHARS));
  return { text: clean.slice(from, from + MAX_LINE_CHARS), start: start - from, end: Math.min(end - from, MAX_LINE_CHARS), textOffset: from };
}

/** UTF-8 byte offset in `line` to a UTF-16 index. */
function byteToIndex(line: string, byteOffset: number): number {
  const buffer = Buffer.from(line, "utf8");
  return buffer.subarray(0, Math.max(0, Math.min(byteOffset, buffer.length))).toString("utf8").length;
}

type RunOutcome = { timedOut: boolean; code: number | null; stderr: string; spawnError?: string };

function run(cmd: string, args: string[], cwd: string, onLine: (line: string) => boolean): Promise<RunOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, LC_ALL: "C.UTF-8" } });
    let buffered = "";
    let stderr = "";
    let stopped = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SEARCH_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stopped) return;
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (!onLine(line)) {
          stopped = true;
          child.kill("SIGKILL");
          return;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ timedOut, code: null, stderr: error.message, spawnError: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!stopped && buffered) onLine(buffered);
      resolvePromise({ timedOut, code, stderr });
    });
  });
}

export async function searchWorkspace(root: string, options: SearchOptions, rg = findRipgrep()): Promise<SearchResult> {
  const files = new Map<string, SearchMatch[]>();
  let matchCount = 0;
  let truncated = false;
  const add = (path: string, match: SearchMatch) => {
    if (path.split("/").some((part) => part.toLowerCase() === ".git")) return true;
    let list = files.get(path);
    if (!list) {
      if (files.size >= SEARCH_MAX_FILES) {
        truncated = true;
        return false;
      }
      list = [];
      files.set(path, list);
    }
    list.push(match);
    matchCount += 1;
    if (matchCount >= options.maxMatches) {
      truncated = true;
      return false;
    }
    return true;
  };

  if (rg) {
    // `--path-separator /`: Windows paths come back as `src/a.ts`, like everywhere else.
    const args = ["--json", "--no-config", "--max-columns", "2000", "--max-filesize", "5M", "--no-follow", "--path-separator", "/"];
    if (!options.regex) args.push("--fixed-strings");
    if (options.caseSensitive) args.push("--case-sensitive");
    else args.push("--ignore-case");
    if (options.wholeWord) args.push("--word-regexp");
    for (const glob of options.include) args.push("--glob", glob);
    for (const glob of options.exclude) args.push("--glob", `!${glob}`);
    args.push("--glob", "!.git", "--", options.query, ".");
    const outcome = await run(rg, args, root, (line) => {
      let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: Array<{ start: number; end: number }> } };
      try {
        event = JSON.parse(line);
      } catch {
        return true;
      }
      if (event.type !== "match" || !event.data?.path?.text || typeof event.data.lines?.text !== "string") return true;
      const path = event.data.path.text.replace(/^\.\//, "").replace(/\\/g, "/");
      const text = event.data.lines.text;
      for (const sub of event.data.submatches ?? []) {
        const start = byteToIndex(text, sub.start);
        const end = byteToIndex(text, sub.end);
        if (!add(path, { line: event.data.line_number ?? 0, ...cutLine(text, start, end) })) return false;
      }
      return true;
    });
    if (outcome.spawnError) throw new ApiError(500, "search_failed", `ripgrep could not start: ${outcome.spawnError.slice(0, 200)}`);
    if (outcome.code === 2 && !matchCount && /regex|parse/i.test(outcome.stderr)) {
      throw new ApiError(400, "invalid_regex", outcome.stderr.trim().slice(0, 300));
    }
    return { engine: "ripgrep", files: [...files].map(([path, matches]) => ({ path, matches })), matchCount, truncated, timedOut: outcome.timedOut };
  }

  // No ripgrep: git grep in a repository (tracked and untracked, ignored files left out), matched again here for columns.
  // Plain text is a fixed string (-F). A regex tries Perl syntax (-P, closest to the editor's) and, where git has no
  // PCRE (Apple's git), extended syntax (-E). A failing git is an error, never an empty result.
  if (!existsSync(resolve(root, ".git"))) return { engine: "none", files: [], matchCount: 0, truncated: false, timedOut: false };
  const source = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(options.wholeWord ? `\\b(?:${source})\\b` : source, options.caseSensitive ? "g" : "gi");
  const gitGrep = async (syntax: "-F" | "-P" | "-E") => {
    const args = ["-c", "core.quotePath=false", "grep", "-n", "-z", "-I", "--untracked", "--exclude-standard", "--full-name", syntax];
    if (!options.caseSensitive) args.push("-i");
    if (options.wholeWord) args.push("-w");
    // Pathspecs are OR-ed: with include globs, those alone (not "."), then the excludes.
    args.push("-e", options.query, "--");
    if (options.include.length) for (const glob of options.include) args.push(`:(glob)${glob}`);
    else args.push(".");
    for (const glob of options.exclude) args.push(`:(exclude,glob)${glob}`);
    // -z: `path\0line\0text`, so a file name with `:12:` in it cannot be mis-split.
    return run("git", args, root, (line) => {
      const [path, lineNumber, ...rest] = line.split("\0");
      if (!path || !lineNumber || !rest.length) return true;
      const text = rest.join("\0");
      pattern.lastIndex = 0;
      let found: RegExpExecArray | null;
      while ((found = pattern.exec(text)) !== null) {
        if (found[0].length === 0) {
          pattern.lastIndex += 1;
          continue;
        }
        if (!add(path, { line: Number(lineNumber), ...cutLine(text, found.index, found.index + found[0].length) })) return false;
      }
      return true;
    });
  };
  let outcome = await gitGrep(options.regex ? "-P" : "-F");
  if (outcome.spawnError) throw new ApiError(500, "search_failed", `git could not start: ${outcome.spawnError.slice(0, 200)}`);
  if (options.regex && outcome.code === 128 && !matchCount && /perl|pcre/i.test(outcome.stderr)) outcome = await gitGrep("-E");
  // 0 = matches, 1 = none; anything else (128: bad pattern, no PCRE …) is an error unless matching was cut short on purpose.
  if (outcome.code !== null && outcome.code > 1 && !truncated && !outcome.timedOut) {
    const message = outcome.stderr.replace(/^fatal:\s*/i, "").trim().slice(0, 300) || "git grep failed";
    throw new ApiError(400, options.regex ? "invalid_regex" : "search_failed", message);
  }
  return { engine: "git", files: [...files].map(([path, matches]) => ({ path, matches })), matchCount, truncated, timedOut: outcome.timedOut };
}

export function registerEditorSearchRoutes(options: RegisterOptions): void {
  const { routes, config, jsonResponse, readJsonBody, resolveWorkspace } = options;
  addRoute(routes, "POST", "/workspace/:id/editor/search", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const search = parseSearchOptions(await readJsonBody(ctx.request));
    return jsonResponse(await searchWorkspace(resolve(workspace.path), search));
  });
}
