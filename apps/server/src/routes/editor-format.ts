/**
 * The desktop editor's "Format on save": the project's own formatter on the editor's text (stdin in, stdout out;
 * nothing is written to the project). Only formatters the project sets up itself are used, never a built-in one:
 * Prettier when the project depends on it and has it installed (run with Node), gofmt, Ruff or Black when
 * pyproject.toml configures them, rustfmt for Cargo projects. A user action only: not an agent tool.
 *
 * A formatter is the project's code running on this computer, so it never runs until the person trusts it for this
 * project: the first request answers with the exact command and a hash of the formatter's configuration, and runs
 * only with a trust answer ("once", or "always", remembered per project folder and configuration hash; "never" is
 * remembered too). A changed configuration asks again. When the project uses the sandbox, the formatter runs in
 * its box (never on this computer, and not at all when the box is not running); otherwise it runs here with only
 * the basic environment a local MCP server gets (no app tokens, no engine password, no other keys).
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { boxHome, boxKey, canonicalRoot, readRecord, runDir, RUN_DIR, type BoxRecord } from "../box/common.js";
import { exec as boxExec } from "../box/client.js";
import { mapToBox } from "../box/launch.js";
import { ApiError } from "../errors.js";
import { mcpServerEnvironment } from "../mcp-allow/mcp-allow.mjs";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import { findOnPath } from "./editor-search.js";

const MAX_TEXT = 2_000_000;
/** As long as the editor waits (3 s): a slower formatter is stopped, the save has already gone out unformatted. */
const FORMAT_TIMEOUT_MS = 3_000;

const PRETTIER_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".jsonc", ".json5", ".css", ".scss", ".less",
  ".html", ".vue", ".svelte", ".md", ".mdx", ".yaml", ".yml", ".graphql", ".gql", ".hbs", ".handlebars",
]);

export type Formatter = {
  name: string;
  /** On this computer: the program and its arguments. */
  command: string;
  args: string[];
  /** In the project's box: the program (found on the box's PATH) and its arguments, project paths absolute here. */
  boxArgv: string[];
  /** What the trust prompt shows: the command with project-relative paths. */
  display: string;
  /** Files whose content decides what the formatter does (its configuration, its version): hashed for trust. */
  configFiles: string[];
};

export type TrustDecision = "always" | "never";
type TrustEntry = { decision: TrustDecision; hash: string; command: string; at: number };

type RegisterOptions = {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  /** The project's sandbox switch (the box service's decision). */
  sandboxOn: (workspace: WorkspaceInfo) => Promise<boolean>;
};

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Files in `dir` named like a formatter's configuration. */
function configFilesIn(dir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(dir).filter((name) => pattern.test(name)).sort().map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** The folders from the file's own up to the project root. */
function configFoldersUp(root: string, file: string): string[] {
  const folders: string[] = [];
  for (let dir = dirname(file); dir === root || dir.startsWith(root + sep); dir = dirname(dir)) {
    folders.push(dir);
    if (dir === root) break;
  }
  return folders;
}

/** The nearest package.json from the file up to the project root that names Prettier, and its folder. */
function prettierRoot(root: string, file: string): string | null {
  let dir = dirname(file);
  while (dir === root || dir.startsWith(root + sep)) {
    const text = readText(join(dir, "package.json"));
    if (text) {
      try {
        const json = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        if (json.dependencies?.prettier || json.devDependencies?.prettier) return dir;
      } catch {
        // not JSON: keep looking up
      }
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  return null;
}

/** Prettier's own script inside the project (3.x `bin/prettier.cjs`, 2.x `bin-prettier.js`), run with Node. */
function prettierScript(dir: string, root: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    for (const script of ["node_modules/prettier/bin/prettier.cjs", "node_modules/prettier/bin-prettier.js"]) {
      const full = join(at, script);
      if (existsSync(full)) return full;
    }
    if (at === root || !at.startsWith(root)) return null;
  }
}

/** The formatter for `file` in `root`, or null when the project sets none up for it. */
export function formatterFor(root: string, file: string, env: NodeJS.ProcessEnv = process.env): Formatter | null {
  const ext = extname(file).toLowerCase();
  const rel = relative(root, file).split(sep).join("/");
  const show = (path: string) => relative(root, path).split(sep).join("/");
  if (PRETTIER_EXTENSIONS.has(ext)) {
    const dir = prettierRoot(root, file);
    const script = dir ? prettierScript(dir, root) : null;
    const node = findOnPath("node", env);
    if (!dir || !script || !node) return null;
    const pattern = /^(?:\.prettierrc(?:\..+)?|prettier\.config\..+|\.prettierignore|\.editorconfig|package\.json|package\.ya?ml)$/;
    return {
      name: "Prettier",
      command: node,
      // One argument (`--stdin-filepath=…`): a file named like a flag (`--plugin=x.cjs`) stays a file name.
      args: [script, `--stdin-filepath=${rel}`],
      boxArgv: ["node", script, `--stdin-filepath=${rel}`],
      display: `node ${show(script)} --stdin-filepath=<file>`,
      // Prettier looks for its configuration from the file's folder up: every folder on the way counts.
      configFiles: [...new Set([...configFoldersUp(root, file).flatMap((folder) => configFilesIn(folder, pattern)), join(dirname(dirname(script)), "package.json")])],
    };
  }
  if (ext === ".go") {
    const gofmt = findOnPath("gofmt", env);
    return gofmt ? { name: "gofmt", command: gofmt, args: [], boxArgv: ["gofmt"], display: "gofmt", configFiles: [] } : null;
  }
  if (ext === ".py" || ext === ".pyi") {
    const pyproject = readText(join(root, "pyproject.toml")) ?? "";
    const files = configFilesIn(root, /^(?:pyproject\.toml|\.?ruff\.toml)$/);
    const ruff = /\[tool\.ruff/.test(pyproject) || /["']ruff[>=<~\s"']/.test(pyproject) ? findOnPath("ruff", env) : null;
    if (ruff) {
      const args = ["format", `--stdin-filename=${rel}`, "-"];
      return { name: "Ruff", command: ruff, args, boxArgv: ["ruff", ...args], display: "ruff format --stdin-filename=<file> -", configFiles: files };
    }
    const black = /\[tool\.black/.test(pyproject) ? findOnPath("black", env) : null;
    if (black) {
      const args = ["-q", `--stdin-filename=${rel}`, "-"];
      return { name: "Black", command: black, args, boxArgv: ["black", ...args], display: "black -q --stdin-filename=<file> -", configFiles: files };
    }
    return null;
  }
  if (ext === ".rs") {
    const cargo = readText(join(root, "Cargo.toml"));
    const rustfmt = cargo !== null ? findOnPath("rustfmt", env) : null;
    if (!rustfmt) return null;
    const edition = /edition\s*=\s*"(\d{4})"/.exec(cargo ?? "")?.[1] ?? "2021";
    const args = ["--emit", "stdout", "--edition", edition];
    return { name: "rustfmt", command: rustfmt, args, boxArgv: ["rustfmt", ...args], display: `rustfmt ${args.join(" ")}`, configFiles: configFilesIn(root, /^(?:Cargo\.toml|\.?rustfmt\.toml|rust-toolchain(?:\.toml)?)$/) };
  }
  return null;
}

/** The trust hash: what runs and every configuration file's content (a change asks again). */
export function formatterHash(formatter: Formatter, sandbox = false, root?: string): string {
  const hash = createHash("sha256");
  // Where it runs is part of what was allowed: turning the sandbox off asks again.
  hash.update(`${formatter.name}\0${formatter.command}\0${formatter.args.slice(0, 1).join(" ")}\0${sandbox ? "box" : "host"}\0`);
  for (const file of formatter.configFiles) {
    // Where the file sits matters (relative plugin paths resolve from it), not only its name.
    hash.update(`${root ? relative(root, file) : basename(file)}\0`);
    hash.update(readText(file) ?? "\u0000missing");
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 32);
}

/** Which formatters the project has, for Settings → Editor. */
export function projectFormatters(root: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const names: string[] = [];
  const probe = (file: string) => formatterFor(root, join(root, file), env)?.name;
  for (const file of ["index.ts", "main.go", "main.py", "src/main.rs"]) {
    const name = probe(file);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The environment a formatter gets on this computer: the basics a local MCP server gets, nothing else. */
export function formatterEnvironment(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Record<string, string> {
  const cleared = mcpServerEnvironment(env, {}, [], platform);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && !Object.hasOwn(cleared, key)) out[key] = value;
  }
  return out;
}

export function runFormatter(formatter: Formatter, cwd: string, text: string, timeoutMs = FORMAT_TIMEOUT_MS, env: Record<string, string> = formatterEnvironment()): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(formatter.command, formatter.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ApiError(504, "format_timeout", `${formatter.name} took too long`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 2_000) err += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ApiError(500, "format_failed", `${formatter.name} could not start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = Buffer.concat(out).toString("utf8");
      if (code === 0 && (result.length || !text.length)) resolvePromise(result);
      else reject(new ApiError(422, "format_failed", (err.trim() || `${formatter.name} exited with ${code}`).slice(0, 400)));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(text);
  });
}

/** The project's box when the project uses the sandbox (a box record exists), whatever its state. */
export function projectBox(root: string, env: NodeJS.ProcessEnv = process.env): BoxRecord | null {
  return readRecord(boxHome(env), boxKey(root));
}

/** Runs the formatter in the project's box: the text goes through the box's run folder, never through the project. */
export async function runFormatterInBox(formatter: Formatter, root: string, record: BoxRecord, text: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = FORMAT_TIMEOUT_MS): Promise<string> {
  if (record.state !== "ready" || !record.port || !record.token) {
    throw new ApiError(409, "sandbox_not_running", "The project's sandbox is not running, so the formatter did not run");
  }
  const name = `format-${randomBytes(8).toString("hex")}.in`;
  const hostDir = runDir(boxHome(env), record.key);
  mkdirSync(hostDir, { recursive: true });
  const hostFile = join(hostDir, name);
  writeFileSync(hostFile, text, { mode: 0o600 });
  try {
    const argv = formatter.boxArgv.map((arg) => (arg.startsWith(root + sep) ? mapToBox(arg, record.root, record.croot) : arg));
    const result = await boxExec(
      { host: record.host, port: record.port, token: record.token },
      ["sh", "-c", 'exec "$@" < "$FORMAT_INPUT"', "sh", ...argv],
      { cwd: mapToBox(root, record.root, record.croot), env: { FORMAT_INPUT: `${RUN_DIR}/${name}`, OMNIRUSH_LEDGER_OFF: "1" }, timeoutMs },
    );
    if (result.code === 127) throw new ApiError(422, "format_failed", `${formatter.name} is not installed in the project's sandbox`);
    if (result.code !== 0 || (!result.stdout.length && text.length)) {
      throw new ApiError(422, "format_failed", (result.stderr.trim() || `${formatter.name} exited with ${result.code}`).slice(0, 400));
    }
    return result.stdout;
  } finally {
    rmSync(hostFile, { force: true });
  }
}

/** Trust decisions, per project folder (canonical), in a file next to the server's config. */
export class FormatTrustStore {
  constructor(private file: string) {}

  private read(): Record<string, TrustEntry> {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, TrustEntry>;
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  get(root: string): TrustEntry | null {
    return this.read()[canonicalRoot(root)] ?? null;
  }

  set(root: string, entry: TrustEntry): void {
    const all = this.read();
    all[canonicalRoot(root)] = entry;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    // Renamed over the old file: never a half-written one.
    renameSync(tmp, this.file);
  }
}

export function formatTrustFile(config: ServerConfig): string {
  const base = config.configPath ? dirname(config.configPath) : join(homedir(), ".config", "omnirush");
  return join(base, "format-trust.json");
}

export type FormatOutcome =
  | { formatter: null; text: null }
  | { formatter: string; trust: "ask"; command: string; hash: string; sandbox: boolean }
  | { formatter: string; trust: "denied" }
  | { formatter: string; text: string; sandbox: boolean };

/** One format request: never runs without trust for this project and configuration. */
export async function formatRequest(options: {
  root: string;
  path: string;
  text: string;
  trust: "once" | "always" | "never" | null;
  hash: string | null;
  store: FormatTrustStore;
  /** The project's sandbox switch (BoxService.sandboxOn): on, the formatter runs in its box or not at all. */
  sandboxOn: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<FormatOutcome> {
  const env = options.env ?? process.env;
  const root = options.root;
  const file = resolve(root, options.path);
  if (file === root || !file.startsWith(root + sep)) throw new ApiError(400, "invalid_path", "The file is outside the project");
  const formatter = formatterFor(root, file, env);
  if (!formatter) return { formatter: null, text: null };
  const sandbox = options.sandboxOn;
  const hash = formatterHash(formatter, sandbox, root);
  const stored = options.store.get(root);
  const current = stored && stored.hash === hash ? stored : null;
  if (options.trust) {
    // An answer to a prompt about another configuration (it changed meanwhile) asks again.
    if (options.hash !== hash) return { formatter: formatter.name, trust: "ask", command: formatter.display, hash, sandbox };
    if (options.trust !== "once") options.store.set(root, { decision: options.trust, hash, command: formatter.display, at: (options.now ?? Date.now)() });
    if (options.trust === "never") return { formatter: formatter.name, trust: "denied" };
  } else if (!current) {
    return { formatter: formatter.name, trust: "ask", command: formatter.display, hash, sandbox };
  } else if (current.decision === "never") {
    return { formatter: formatter.name, trust: "denied" };
  }
  let text: string;
  if (sandbox) {
    // On: in the box only. A box that is missing (reset, cleaned up, still downloading) or not running: nothing runs.
    const record = projectBox(root, env);
    if (!record) throw new ApiError(409, "sandbox_not_running", "The project's sandbox is not running, so the formatter did not run");
    text = await runFormatterInBox(formatter, root, record, options.text, env);
  } else {
    text = await runFormatter(formatter, root, options.text, FORMAT_TIMEOUT_MS, formatterEnvironment(env));
  }
  return { formatter: formatter.name, text, sandbox };
}

export function registerEditorFormatRoutes(options: RegisterOptions): void {
  const { routes, config, jsonResponse, readJsonBody, resolveWorkspace, ensureWritable, requireClientScope, sandboxOn } = options;
  const store = new FormatTrustStore(formatTrustFile(config));
  addRoute(routes, "GET", "/workspace/:id/editor/formatters", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({ formatters: projectFormatters(resolve(workspace.path)) });
  });
  addRoute(routes, "POST", "/workspace/:id/editor/format", "client", async (ctx) => {
    // It runs the project's own code (the formatter, its config and plugins): as for saving, a writer's action.
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const path = typeof body.path === "string" ? body.path : "";
    const text = typeof body.text === "string" ? body.text : null;
    if (!path || text === null || text.length > MAX_TEXT) throw new ApiError(400, "invalid_payload", "A path and the text to format are required");
    const trust = body.trust === "once" || body.trust === "always" || body.trust === "never" ? body.trust : null;
    const hash = typeof body.hash === "string" ? body.hash : null;
    // The sandbox decision fails closed: if it cannot be read, the formatter is treated as sandboxed (and needs a box).
    const inBox = await sandboxOn(workspace).catch(() => true);
    return jsonResponse(await formatRequest({ root: resolve(workspace.path), path, text, trust, hash, store, sandboxOn: inBox }));
  });
}
