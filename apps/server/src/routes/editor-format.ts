/**
 * The desktop editor's "Format on save": the project's own formatter, run as the user on the editor's text (stdin
 * in, stdout out; nothing is written here). Only formatters the project sets up itself are used, never a built-in
 * one: Prettier when the project depends on it and has it installed (run with Node from PATH), gofmt, Ruff or Black
 * when pyproject.toml configures them, rustfmt for Cargo projects. A user action only: not an agent tool.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { ApiError } from "../errors.js";
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

export type Formatter = { name: string; command: string; args: string[] };

type RegisterOptions = {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
};

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
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
  if (PRETTIER_EXTENSIONS.has(ext)) {
    const dir = prettierRoot(root, file);
    const script = dir ? prettierScript(dir, root) : null;
    const node = findOnPath("node", env);
    if (script && node) return { name: "Prettier", command: node, args: [script, "--stdin-filepath", rel] };
    return null;
  }
  if (ext === ".go") {
    const gofmt = findOnPath("gofmt", env);
    return gofmt ? { name: "gofmt", command: gofmt, args: [] } : null;
  }
  if (ext === ".py" || ext === ".pyi") {
    const pyproject = readText(join(root, "pyproject.toml")) ?? "";
    const ruff = /\[tool\.ruff/.test(pyproject) || /["']ruff[>=<~\s"']/.test(pyproject) ? findOnPath("ruff", env) : null;
    if (ruff) return { name: "Ruff", command: ruff, args: ["format", "--stdin-filename", rel, "-"] };
    const black = /\[tool\.black/.test(pyproject) ? findOnPath("black", env) : null;
    if (black) return { name: "Black", command: black, args: ["-q", "--stdin-filename", rel, "-"] };
    return null;
  }
  if (ext === ".rs") {
    const cargo = readText(join(root, "Cargo.toml"));
    const rustfmt = cargo !== null ? findOnPath("rustfmt", env) : null;
    if (!rustfmt) return null;
    const edition = /edition\s*=\s*"(\d{4})"/.exec(cargo ?? "")?.[1] ?? "2021";
    return { name: "rustfmt", command: rustfmt, args: ["--emit", "stdout", "--edition", edition] };
  }
  return null;
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

export function runFormatter(formatter: Formatter, cwd: string, text: string, timeoutMs = FORMAT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(formatter.command, formatter.args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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

export function registerEditorFormatRoutes(options: RegisterOptions): void {
  const { routes, config, jsonResponse, readJsonBody, resolveWorkspace, ensureWritable, requireClientScope } = options;
  addRoute(routes, "GET", "/workspace/:id/editor/formatters", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({ formatters: projectFormatters(resolve(workspace.path)) });
  });
  addRoute(routes, "POST", "/workspace/:id/editor/format", "client", async (ctx) => {
    // It runs the project's own code (the formatter, its config and plugins): as for saving, a writer's action.
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const root = resolve(workspace.path);
    const body = await readJsonBody(ctx.request);
    const path = typeof body.path === "string" ? body.path : "";
    const text = typeof body.text === "string" ? body.text : null;
    if (!path || text === null || text.length > MAX_TEXT) throw new ApiError(400, "invalid_payload", "A path and the text to format are required");
    const file = resolve(root, path);
    if (file !== root && !file.startsWith(root + sep)) throw new ApiError(400, "invalid_path", "The file is outside the project");
    const formatter = formatterFor(root, file);
    if (!formatter) return jsonResponse({ formatter: null, text: null });
    return jsonResponse({ formatter: formatter.name, text: await runFormatter(formatter, root, text) });
  });
}
