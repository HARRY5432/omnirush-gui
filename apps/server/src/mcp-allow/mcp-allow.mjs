// MCP servers in the managed engine: the server's list of the ones a session
// may use (GET /collect/capabilities `mcp`), applied to the engine's final
// configuration by the engine plugin (createMcpPolicyHooks).
//
// The same file ships in omnirush-cli (src/mcp/) and omnirush-gui
// (apps/server/src/mcp-allow/); PARITY.sha256 lists it in both. No imports
// beyond node: built-ins, so the desktop's plugin bundler and the CLI's
// plain node both load it as is.
//
// A server is allowed only when it is a LOCAL program the app can name:
// launched through npx/bunx/pnpm dlx/yarn dlx/npm exec (npm) or uvx/uv tool
// run (PyPI) with a package on the server's list, at a version in the
// entry's range (an unpinned launch runs the entry's `pin`), and with every
// folder or file it works on inside the project. Remote servers, servers the
// app cannot name (a script path, docker, a bare binary) and everything not on
// the list are left out of the engine; the report says which and why.
//
// Allowed servers are keyed by the entry's id (the engine names their tools
// `<id>_<tool>`), so the same server gets the same tool names whatever the
// user called it. With the project's sandbox on, they run in the sandbox.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MCP_POLICY_FILE_VERSION = 1;

/** Messages people see, by decision code. */
export const MCP_REASONS = {
  disabled: "MCP servers are turned off for this account.",
  remote: "Remote MCP servers are not supported: their answers come from an outside service or account, so the session could not be repeated.",
  unknown_command: "The app cannot tell which MCP server this is. Start it with npx (npm packages) or uvx (Python packages) and the package name.",
  not_allowed: "This MCP server is not on the supported list. Supported servers work only on the project's own files.",
  denied: "This MCP server is not supported.",
  version: "This version of the MCP server is not supported.",
  outside_project: "This MCP server may only use files inside the project folder.",
  missing_flag: "This MCP server needs a setting that points at a file in the project.",
  missing_arg: "This MCP server needs the file it works on, inside the project, as its argument.",
  flag: "This MCP server setting is not supported: it reaches outside the project.",
  duplicate: "Another entry already starts this MCP server.",
  invalid: "This MCP server entry is not valid.",
};

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NPM_RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const DLX_RUNNERS = new Set(["pnpm", "yarn"]);
const PY_RUNNERS = new Set(["uvx"]);
// Flags of the runners that take a value (the next word).
const NPX_VALUE_FLAGS = new Set(["-p", "--package", "--registry", "--cache", "--userconfig", "-c", "--call", "--prefix", "-w", "--workspace"]);
const UVX_VALUE_FLAGS = new Set(["--from", "--with", "--with-requirements", "--python", "-p", "--index", "--index-url", "--extra-index-url", "--default-index", "--directory", "--project", "--cache-dir", "--config-file", "--with-editable"]);
const LOCAL_URL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]+\.localhost)(:\d+)?(\/|$|\?|#)|^(about|data):/i;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value, limit = 64) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.length > 0 && v.length < 300).slice(0, limit) : [];
}

function text(value, limit = 400) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
}

// ------------------------------------------------------------------ versions

/** Numeric parts of a plain dotted version ("2026.8.31", "0.0.83"); null for anything else. */
export function versionParts(value) {
  const match = /^v?(\d+(?:\.\d+){0,3})$/.exec(String(value ?? "").trim());
  return match ? match[1].split(".").map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Whether `version` is in `range`: "*" (or empty) is any version; otherwise
 * space-separated terms that all hold, each `>=x`, `>x`, `<=x`, `<x`, `=x`
 * or a bare `x`. Only plain dotted versions match a range other than "*".
 */
export function versionInRange(version, range) {
  const wanted = String(range ?? "*").trim();
  if (wanted === "" || wanted === "*") return true;
  const have = versionParts(version);
  if (!have) return false;
  return wanted.split(/\s+/).every((term) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(term);
    const want = m ? versionParts(m[2]) : null;
    if (!want) return false;
    const c = compare(have, want);
    switch (m[1] ?? "=") {
      case ">=": return c >= 0;
      case ">": return c > 0;
      case "<=": return c <= 0;
      case "<": return c < 0;
      default: return c === 0;
    }
  });
}

/** Whether `range` is one versionInRange understands. */
export function validRange(range) {
  const wanted = String(range ?? "*").trim();
  if (wanted === "" || wanted === "*") return true;
  return wanted.split(/\s+/).every((term) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(term);
    return Boolean(m && versionParts(m[2]));
  });
}

// -------------------------------------------------------------------- policy

function normalizeRules(value) {
  const rules = isRecord(value) ? value : {};
  const out = {};
  if (rules.path_args === "positional") out.path_args = "positional";
  if (Number.isInteger(rules.min_args) && rules.min_args > 0 && rules.min_args < 9) out.min_args = rules.min_args;
  const defaults = strings(rules.default_args, 8);
  if (defaults.length) out.default_args = defaults;
  for (const key of ["path_flags", "require_flags", "add_flags", "forbid_flags"]) {
    const list = strings(rules[key], 32).filter((f) => f.startsWith("-"));
    if (list.length) out[key] = list;
  }
  if (isRecord(rules.path_env)) {
    const env = Object.fromEntries(Object.entries(rules.path_env)
      .filter(([k, v]) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(k) && typeof v === "string" && v.length < 200 && !path.isAbsolute(v) && !v.split(/[\\/]/).includes(".."))
      .slice(0, 8));
    if (Object.keys(env).length) out.path_env = env;
  }
  if (rules.local_urls === true) out.local_urls = true;
  const inputs = strings(rules.path_inputs, 16).filter((k) => /^[A-Za-z_][\w]{0,63}$/.test(k));
  if (inputs.length) out.path_inputs = inputs;
  return out;
}

function normalizeEntry(value) {
  if (!isRecord(value)) return null;
  const id = text(value.id, 40)?.toLowerCase();
  const runtime = value.runtime === "npm" || value.runtime === "pypi" ? value.runtime : null;
  const pkg = text(value.package, 214);
  if (!id || !ID.test(id) || !runtime || !pkg || !/^(@[\w.-]+\/)?[\w.-]+$/.test(pkg)) return null;
  const pin = text(value.pin, 40);
  if (pin && !versionParts(pin)) return null;
  const versions = text(value.versions, 120) ?? "*";
  if (!validRange(versions)) return null;
  if (pin && !versionInRange(pin, versions)) return null;
  return {
    id,
    runtime,
    package: pkg,
    bins: strings(value.bins, 8),
    versions,
    pin,
    title: text(value.title, 80) ?? id,
    why: text(value.why, 400),
    rules: normalizeRules(value.rules),
  };
}

function normalizeDeny(value) {
  if (typeof value === "string") return text(value, 214) ? { match: value.trim().toLowerCase(), reason: null } : null;
  if (!isRecord(value)) return null;
  const match = text(value.match, 214)?.toLowerCase();
  return match ? { match, reason: text(value.reason, 400) } : null;
}

/**
 * The `mcp` block of a /collect/capabilities answer as the app uses it:
 * `{enabled, allow, deny, message}`; null when absent or unreadable (MCP off).
 */
export function normalizePolicy(block) {
  if (!isRecord(block)) return null;
  const allow = [];
  const seen = new Set();
  for (const raw of Array.isArray(block.allow) ? block.allow.slice(0, 64) : []) {
    const entry = normalizeEntry(raw);
    if (entry && !seen.has(entry.id)) { seen.add(entry.id); allow.push(entry); }
  }
  const deny = (Array.isArray(block.deny) ? block.deny.slice(0, 128) : []).map(normalizeDeny).filter(Boolean);
  return { enabled: block.enabled === true, allow, deny, message: text(block.message, 400) };
}

// -------------------------------------------------------------- the launches

function programName(word) {
  return String(word || "").split(/[\\/]/).pop().toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, "");
}

/** `@scope/name@1.2.3` / `name@1.2.3` / `name==1.2.3` -> {name, version}. */
export function splitSpec(spec, runtime) {
  const raw = String(spec || "");
  if (runtime === "pypi") {
    const eq = /^([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*(?:==|@)\s*([\w.+-]+)$/.exec(raw);
    if (eq) return { name: eq[1].toLowerCase(), version: eq[2] };
    const bare = /^([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?$/.exec(raw);
    return bare ? { name: bare[1].toLowerCase(), version: null } : null;
  }
  const m = /^((?:@[\w.-]+\/)?[\w.-]+)(?:@(.+))?$/.exec(raw);
  if (!m) return null;
  return { name: m[1].toLowerCase(), version: m[2] && m[2] !== "latest" ? m[2] : null };
}

/**
 * What a local launch runs, or null when the app cannot name it:
 * `{runtime, name, version, bin, prefix, rest, specIndex, viaFrom}` where
 * `command[specIndex]` is the package spec (the one rewritten to pin) and
 * `rest` the server's own arguments.
 */
export function parseLaunch(command) {
  const argv = strings(command, 256);
  if (argv.length === 0 || argv.length !== (Array.isArray(command) ? command.length : -1)) return null;
  const prog = programName(argv[0]);
  let i = 1;
  let runtime = null;
  if (NPM_RUNNERS.has(prog)) runtime = "npm";
  else if (DLX_RUNNERS.has(prog) && argv[1] === "dlx") { runtime = "npm"; i = 2; }
  else if (prog === "npm" && (argv[1] === "exec" || argv[1] === "x")) { runtime = "npm"; i = 2; }
  else if (PY_RUNNERS.has(prog)) runtime = "pypi";
  else if (prog === "uv" && argv[1] === "tool" && argv[2] === "run") { runtime = "pypi"; i = 3; }
  if (!runtime) return null;
  const valueFlags = runtime === "npm" ? NPX_VALUE_FLAGS : UVX_VALUE_FLAGS;
  let from = null;
  let fromIndex = -1;
  for (; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === "--") { i += 1; break; }
    if (!word.startsWith("-")) break;
    const [flag, inline] = word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, null];
    const isFrom = runtime === "npm" ? flag === "-p" || flag === "--package" : flag === "--from";
    if (runtime === "npm" && (flag === "-c" || flag === "--call")) return null;
    if (runtime === "pypi" && (flag === "--with" || flag === "--with-requirements" || flag === "--with-editable" || flag.includes("index") || flag === "--directory" || flag === "--project")) return null;
    if (runtime === "npm" && (flag === "--registry" || flag === "--prefix" || flag === "-w" || flag === "--workspace")) return null;
    if (valueFlags.has(flag)) {
      if (inline === null) {
        if (isFrom) { if (from !== null) return null; from = argv[i + 1] ?? null; fromIndex = i + 1; }
        i += 1;
      } else if (isFrom) { if (from !== null) return null; from = inline; fromIndex = -2 - i; }
    }
  }
  if (i >= argv.length) return null;
  const first = argv[i];
  const spec = from ?? first;
  const parsed = splitSpec(spec, runtime);
  if (!parsed) return null;
  return {
    runtime,
    name: parsed.name,
    version: parsed.version,
    bin: from !== null ? programName(splitSpec(first, runtime)?.name ?? first) : null,
    specIndex: from !== null ? fromIndex : i,
    rest: argv.slice(i + 1),
    restIndex: i + 1,
  };
}

/** `command` with the package spec pinned to `version`. */
function pinned(command, launch, version) {
  const out = [...command];
  const spec = launch.runtime === "npm" ? `${launch.name}@${version}` : `${launch.name}==${version}`;
  if (launch.specIndex >= 0) {
    if (launch.runtime === "pypi" && launch.bin === null) out[launch.specIndex] = `${launch.name}@${version}`;
    else out[launch.specIndex] = spec;
  } else {
    const at = -2 - launch.specIndex;
    out[at] = `${out[at].slice(0, out[at].indexOf("="))}=${spec}`;
  }
  return out;
}

// ---------------------------------------------------------------------- paths

function samePlatformPath(p, platform) {
  return platform === "win32" ? p.toLowerCase() : p;
}

/** Whether `p` (relative: to `root`) is `root` or inside it. `~` paths are outside. */
export function insideRoot(root, p, platform = process.platform) {
  const value = String(p ?? "");
  if (!value || value.startsWith("~")) return false;
  const lib = platform === "win32" ? path.win32 : path.posix;
  const base = lib.resolve(root);
  const full = lib.resolve(base, value);
  const rel = lib.relative(samePlatformPath(base, platform), samePlatformPath(full, platform));
  return rel === "" || (!rel.startsWith("..") && !lib.isAbsolute(rel));
}

/** A path inside `root` as the sandbox sees it (`croot`); relative paths stay relative. */
function boxPath(p, root, box, platform) {
  if (!box || !box.croot || box.croot === root) return p;
  const lib = platform === "win32" ? path.win32 : path.posix;
  if (!lib.isAbsolute(p)) return p.split("\\").join("/");
  const rel = lib.relative(lib.resolve(root), lib.resolve(p)).split("\\").join("/");
  return rel ? `${box.croot.replace(/\/+$/, "")}/${rel}` : box.croot;
}

function flagValue(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) return { index: i + 1, value: args[i + 1] ?? null, inline: false };
    if (args[i].startsWith(`${flag}=`)) return { index: i, value: args[i].slice(flag.length + 1), inline: true };
  }
  return null;
}

// ------------------------------------------------------------------ the shell

/** POSIX single-quoting for the sandbox shell. */
export function shellQuote(word) {
  const s = String(word);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// ------------------------------------------------------------------- evaluate

function denyReason(policy, ...keys) {
  for (const rule of policy.deny) {
    for (const key of keys) {
      if (!key) continue;
      const k = String(key).toLowerCase();
      if (k === rule.match || (rule.match.endsWith("*") && k.startsWith(rule.match.slice(0, -1)))) return rule.reason ?? MCP_REASONS.denied;
    }
  }
  return null;
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}

function blocked(name, code, extra = {}) {
  return { name, status: "blocked", code, ...extra, reason: extra.reason ?? MCP_REASONS[code] ?? MCP_REASONS.invalid };
}

/**
 * Apply `policy` to the engine's `mcp` map. `ctx`: `{root, platform, box}`
 * where `box` is `{shell, key, croot}` when the project's sandbox is on.
 * Returns `{mcp, decisions}`: the map the engine gets (allowed servers only,
 * keyed by their ids) and one decision per configured entry.
 */
export function evaluateMcp(mcpMap, policy, ctx = {}) {
  const root = ctx.root || process.cwd();
  const platform = ctx.platform || process.platform;
  const box = ctx.box && typeof ctx.box.shell === "string" && typeof ctx.box.key === "string" ? ctx.box : null;
  const out = {};
  const decisions = [];
  const entries = isRecord(mcpMap) ? Object.entries(mcpMap) : [];
  for (const [name, raw] of entries) {
    if (!isRecord(raw)) { decisions.push(blocked(name, "invalid")); continue; }
    if (!policy || !policy.enabled) { decisions.push(blocked(name, "disabled", policy?.message ? { reason: policy.message } : {})); continue; }
    if (raw.type === "remote" || typeof raw.url === "string") {
      const reason = denyReason(policy, name, hostOf(raw.url));
      decisions.push(blocked(name, "remote", { url_host: hostOf(raw.url), ...(reason ? { reason: `${reason} ${MCP_REASONS.remote}` } : {}) }));
      continue;
    }
    if (raw.type !== undefined && raw.type !== "local") { decisions.push(blocked(name, "invalid")); continue; }
    const command = Array.isArray(raw.command) ? raw.command : null;
    const launch = command ? parseLaunch(command) : null;
    if (!launch) {
      const reason = denyReason(policy, name);
      decisions.push(blocked(name, reason ? "denied" : "unknown_command", reason ? { reason } : {}));
      continue;
    }
    const denied = denyReason(policy, launch.name);
    if (denied) { decisions.push(blocked(name, "denied", { reason: denied, package: launch.name })); continue; }
    const entry = policy.allow.find((e) => e.runtime === launch.runtime && e.package.toLowerCase() === launch.name
      && (launch.bin === null || e.bins.length === 0 || e.bins.includes(launch.bin)));
    if (!entry) { decisions.push(blocked(name, "not_allowed", { package: launch.name })); continue; }
    const base = { id: entry.id, package: entry.package, runtime: entry.runtime, title: entry.title };
    if (Object.hasOwn(out, entry.id)) { decisions.push(blocked(name, "duplicate", base)); continue; }
    let version = launch.version;
    const notes = [];
    if (version === null) {
      if (!entry.pin) { decisions.push(blocked(name, "version", { ...base, reason: `${MCP_REASONS.version} Name a version (for example ${launch.name}@1.2.3).` })); continue; }
      version = entry.pin;
      notes.push(`runs version ${version}`);
    } else if (!versionInRange(version, entry.versions)) {
      decisions.push(blocked(name, "version", { ...base, version, reason: `${MCP_REASONS.version} Supported: ${entry.versions}${entry.pin ? ` (leave the version out to run ${entry.pin})` : ""}.` }));
      continue;
    }
    let argv = launch.version === null ? pinned(command, launch, version) : [...command];
    const restAt = launch.restIndex;
    let rest = argv.slice(restAt);
    const rules = entry.rules;
    const environment = isRecord(raw.environment) ? Object.fromEntries(Object.entries(raw.environment).filter(([, v]) => typeof v === "string")) : {};
    let refusal = null;
    for (const flag of rules.forbid_flags ?? []) {
      if (flagValue(rest, flag)) { refusal = blocked(name, "flag", { ...base, version, reason: `${MCP_REASONS.flag} (${flag})` }); break; }
    }
    if (!refusal) for (const flag of rules.require_flags ?? []) {
      const found = flagValue(rest, flag);
      if (!found || !found.value) { refusal = blocked(name, "missing_flag", { ...base, version, reason: `${MCP_REASONS.missing_flag} (${flag} <file in the project>)` }); break; }
    }
    const cwd = typeof raw.cwd === "string" ? raw.cwd : null;
    if (!refusal && cwd && !insideRoot(root, cwd, platform)) refusal = blocked(name, "outside_project", { ...base, version, reason: `${MCP_REASONS.outside_project} (cwd ${cwd})` });
    const lib = platform === "win32" ? path.win32 : path.posix;
    const workRoot = cwd ? lib.resolve(root, cwd) : root;
    const inside = (p) => !String(p).startsWith("~") && insideRoot(root, lib.resolve(workRoot, String(p)), platform);
    if (!refusal && rules.path_args === "positional") {
      const positional = rest.map((a, k) => [a, k]).filter(([a]) => !a.startsWith("-"));
      if (positional.length === 0 && rules.default_args) {
        rest = [...rest, ...rules.default_args];
        notes.push(`opens ${rules.default_args.join(" ")}`);
      }
      for (const [a] of rest.map((a, k) => [a, k]).filter(([a]) => !a.startsWith("-"))) {
        if (!inside(a)) { refusal = blocked(name, "outside_project", { ...base, version, reason: `${MCP_REASONS.outside_project} (${a})` }); break; }
      }
      if (!refusal && rules.min_args && rest.filter((a) => !a.startsWith("-")).length < rules.min_args) {
        refusal = blocked(name, "missing_arg", { ...base, version });
      }
      if (!refusal) rest = rest.map((a) => (a.startsWith("-") ? a : boxPath(a, root, box, platform)));
    }
    if (!refusal) for (const flag of rules.path_flags ?? []) {
      const found = flagValue(rest, flag);
      if (!found || found.value === null) continue;
      if (!inside(found.value)) { refusal = blocked(name, "outside_project", { ...base, version, reason: `${MCP_REASONS.outside_project} (${flag} ${found.value})` }); break; }
      const mapped = boxPath(found.value, root, box, platform);
      rest = [...rest];
      if (found.inline) rest[found.index] = `${flag}=${mapped}`; else rest[found.index] = mapped;
    }
    if (!refusal) for (const [key, fallback] of Object.entries(rules.path_env ?? {})) {
      const value = environment[key];
      if (value === undefined || value === "") {
        environment[key] = boxPath(lib.join(lib.resolve(root), fallback), root, box, platform);
        notes.push(`keeps its data in ${fallback.split("\\").join("/")}`);
      } else if (!inside(value)) {
        refusal = blocked(name, "outside_project", { ...base, version, reason: `${MCP_REASONS.outside_project} (${key})` });
        break;
      } else {
        environment[key] = boxPath(value, root, box, platform);
      }
    }
    if (refusal) { decisions.push(refusal); continue; }
    for (const flag of rules.add_flags ?? []) {
      if (!flagValue(rest, flag)) { rest = [...rest, flag]; notes.push(`adds ${flag}`); }
    }
    argv = [...argv.slice(0, restAt), ...rest];
    const next = { ...raw, type: "local" };
    if (box) {
      const envWords = Object.entries(environment).map(([k, v]) => `${k}=${shellQuote(v)}`);
      next.command = [box.shell, "-c", `exec ${envWords.length ? `env ${envWords.join(" ")} ` : ""}${argv.map(shellQuote).join(" ")}`];
      next.environment = { OMNIRUSH_BOX_KEY: box.key };
      notes.push("runs in the sandbox");
    } else {
      next.command = argv;
      if (Object.keys(environment).length) next.environment = environment; else delete next.environment;
    }
    out[entry.id] = next;
    decisions.push({ name, status: "allowed", code: "allowed", ...base, version, sandbox: Boolean(box), enabled: raw.enabled !== false, ...(name !== entry.id ? { renamed_to: entry.id } : {}), notes });
  }
  return { mcp: out, decisions };
}

// ----------------------------------------------------------------- the tools

function urlsIn(args, depth = 0) {
  if (depth > 3) return [];
  if (typeof args === "string") return /^[a-z][a-z0-9+.-]*:/i.test(args) || /^[\w.-]+\.[a-z]{2,}(?:[:/]|$)/i.test(args) ? [args] : [];
  if (Array.isArray(args)) return args.flatMap((v) => urlsIn(v, depth + 1));
  if (!isRecord(args)) return [];
  return Object.entries(args).flatMap(([k, v]) => (/url|uri|href|page|address/i.test(k) ? urlsIn(v, depth + 1) : isRecord(v) || Array.isArray(v) ? urlsIn(v, depth + 1) : []));
}

/** The engine's id of a server's tools: `<sanitized name>_`. */
export function toolPrefix(name) {
  return `${String(name).replace(/[^a-zA-Z0-9_-]/g, "_")}_`;
}

/**
 * Why the engine must not run `tool` with `args`, or null: a `local_urls`
 * server opens pages on this machine only; a `path_inputs` server's tool
 * arguments of those names must be inside the project (`state.roots`: the
 * project folder, and where the sandbox sees it). (Entries left out never
 * reach the engine, so their tools do not exist.)
 */
export function toolRefusal(state, tool, args) {
  const id = String(tool || "");
  for (const entry of state.localOnly ?? []) {
    if (!id.startsWith(toolPrefix(entry))) continue;
    const away = urlsIn(args).find((u) => !LOCAL_URL.test(u.trim()));
    if (away) return `${entry} opens pages on this machine only (localhost) in this app, so the session can be repeated: ${away.slice(0, 200)}`;
  }
  for (const { id: entry, keys } of state.pathInputs ?? []) {
    if (!id.startsWith(toolPrefix(entry)) || !isRecord(args)) continue;
    for (const key of keys) {
      const value = args[key];
      if (value === undefined || value === null || value === "") continue;
      const roots = state.roots ?? [];
      const ok = typeof value === "string" && !value.startsWith("~")
        && roots.some((r) => insideRoot(r.root, (r.platform === "win32" ? path.win32 : path.posix).resolve(r.root, value), r.platform));
      if (!ok) return `${entry} may only use files inside the project folder in this app (${key}: ${String(value).slice(0, 200)}).`;
    }
  }
  return null;
}

// --------------------------------------------------------- the plugin's hooks

/** The policy the app wrote for the engine (`{v, policy, at}`); null: MCP off. */
export function readPolicyFile(file) {
  if (!file) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && value.v === MCP_POLICY_FILE_VERSION ? normalizePolicy(value.policy) : null;
  } catch {
    return null;
  }
}

/** Write the policy file the engine plugin reads (atomic). */
export function writePolicyFile(file, block, now = Date.now()) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: MCP_POLICY_FILE_VERSION, policy: isRecord(block) ? block : null, at: now }), { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** Where the plugin writes a project's report under `dir`. */
export function reportPath(dir, root) {
  return path.join(dir, `${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24)}.json`);
}

/** A project's last report (`{v, root, at, decisions}`), or null. */
export function readReport(dir, root) {
  try {
    const value = JSON.parse(readFileSync(reportPath(dir, root), "utf8"));
    return value && value.v === MCP_POLICY_FILE_VERSION && Array.isArray(value.decisions) ? value : null;
  } catch {
    return null;
  }
}

/** One line per decision, for a terminal or a notice. */
export function describeDecision(d) {
  if (d.status === "allowed") {
    // The version is in the line already; the other notes say what the app changed.
    const notes = (d.notes ?? []).filter((n) => !n.startsWith("runs version "));
    return `MCP ${d.id}${d.renamed_to && d.name !== d.id ? ` (${d.name})` : ""}: ${d.enabled === false ? "turned off" : "on"}${d.version ? `, ${d.package}@${d.version}` : ""}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  }
  return `MCP ${d.name}: blocked. ${d.reason}`;
}

function configTarget(input, output) {
  if (isRecord(output) && (Object.hasOwn(output, "mcp") || !isRecord(input))) return output;
  return isRecord(input) ? input : isRecord(output) ? output : null;
}

/**
 * The engine plugin's hooks. `options`: `{directory, policyFile, reportDir,
 * box (null or a function of the root returning {shell, key, croot} or
 * null), platform, now}`. The `config` hook replaces `mcp` with the allowed
 * servers (none without a readable policy); `tool.execute.before` refuses
 * non-local pages for `local_urls` servers and paths outside the project
 * for `path_inputs` servers.
 */
export function createMcpPolicyHooks(options = {}) {
  const root = path.resolve(options.directory || process.cwd());
  const state = { localOnly: [], pathInputs: [], roots: [] };
  const apply = (input, output) => {
    const target = configTarget(input, output);
    if (!target) return;
    const policy = readPolicyFile(options.policyFile);
    const box = typeof options.box === "function" ? options.box(root) : options.box ?? null;
    const { mcp, decisions } = evaluateMcp(target.mcp, policy, { root, platform: options.platform, box });
    target.mcp = mcp;
    const on = policy ? policy.allow.filter((e) => Object.hasOwn(mcp, e.id)) : [];
    state.localOnly = on.filter((e) => e.rules.local_urls).map((e) => e.id);
    state.pathInputs = on.filter((e) => e.rules.path_inputs).map((e) => ({ id: e.id, keys: e.rules.path_inputs }));
    const platform = options.platform || process.platform;
    state.roots = [{ root, platform }, ...(box && box.croot && box.croot !== root ? [{ root: box.croot, platform: "linux" }] : [])];
    if (options.reportDir) {
      try {
        const file = reportPath(options.reportDir, root);
        mkdirSync(options.reportDir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ v: MCP_POLICY_FILE_VERSION, root, at: (options.now ?? Date.now)(), enabled: Boolean(policy?.enabled), decisions }), { mode: 0o600 });
        renameSync(tmp, file);
      } catch { /* the report is for display only */ }
    }
  };
  return {
    config: async (input, output) => { apply(input, output); },
    "tool.execute.before": async (input, output) => {
      const why = toolRefusal(state, input?.tool, output?.args ?? input?.args);
      if (why) throw new Error(why);
    },
  };
}
