// Agent assist: self-check after edits, project notes (/init, AGENTS.md),
// code diagnostics (language servers) and fuller compaction summaries.
//
// PARITY: this file is the same in omnirush-cli
// (assets/extensions/omnirush/agent-assist/) and omnirush-gui
// (apps/server/src/agent-assist/); PARITY.sha256 in both
// lists its hash. Plain JavaScript on node built-ins only: the engine loads it
// as is (CLI) or bundled (desktop).
//
// Everything model-facing here is neutral wording; nothing names the app.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- feature switches ---------------------------------------------------------

export const FEATURES = ["selfCheck", "projectNotes", "diagnostics", "compaction"];
const ENV_SWITCH = {
  selfCheck: "OMNIRUSH_SELF_CHECK",
  projectNotes: "OMNIRUSH_PROJECT_NOTES",
  diagnostics: "OMNIRUSH_CODE_DIAGNOSTICS",
  compaction: "OMNIRUSH_SMART_COMPACTION",
};
/** The env the launcher hands the engine: the features that are on, comma separated. */
export const FEATURES_ENV = "OMNIRUSH_AGENT_ASSIST";

function switchValue(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["0", "off", "false", "no"].includes(text)) return false;
  if (["1", "on", "true", "yes"].includes(text)) return true;
  return null;
}

/**
 * Which features are on: an env switch wins (OMNIRUSH_SELF_CHECK=0, ...), then
 * the saved setting (`settings.agentAssist.<feature> === false` turns it off),
 * else on.
 */
export function featureFlags({ env = {}, settings = {} } = {}) {
  const saved = settings && typeof settings === "object" && settings.agentAssist && typeof settings.agentAssist === "object" ? settings.agentAssist : {};
  return Object.fromEntries(FEATURES.map((name) => {
    const forced = switchValue(env[ENV_SWITCH[name]]);
    return [name, forced ?? saved[name] !== false];
  }));
}

export function featuresEnvValue(flags) {
  return FEATURES.filter((name) => flags[name]).join(",");
}

/** The file an app rewrites when its switches change (the desktop app): `{ "features": [...] }`. */
export const FEATURES_FILE_ENV = "OMNIRUSH_AGENT_ASSIST_FILE";

/**
 * The features on: the file named in OMNIRUSH_AGENT_ASSIST_FILE when it can be
 * read, else the list in OMNIRUSH_AGENT_ASSIST, else none.
 */
export function featuresFromEnv(env = {}) {
  let raw = typeof env[FEATURES_ENV] === "string" ? env[FEATURES_ENV] : null;
  const file = typeof env[FEATURES_FILE_ENV] === "string" ? env[FEATURES_FILE_ENV].trim() : "";
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved?.features)) raw = saved.features.filter((item) => typeof item === "string").join(",");
    } catch { /* not written yet: the env's list */ }
  }
  if (raw === null) return Object.fromEntries(FEATURES.map((name) => [name, false]));
  const on = new Set(raw.split(",").map((item) => item.trim()));
  return Object.fromEntries(FEATURES.map((name) => [name, on.has(name)]));
}

// --- code diagnostics (language servers) ---------------------------------------

/** The engine's built-in language servers (its ConfigLSPV1 list). */
export const LSP_BUILTIN_IDS = [
  "deno", "typescript", "vue", "eslint", "oxlint", "biome", "gopls", "ruby-lsp", "ty", "pyright",
  "elixir-ls", "zls", "csharp", "razor", "fsharp", "sourcekit-lsp", "rust", "clangd", "svelte", "astro",
  "jdtls", "kotlin-ls", "yaml-ls", "lua-ls", "php intelephense", "prisma", "dart", "ocaml-lsp", "bash",
  "terraform", "texlab", "dockerfile", "gleam", "clojure-lsp", "nixd", "tinymist", "haskell-language-server", "julials",
];
/**
 * The servers left on: TypeScript/JavaScript, Python, Go and Rust (deno only
 * runs where a deno.json is and deno is installed). The rest stay off: several
 * download hundreds of megabytes (Java, Kotlin, C#) or start a second server
 * for files the four already cover.
 */
export const LSP_ENABLED_IDS = ["typescript", "deno", "pyright", "gopls", "rust"];
/** Heap cap (MB) for the Node-based servers (tsserver, pyright): VS Code's default for tsserver, at most a quarter of this machine's memory. */
export const LSP_HEAP_MB = 3072;
const LSP_HEAP_MIN_MB = 768;

export function lspHeapMb(totalBytes = os.totalmem()) {
  const quarter = Math.floor(totalBytes / 4 / 1024 / 1024);
  return Math.max(LSP_HEAP_MIN_MB, Math.min(LSP_HEAP_MB, quarter || LSP_HEAP_MB));
}

/** The engine config's `lsp` value: every built-in server but the enabled ones turned off. */
export function lspConfig() {
  return Object.fromEntries(LSP_BUILTIN_IDS.filter((id) => !LSP_ENABLED_IDS.includes(id)).map((id) => [id, { disabled: true }]));
}

/**
 * Engine env for the diagnostics: the Node-based servers inherit the engine's
 * env, so NODE_OPTIONS carries their heap cap. The person's own NODE_OPTIONS is
 * kept in OMNIRUSH_USER_NODE_OPTIONS and put back for every shell call and
 * terminal (restoreShellEnv), so their commands run exactly as before.
 */
export function lspEngineEnv(env = {}, { totalBytes } = {}) {
  const heap = lspHeapMb(totalBytes);
  const own = typeof env.NODE_OPTIONS === "string" ? env.NODE_OPTIONS : "";
  const capped = /--max-old-space-size[= ]/.test(own) ? own : `${own} --max-old-space-size=${heap}`.trim();
  return { NODE_OPTIONS: capped, OMNIRUSH_USER_NODE_OPTIONS: own, OMNIRUSH_LSP_HEAP: String(heap) };
}

/** The engine env this plugin adds; shell calls and terminals never see them. */
const OWN_ENV = ["OMNIRUSH_AGENT_ASSIST", "OMNIRUSH_AGENT_ASSIST_DIR", "OMNIRUSH_AGENT_ASSIST_FILE", "OMNIRUSH_USER_NODE_OPTIONS", "OMNIRUSH_LSP_HEAP"];

/**
 * A shell call's or terminal's env (the engine's `shell.env` hook): the
 * person's own NODE_OPTIONS back (empty when they had none), and this
 * plugin's variables blanked.
 */
export function restoreShellEnv(processEnv, output) {
  if (!output || !output.env) return;
  if (typeof processEnv.OMNIRUSH_LSP_HEAP === "string") {
    output.env.NODE_OPTIONS = typeof processEnv.OMNIRUSH_USER_NODE_OPTIONS === "string" ? processEnv.OMNIRUSH_USER_NODE_OPTIONS : "";
  }
  for (const name of OWN_ENV) if (typeof processEnv[name] === "string") output.env[name] = "";
}

const DIAG_BLOCK = /(\n*LSP errors detected in [^\n]*:\n)?<diagnostics file="([^"]*)">\n([\s\S]*?)\n<\/diagnostics>/g;
/** An error about the environment, not the code: a package that is not installed here. */
function environmentNoise(line) {
  const ts = /Cannot find module '([^']+)' or its corresponding type declarations/.exec(line);
  if (ts) return !/^[./]/.test(ts[1]);
  const py = /Import "([^"]+)" could not be resolved/.exec(line);
  if (py) return !py[1].startsWith(".");
  return false;
}

/**
 * A file tool's output with the language servers' "not installed" errors taken
 * out (a package missing on this machine is not a mistake in the edit; in a
 * sandbox the packages are often installed only there). A block left empty is
 * removed with its heading.
 */
export function filterDiagnosticsOutput(text) {
  if (typeof text !== "string" || !text.includes("<diagnostics")) return { text, removed: 0, kept: 0 };
  let removed = 0;
  let kept = 0;
  const out = text.replace(DIAG_BLOCK, (whole, heading, file, body) => {
    const lines = body.split("\n");
    const left = lines.filter((line) => {
      if (/^\.\.\. and \d+ more$/.test(line)) return true;
      if (environmentNoise(line)) { removed += 1; return false; }
      return true;
    });
    const real = left.filter((line) => !/^\.\.\. and \d+ more$/.test(line));
    kept += real.length;
    if (real.length === 0) return "";
    return `${heading ?? ""}<diagnostics file="${file}">\n${left.join("\n")}\n</diagnostics>`;
  });
  return { text: out, removed, kept };
}

/** At most `files` files of at most `per` entries each in a tool's diagnostics metadata (upload size). */
export function capDiagnosticsMetadata(map, { files = 10, per = 20 } = {}) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return map;
  const entries = Object.entries(map).filter(([, list]) => Array.isArray(list) && list.length > 0);
  return Object.fromEntries(entries.slice(0, files).map(([file, list]) => [file, list.slice(0, per)]));
}

// --- project checks -------------------------------------------------------------

function readText(file, limit = 512 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > limit) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function exists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function packageManager(root) {
  if (exists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (exists(path.join(root, "yarn.lock"))) return "yarn";
  if (exists(path.join(root, "bun.lock")) || exists(path.join(root, "bun.lockb"))) return "bun";
  return "npm";
}

function runScript(pm, name) {
  if (name === "test") return pm === "bun" ? "bun run test" : `${pm} test`;
  return pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`;
}

const NO_TEST = /no test specified/i;
const TYPECHECK_SCRIPTS = ["typecheck", "type-check", "check-types", "types", "tsc"];

function makeTargets(root) {
  const text = readText(path.join(root, "Makefile")) ?? readText(path.join(root, "makefile"));
  if (!text) return [];
  const targets = [];
  for (const match of text.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm)) {
    if (!targets.includes(match[1]) && !match[1].startsWith(".")) targets.push(match[1]);
  }
  return targets;
}

function hasPythonTests(root) {
  if (["pytest.ini", "conftest.py", "tox.ini"].some((name) => exists(path.join(root, name)))) return true;
  const pyproject = readText(path.join(root, "pyproject.toml")) ?? "";
  if (/\[tool\.pytest/.test(pyproject)) return true;
  for (const dir of ["tests", "test"]) {
    try {
      if (fs.readdirSync(path.join(root, dir)).some((name) => /^test_.*\.py$|_test\.py$/.test(name))) return true;
    } catch { /* none */ }
  }
  try {
    return fs.readdirSync(root).some((name) => /^test_.*\.py$/.test(name));
  } catch {
    return false;
  }
}

/**
 * The project's checks, cheapest first: [{ kind, command }] with kind
 * typecheck | lint | test. Read from package.json scripts, Python test setup,
 * go.mod, Cargo.toml, else a Makefile's test/check/lint targets. At most three.
 */
export function detectChecks(root, { platform = process.platform } = {}) {
  const checks = [];
  const add = (kind, command) => {
    if (checks.length < 3 && !checks.some((item) => item.command === command)) checks.push({ kind, command });
  };
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg && typeof pkg === "object") {
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const pm = packageManager(root);
    const typecheck = TYPECHECK_SCRIPTS.find((name) => typeof scripts[name] === "string");
    if (typecheck) add("typecheck", runScript(pm, typecheck));
    if (typeof scripts.lint === "string") add("lint", runScript(pm, "lint"));
    if (typeof scripts.test === "string" && !NO_TEST.test(scripts.test)) add("test", runScript(pm, "test"));
  }
  const pyproject = readText(path.join(root, "pyproject.toml")) ?? "";
  // The project's own runner when it has one; else the interpreter by its usual name here.
  const pyRun = exists(path.join(root, "uv.lock")) ? "uv run " : exists(path.join(root, "poetry.lock")) ? "poetry run " : "";
  const python = pyRun ? `${pyRun}python` : platform === "win32" ? "python" : "python3";
  if (/\[tool\.ruff/.test(pyproject)) add("lint", `${pyRun}ruff check .`);
  if (/\[tool\.mypy/.test(pyproject)) add("typecheck", `${pyRun}mypy .`);
  if (hasPythonTests(root)) add("test", `${python} -m pytest -q`);
  if (exists(path.join(root, "go.mod"))) {
    add("lint", "go vet ./...");
    add("test", "go test ./...");
  }
  if (exists(path.join(root, "Cargo.toml"))) add("test", "cargo test");
  if (checks.length === 0) {
    const targets = makeTargets(root);
    for (const target of ["check", "lint", "test"]) if (targets.includes(target)) add(target === "test" ? "test" : "lint", `make ${target}`);
  }
  return checks;
}

const TEST_RUNNERS = /^(?:(?:npx|pnpx|bunx|pnpm exec|yarn exec)\s+)?(?:vitest|jest|mocha|ava|tap|pytest|tsc(?:\s|$)|eslint|ruff|mypy|pyright|biome\s+check|oxlint)\b|^(?:python3?|py)\s+-m\s+(?:pytest|unittest|mypy|ruff)\b|^(?:go\s+(?:test|vet)|cargo\s+(?:test|check|clippy)|make\s+(?:test|check|lint)|node\s+--test|bun\s+test|deno\s+(?:test|check|lint))\b|^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|type-check|check-types|check)(?::[\w:-]+)?\b/;

/** The command's parts that run something (`cd x && npm test | tail` -> ["npm test"]). */
export function commandSegments(command) {
  return String(command || "")
    .split(/&&|\|\||;|\n/)
    .map((part) => part.split("|")[0].trim())
    .map((part) => part.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "").replace(/^(?:timeout\s+\d+[smh]?\s+)/, ""))
    .filter((part) => part && !/^cd\s/.test(part));
}

/** Whether a shell command runs one of the project's checks (or a well-known test runner, linter, type checker). */
export function isCheckCommand(command, checks = []) {
  return commandSegments(command).some((part) =>
    checks.some((check) => part === check.command || part.startsWith(`${check.command} `)) || TEST_RUNNERS.test(part));
}

function count(text, pattern) {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * The counts in a check's output (vitest, jest, node --test, pytest, go test,
 * cargo test, mocha, tsc, eslint) and a one-line summary:
 * "Checked: 42 tests passed" / "Check failed: 2 of 42 tests failed".
 */
export function parseCheckResult(output, exitCode, command = "") {
  const text = String(output || "").replace(/\u001b\[[0-9;]*m/g, "");
  let passed = null;
  let failed = null;
  const vitest = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/.exec(text);
  if (vitest) { failed = Number(vitest[1] ?? 0); passed = Number(vitest[2]); }
  const jest = /Tests:\s+(?:(\d+) failed,\s*)?(?:\d+ skipped,\s*)?(\d+) passed/.exec(text);
  if (passed === null && jest) { failed = Number(jest[1] ?? 0); passed = Number(jest[2]); }
  if (passed === null && /^(?:# |ℹ )pass \d+/m.test(text)) {
    passed = count(text, /^(?:# |ℹ )pass (\d+)/m);
    failed = count(text, /^(?:# |ℹ )fail (\d+)/m) ?? 0;
  }
  if (passed === null) {
    const pytest = /^(?:=+ )?(?:(\d+) failed, )?(\d+) passed\b.* in [\d.]+s|^(?:=+ )?(\d+) failed\b.* in [\d.]+s/m.exec(text);
    if (pytest) { failed = Number(pytest[1] ?? pytest[3] ?? 0); passed = Number(pytest[2] ?? 0); }
  }
  if (passed === null) {
    const cargo = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
    if (cargo.length) { passed = cargo.reduce((sum, m) => sum + Number(m[1]), 0); failed = cargo.reduce((sum, m) => sum + Number(m[2]), 0); }
  }
  if (passed === null) {
    const mocha = /(\d+) passing/.exec(text);
    if (mocha) { passed = Number(mocha[1]); failed = count(text, /(\d+) failing/) ?? 0; }
  }
  if (passed === null && /^(?:ok|FAIL|---)\s/m.test(text) && /\bgo\s+test\b/.test(command)) {
    passed = (text.match(/^ok\s/gm) || []).length;
    failed = (text.match(/^FAIL\s/gm) || []).length;
  }
  const tscErrors = count(text, /Found (\d+) errors?/);
  const eslintProblems = count(text, /✖ (\d+) problems?/);
  // A null exit is a call that timed out or was stopped: never a pass. Without any exit (no metadata) the counts decide.
  const ok = exitCode === 0 || (exitCode === undefined ? (failed === 0 && passed !== null) : false);
  const unit = /\bgo\s+test\b/.test(command) ? "packages" : "tests";
  let summary;
  if (passed !== null) {
    const total = passed + (failed ?? 0);
    summary = ok && !failed ? `Checked: ${passed} ${passed === 1 ? unit.replace(/s$/, "") : unit} passed` : `Check failed: ${failed || "some"} of ${total} ${unit} failed`;
  } else if (tscErrors !== null && !ok) {
    summary = `Check failed: ${tscErrors} type error${tscErrors === 1 ? "" : "s"}`;
  } else if (eslintProblems !== null && !ok) {
    summary = `Check failed: ${eslintProblems} lint problem${eslintProblems === 1 ? "" : "s"}`;
  } else {
    const label = commandSegments(command).find((part) => TEST_RUNNERS.test(part)) || commandSegments(command)[0] || "check";
    summary = ok ? `Checked: ${label} passed` : `Check failed: ${label} exited with ${exitCode ?? "an error"}`;
  }
  return { ok, passed, failed, summary };
}

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit", "patch"]);
const NOT_CODE = /\.(?:md|mdx|txt|rst|adoc|log|csv|png|jpe?g|gif|svg|ico|lock)$/i;

function editedPaths(tool, args) {
  if (!args || typeof args !== "object") return [];
  if (typeof args.filePath === "string") return [args.filePath];
  if (typeof args.path === "string") return [args.path];
  if (typeof args.patchText === "string") {
    return [...args.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
  }
  return [];
}

/** Whether a file tool call changed code (not only notes, docs or images). */
export function isCodeEdit(tool, args) {
  if (!EDIT_TOOLS.has(String(tool || "").toLowerCase())) return false;
  const files = editedPaths(tool, args);
  return files.length === 0 || files.some((file) => !NOT_CODE.test(file));
}

/** Whether the person asked for no checks in this turn ("skip the tests", "don't run tests", "no need to run the checks"). */
export function skipRequested(text) {
  return /\b(?:skip(?:ping)?|don'?t run|do not run|no need to run|no need for|without running|never mind)\s+(?:the\s+|any\s+)?(?:self[- ]?checks?|checks?|tests?|test suite|linters?|linting|type[- ]?checks?)\b/i.test(String(text || ""));
}

/** Whether the person's answer to "apply this AGENTS.md change?" declines it. */
export function declinesChange(text) {
  return /^\s*(?:no\b|nope\b|nah\b|don'?t\b|do not\b|keep\b|leave\b|cancel\b|stop\b)/i.test(String(text || ""));
}

export const SELF_CHECK_ATTEMPTS = 3;

/** Model calls in a row a note is shown without an edit or a check run in between (a stuck turn): after this many it is dropped. */
export const SELF_CHECK_NOTE_REPEATS = 8;

export function newCheckState() {
  return { edits: 0, failures: 0, ran: 0, skip: false, last: null, shown: 0 };
}

/** A code edit: a check is due again. */
export function noteEdit(state) {
  state.edits += 1;
  state.shown = 0;
}

/**
 * The note to add to this model call: `note`, unless it has been shown
 * SELF_CHECK_NOTE_REPEATS calls in a row with no edit or check run since (the
 * model is not making progress; the note would only keep the turn going).
 */
export function admitNote(state, note, { repeats = SELF_CHECK_NOTE_REPEATS } = {}) {
  if (!note) return null;
  state.shown = (state.shown ?? 0) + 1;
  return state.shown <= repeats ? note : null;
}

/** A new prompt from the person: a new turn's budget, and its skip request. */
export function noteUserPrompt(state, text) {
  state.failures = 0;
  state.shown = 0;
  state.skip = skipRequested(text);
}

/**
 * The system note for the next model call while code changed since the last
 * check: run the checks; after a failure, fix and re-run; after the attempts
 * are used up, stop and report. Null when nothing is due.
 */
export function selfCheckNote(state, checks, { attempts = SELF_CHECK_ATTEMPTS } = {}) {
  if (!state || state.skip || checks.length === 0) return null;
  if (state.failures >= attempts) {
    if (state.edits === 0 && state.last && !state.last.ok) {
      return `Self-check: the project's checks failed ${state.failures} times in this turn (last: ${state.last.summary}). Stop retrying. In your reply, say what still fails and why.`;
    }
    return null;
  }
  if (state.edits === 0) {
    if (state.last && !state.last.ok) {
      return `Self-check: the last check failed (attempt ${state.failures} of ${attempts}): ${state.last.summary}. Fix the cause if your change caused it, then run the checks again. If the failure is unrelated to your change, say so in your reply instead.`;
    }
    return null;
  }
  const list = checks.map((check) => `- \`${check.command}\``).join("\n");
  return [
    "Self-check: you changed code in this project since the last check. Before you say the work is done, run the project's checks with the shell tool and fix failures your change caused:",
    list,
    "Give each command a timeout of at most 5 minutes. If a check cannot run here (a missing tool or service) or fails for reasons unrelated to your change, say so in your reply instead of retrying. End your reply with the result in one line, for example \"Checked: 42 tests passed\".",
  ].join("\n");
}

/** A finished shell call that ran a check: the state, and the summary to show. */
export function noteCheckRun(state, result) {
  state.ran += 1;
  state.edits = 0;
  state.shown = 0;
  state.last = result;
  state.failures = result.ok ? 0 : state.failures + 1;
}

// --- project notes (AGENTS.md) -----------------------------------------------------

export const NOTES_FILE = "AGENTS.md";
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".cursor/rules", ".github/copilot-instructions.md", "CONTRIBUTING.md"];

const DEV_COMMAND = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?!install\b|i\b|ci\b|add\b|remove\b|uninstall\b|update\b|init\b|create\b|exec\b|dlx\b|x\b|outdated\b|audit\b|view\b|info\b|ls\b|why\b|link\b|publish\b|version\b|login\b|config\b|cache\b|help\b|--)[\w:.-]+|(?:npx|pnpx|bunx)\s+(?:vitest|jest|tsc|eslint|prettier|playwright|prisma|drizzle-kit|next|vite)\b|(?:python3?|py)\s+-m\s+(?:pytest|unittest|mypy|ruff|black|flask|uvicorn|alembic)\b|(?:pytest|ruff|mypy|black|uvicorn|alembic)\b|go\s+(?:test|build|vet|run|generate)\b|cargo\s+(?:test|build|check|clippy|run|fmt)\b|make\s+[\w.-]+|tsc\b|deno\s+(?:task|test|check|lint|run)\b|docker\s+compose\s+up\b|(?:gradle|\.\/gradlew|mvn)\s+\w+|dotnet\s+(?:test|build|run)\b)/;

function normalizeCommand(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/** A shell call's command shortened to what a project note would show (`cd x && npm test -- --run` -> "npm test -- --run"). */
export function devCommand(command) {
  for (const part of commandSegments(command)) {
    if (DEV_COMMAND.test(part)) return normalizeCommand(part).slice(0, 120);
  }
  return null;
}

function notesText(root) {
  return [readText(path.join(root, NOTES_FILE)) ?? "", readText(path.join(root, "CLAUDE.md")) ?? ""].join("\n");
}

/** Commands that worked in a session and that the project's notes do not mention yet. */
export function learnedCommands(commandsThatWorked, root) {
  const notes = normalizeCommand(notesText(root)).toLowerCase();
  const seen = new Set();
  const out = [];
  for (const raw of commandsThatWorked) {
    const command = devCommand(raw);
    if (!command || seen.has(command)) continue;
    seen.add(command);
    const head = command.split(" ").slice(0, 3).join(" ").toLowerCase();
    if (notes.includes(command.toLowerCase()) || notes.includes(head)) continue;
    out.push(command);
  }
  return out.slice(0, 5);
}

function workflowRuns(root) {
  const dir = path.join(root, ".github", "workflows");
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).slice(0, 6); } catch { return []; }
  const runs = [];
  for (const name of names) {
    const text = readText(path.join(dir, name)) ?? "";
    for (const match of text.matchAll(/^\s*-?\s*run:\s*(?!\|)(.+)$/gm)) {
      const command = normalizeCommand(match[1]).replace(/^["']|["']$/g, "");
      if (command && !runs.some((item) => item.command === command)) runs.push({ file: name, command });
      if (runs.length >= 12) return runs;
    }
  }
  return runs;
}

/**
 * Facts read from the repository for /init: its manifests' commands, checks,
 * CI steps, existing instruction files, commands that worked in this session.
 * Markdown, model-facing, for the agent to verify and write up.
 */
export function projectScan(root, { learned = [] } = {}) {
  const lines = ["Repository facts gathered automatically for this task (verify them; they are a starting point, not the content):"];
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg && typeof pkg === "object") {
    const pm = packageManager(root);
    lines.push(`- Node project (package manager: ${pm}${pkg.workspaces || exists(path.join(root, "pnpm-workspace.yaml")) ? ", workspaces" : ""}).`);
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? Object.entries(pkg.scripts).filter(([, value]) => typeof value === "string") : [];
    for (const [name, value] of scripts.slice(0, 15)) lines.push(`  - \`${runScript(pm, name)}\` runs \`${normalizeCommand(value).slice(0, 100)}\``);
  }
  const pyproject = readText(path.join(root, "pyproject.toml"));
  if (pyproject !== null || exists(path.join(root, "requirements.txt")) || exists(path.join(root, "setup.py"))) {
    const tools = [...new Set([...(pyproject ?? "").matchAll(/^\[tool\.([\w-]+)/gm)].map((m) => m[1]))];
    const manager = exists(path.join(root, "uv.lock")) ? "uv" : exists(path.join(root, "poetry.lock")) ? "poetry" : null;
    lines.push(`- Python project${manager ? ` (${manager})` : ""}${tools.length ? `; tool config: ${tools.slice(0, 8).join(", ")}` : ""}.`);
  }
  const gomod = readText(path.join(root, "go.mod"));
  if (gomod !== null) lines.push(`- Go module ${(/^module\s+(\S+)/m.exec(gomod) || [])[1] ?? ""}`.trimEnd() + ".");
  const cargo = readText(path.join(root, "Cargo.toml"));
  if (cargo !== null) lines.push(`- Rust ${/\[workspace\]/.test(cargo) ? "workspace" : "crate"}.`);
  const targets = makeTargets(root);
  if (targets.length) lines.push(`- Makefile targets: ${targets.slice(0, 15).map((t) => `\`make ${t}\``).join(", ")}.`);
  const checks = detectChecks(root);
  if (checks.length) lines.push(`- Checks to run after changes: ${checks.map((c) => `\`${c.command}\` (${c.kind})`).join(", ")}.`);
  const runs = workflowRuns(root);
  if (runs.length) {
    lines.push("- CI steps:");
    for (const run of runs) lines.push(`  - \`${run.command.slice(0, 120)}\` (${run.file})`);
  }
  const instructions = INSTRUCTION_FILES.filter((name) => exists(path.join(root, name)));
  if (instructions.length) lines.push(`- Existing instruction files: ${instructions.join(", ")}.`);
  if (learned.length) {
    lines.push("- Commands that worked in this session:");
    for (const command of learned) lines.push(`  - \`${command}\``);
  }
  const notes = readText(path.join(root, NOTES_FILE));
  lines.push("");
  if (notes !== null && notes.trim()) {
    lines.push(`${NOTES_FILE} already exists (${notes.split("\n").length} lines). Keep every line already in it. Add new facts as new lines or sections. To change or remove an existing line, first show the person the exact diff and ask; change it only after they agree.`);
  } else {
    lines.push(`${NOTES_FILE} does not exist yet: create it.`);
  }
  return lines.join("\n");
}

function nonBlankLines(text) {
  return String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Lines of `before` (non-blank) that `after` no longer has: the person's lines a change would drop. */
export function droppedLines(before, after) {
  const left = new Map();
  for (const line of nonBlankLines(after)) left.set(line, (left.get(line) ?? 0) + 1);
  const dropped = [];
  for (const line of nonBlankLines(before)) {
    const n = left.get(line) ?? 0;
    if (n > 0) left.set(line, n - 1);
    else dropped.push(line);
  }
  return dropped;
}

function isNotesFile(file, root, platform = process.platform) {
  if (typeof file !== "string" || !file) return false;
  // Case-insensitive file systems (Windows, macOS): agents.md is the same file.
  const fold = platform === "win32" || platform === "darwin" ? (text) => text.toLowerCase() : (text) => text;
  const full = fold(path.resolve(root, file));
  const base = fold(path.resolve(root));
  return path.basename(full).toLowerCase() === NOTES_FILE.toLowerCase() && full.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/**
 * What a file tool call would drop from an existing AGENTS.md: [{ file, lines }]
 * (empty when it only adds). Reads the file as it is now.
 */
export function notesLinesDropped(tool, args, root) {
  const name = String(tool || "").toLowerCase();
  if (!args || typeof args !== "object") return [];
  const out = [];
  const current = (file) => readText(path.resolve(root, file));
  if ((name === "write" || name === "edit" || name === "multiedit") && isNotesFile(args.filePath ?? args.path, root)) {
    const file = args.filePath ?? args.path;
    const before = current(file);
    if (before === null || !before.trim()) return [];
    let after = before;
    if (name === "write") after = typeof args.content === "string" ? args.content : "";
    else {
      const edits = Array.isArray(args.edits) ? args.edits : [args];
      for (const edit of edits) {
        const oldString = typeof edit.oldString === "string" ? edit.oldString : "";
        const newString = typeof edit.newString === "string" ? edit.newString : "";
        if (!oldString) { after = newString; continue; }
        after = edit.replaceAll ? after.split(oldString).join(newString) : after.replace(oldString, () => newString);
      }
    }
    const lines = droppedLines(before, after);
    if (lines.length) out.push({ file, lines });
    return out;
  }
  if ((name === "apply_patch" || name === "patch") && typeof args.patchText === "string") {
    const sections = args.patchText.split(/^(?=\*\*\* (?:Add|Update|Delete) File: )/m);
    for (const section of sections) {
      const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/m.exec(section);
      if (!head || !isNotesFile(head[2].trim(), root)) continue;
      const file = head[2].trim();
      const before = current(file);
      if (before === null || !before.trim()) continue;
      let lines;
      if (head[1] === "Delete") lines = nonBlankLines(before);
      else if (head[1] === "Add") lines = droppedLines(before, section.split("\n").slice(1).filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n"));
      else {
        const removed = section.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
        const added = section.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
        lines = droppedLines(removed.join("\n"), added.join("\n"));
      }
      if (lines.length) out.push({ file, lines });
    }
  }
  return out;
}

/** The model-facing refusal for a change that would drop the person's lines from AGENTS.md. */
export function notesGuardMessage(drops) {
  const total = drops.reduce((sum, d) => sum + d.lines.length, 0);
  const shown = drops.flatMap((d) => d.lines.slice(0, 12).map((line) => `- ${line}`));
  return [
    `Not applied: this change would remove or rewrite ${total} existing line${total === 1 ? "" : "s"} of ${drops.map((d) => d.file).join(", ")}, which the person may have written:`,
    ...shown,
    ...(total > shown.length ? [`... and ${total - shown.length} more`] : []),
    "Show the person this diff and ask whether to apply it; apply it only after they agree. Adding new lines needs no confirmation.",
  ].join("\n");
}

// --- compaction -----------------------------------------------------------------

const PREFERENCE = /^(?:keep|use|avoid|prefer|stick to|leave|never|always|don'?t|do not)\b|\b(?:always|never|please (?:use|keep|avoid|make|don'?t)|prefer|make sure|mustn'?t|must not|shouldn'?t|should not|from now on|instead of|only use|stick to)\b/i;
const DECISION = /\b(?:decided|we(?:'ll| will) (?:use|go with|keep)|going with|let'?s (?:use|go with|keep)|chose|switch(?:ed|ing)? to|the plan is)\b/i;

function sentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 8 && s.length <= 300);
}

function pushUnique(list, value, limit) {
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1);
  list.push(value);
  if (list.length > limit) list.shift();
}

function partsOf(message) {
  return Array.isArray(message?.parts) ? message.parts : [];
}

/**
 * Facts from a whole session (engine messages: { info, parts }) that a
 * compaction summary must carry: the person's preferences and directives,
 * decisions, open to-dos, commands that worked (and ones still failing), the
 * files changed and how.
 */
export function sessionLedger(messages) {
  const ledger = { preferences: [], decisions: [], todos: [], worked: [], failing: [], files: [] };
  const fileState = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.info?.role;
    if (role === "assistant" && message.info.summary) continue;
    for (const part of partsOf(message)) {
      if (part?.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string") {
        for (const sentence of sentences(part.text)) {
          // A question is not a preference ("why should this fail?").
          if (role === "user" && PREFERENCE.test(sentence) && !sentence.endsWith("?")) pushUnique(ledger.preferences, sentence, 12);
          if (DECISION.test(sentence)) pushUnique(ledger.decisions, sentence, 10);
        }
      }
      if (part?.type !== "tool" || !part.state) continue;
      const tool = String(part.tool || "").toLowerCase();
      const input = part.state.input && typeof part.state.input === "object" ? part.state.input : {};
      if (tool === "todowrite" && Array.isArray(input.todos)) {
        ledger.todos = input.todos
          .filter((todo) => todo && typeof todo.content === "string" && !["completed", "cancelled"].includes(todo.status))
          .map((todo) => `${todo.content}${todo.status === "in_progress" ? " (in progress)" : ""}`)
          .slice(0, 15);
      }
      if (part.state.status !== "completed") continue;
      if (tool === "bash" || tool === "shell") {
        const command = devCommand(input.command);
        const exit = part.state.metadata?.exit;
        if (!command) continue;
        if (exit === 0) {
          pushUnique(ledger.worked, command, 15);
          ledger.failing = ledger.failing.filter((item) => !item.startsWith(`${command} `) && item !== command);
        } else if (typeof exit === "number") {
          const note = `${command} (exit ${exit})`;
          ledger.failing = ledger.failing.filter((item) => !item.startsWith(`${command} (`));
          pushUnique(ledger.failing, note, 8);
        }
      }
      if (EDIT_TOOLS.has(tool)) {
        const meta = part.state.metadata ?? {};
        for (const file of editedPaths(tool, input)) {
          const prior = fileState.get(file);
          const created = tool === "write" && meta.exists === false;
          const deleted = tool === "apply_patch" && new RegExp(`^\\*\\*\\* Delete File: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(String(input.patchText || ""));
          const state = deleted ? "deleted" : created && !prior ? "created" : prior === "created" ? "created" : "edited";
          fileState.delete(file);
          fileState.set(file, state);
        }
      }
    }
  }
  ledger.files = [...fileState.entries()].slice(-30).map(([file, state]) => `${file} (${state})`);
  return ledger;
}

const LEDGER_SECTIONS = [
  ["preferences", "User Preferences"],
  ["decisions", "Decisions"],
  ["todos", "Open To-dos"],
  ["worked", "Commands That Worked"],
  ["failing", "Commands Still Failing"],
  ["files", "File State"],
];

export function ledgerEmpty(ledger) {
  return !ledger || LEDGER_SECTIONS.every(([key]) => !Array.isArray(ledger[key]) || ledger[key].length === 0);
}

/**
 * Added to the engine's compaction prompt (after its template): four more
 * sections and the ledger of facts from the whole session, including parts
 * an earlier compaction already folded away.
 */
export function compactionContext(ledger) {
  const lines = [
    "After the template's last section, add these sections in this order, keeping each even when empty (\"(none)\"):",
    "## User Preferences — the person's instructions and preferences, quoted closely",
    "## Decisions — what was decided and why",
    "## Open To-dos — unfinished items",
    "## Commands That Worked — exact commands (build, test, run) known to work here",
    "Keep exact file paths and commands.",
  ];
  if (!ledgerEmpty(ledger)) {
    lines.push("", "<session-facts>", "Facts from the whole session, including parts summarized before. Carry each one into the matching section unless it is finished and no longer needed:");
    for (const [key, title] of LEDGER_SECTIONS) {
      if (!ledger[key]?.length) continue;
      lines.push(`${title}:`);
      for (const item of ledger[key]) lines.push(`- ${item}`);
    }
    lines.push("</session-facts>");
  }
  return lines.join("\n");
}

/**
 * The ledger's facts a summary left out, as a note to keep beside it in the
 * model's context (null when the summary has them all). A fact counts as kept
 * when its distinctive text (its first 40 characters, lowercased) is in the
 * summary.
 */
export function missingFactsNote(ledger, summary) {
  if (ledgerEmpty(ledger)) return null;
  const haystack = String(summary || "").toLowerCase().replace(/\s+/g, " ");
  const lines = [];
  for (const [key, title] of LEDGER_SECTIONS) {
    const missing = (ledger[key] ?? []).filter((item) => {
      const probe = item.replace(/\s+\((?:created|edited|deleted|in progress|exit \d+)\)$/, "").toLowerCase().replace(/\s+/g, " ").slice(0, 40);
      return !haystack.includes(probe);
    });
    if (!missing.length) continue;
    lines.push(`${title}:`);
    for (const item of missing) lines.push(`- ${item}`);
  }
  if (!lines.length) return null;
  return ["<session-facts>", "Facts from earlier in this session that the summary above does not mention:", ...lines, "</session-facts>"].join("\n");
}

/** The message ids and text of the newest finished compaction summary in a message list (engine shape). */
export function latestSummary(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const info = messages[i]?.info;
    if (info?.role === "assistant" && info.summary && !info.error) {
      const text = partsOf(messages[i]).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
      return { index: i, id: info.id, created: info.time?.created ?? 0, text };
    }
  }
  return null;
}

// --- notices ----------------------------------------------------------------------

/** Toast titles the plugin uses; the desktop app shows engine toasts with these titles only. */
export const NOTICE_TITLES = ["Checked", "Check failed", "Not checked", "Project notes"];
