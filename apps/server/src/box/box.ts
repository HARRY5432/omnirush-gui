// Ported from the CLI (omnirush-cli src/box/box.js, feat/local-box); keep the
// two in step. Desktop differences, each marked "Desktop:": types; the
// helpers' folder is the desktop's sidecars (setToolsRoot) and there is no
// checkout box/bin fallback beyond OMNIRUSH_BOX_BIN_DIR; the shell link lives
// in <home>/shell-desktop (the CLI's own is <home>/shell); a container-name
// prefix override for test rigs (OMNIRUSH_BOX_CONTAINER_PREFIX).
//
// OmniRush box: one persistent Linux container per project, opt-in. The
// engine, the app and the model calls stay on this machine; the engine's
// shell tool runs in the box (boxsh -> boxd). The project folder is
// bind-mounted at the same path (Windows: /c/Users/...), so the user's
// editor, git and files stay as they are, and chat history stays in the
// engine's one store. Installs live in the container, which survives
// resume, restarts and new sessions until the user resets it.
//
// Each turn's starting environment is a checkpoint of what the container
// changed (`docker diff` against the image, then only what changed since
// the session's previous checkpoint), written where the project archive
// picks it up (<state>/sandbox/snapshots/<session>/turn-N.{json,tar}, the
// same transport the 2.2.3 sandbox used; record schema 2).

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as client from "./client.js";
import type { BoxEndpoint, BoxStat } from "./client.js";
import { detectStack, imageFor, type BoxImage, type ImagePins } from "./images.js";
import { runCommand, type RunCommand, type RunOptions, type RuntimeInfo } from "./runtime.js";

type Env = NodeJS.ProcessEnv;
export type BoxLog = (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;

export const RECORD_SCHEMA = 2;
export const LABEL = "ai.omnirush.box";
export const BOX_PORT = 7777;
export const RUN_DIR = "/run/omnirush";
export const SHIMS_DIR = "/opt/omnirush/pkglog";
export const HOME_IN_BOX = "/root";
/** One snapshot tar past this is cut (system paths first, then dependency folders). */
export const TAR_MAX_BYTES = 256 * 1024 * 1024;
/** A single file past this is left out of a snapshot (listed with its size). */
export const FILE_MAX_BYTES = 128 * 1024 * 1024;
/** Project dependency folders (node_modules, .venv) go into a turn's snapshot up to this. */
export const DEPS_MAX_BYTES = 128 * 1024 * 1024;

// --- where things are ------------------------------------------------------

export function boxHome(env: Env = process.env, home = os.homedir()): string {
  return path.resolve(String(env.OMNIRUSH_BOX_HOME || "").trim() || path.join(home, ".omnirush", "box"));
}

/** The canonical form of a project folder (the box key hashes it). */
export function canonicalRoot(root: string, { platform = process.platform, realpath = realpathSync.native }: { platform?: NodeJS.Platform; realpath?: (file: string) => string } = {}): string {
  let resolved = path.resolve(root);
  try { resolved = realpath(resolved); } catch { /* keep */ }
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function boxKey(root: string, opts: { platform?: NodeJS.Platform; realpath?: (file: string) => string } = {}): string {
  return createHash("sha256").update(canonicalRoot(root, opts)).digest("hex").slice(0, 12);
}

/** Desktop: OMNIRUSH_BOX_CONTAINER_PREFIX renames the containers (test rigs on shared machines). */
export function containerName(key: string, env: Env = process.env): string {
  const prefix = String(env.OMNIRUSH_BOX_CONTAINER_PREFIX || "").trim();
  return `${/^[a-z0-9][a-z0-9_.-]*$/.test(prefix) ? prefix : "omnirush-box-"}${key}`;
}

/** Where the project folder is inside: the same path; on Windows C:\x\y -> /c/x/y. */
export function containerRoot(root: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return root;
  const match = /^([a-zA-Z]):[\\/]?(.*)$/.exec(root);
  if (!match) return `/w/${root.replace(/[\\]+/g, "/").replace(/^\/+/, "")}`;
  return `/${match[1]!.toLowerCase()}/${match[2]!.replace(/[\\]+/g, "/")}`.replace(/\/+$/, "") || "/";
}

/** Where the server saves each chat's turn checkpoints (the project archive carries them: session-archive/index.ts). */
export function boxSnapshotsDir(stateDir: string): string {
  return path.join(stateDir, "sandbox", "snapshots");
}

export function recordFile(home: string, key: string): string {
  return path.join(home, "boxes", `${key}.json`);
}

export function runDir(home: string, key: string): string {
  return path.join(home, "projects", key);
}

function writeJson(file: string, value: unknown, mode = 0o600): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tmp, file);
}

function readJson<T = Record<string, unknown>>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** The record boxsh reads (boxes/<key>.json). */
export type BoxRecord = {
  v: 1; key: string; root: string; croot: string; container: string; runtime: string; runtime_args: string[];
  host: string; port: number; token: string; state: string; error: string; uid: number; gid: number;
  home: string; shell: string; path_prefix: string; env_file: string; updated: number; pid: number;
};

export function readRecord(home: string, key: string): BoxRecord | null {
  return readJson<BoxRecord>(recordFile(home, key));
}

// --- helper binaries ---------------------------------------------------------

export const GOOS: Partial<Record<string, string>> = { linux: "linux", darwin: "darwin", win32: "windows" };
export const GOARCH: Partial<Record<string, string>> = { x64: "amd64", arm64: "arm64", amd64: "amd64", aarch64: "arm64" };

/**
 * Folders holding the helpers, best first: OMNIRUSH_BOX_BIN_DIR, then the
 * desktop's sidecars folder's box/ (setToolsRoot). Each has
 * <goos>-<goarch>/boxsh and linux-<arch>/boxd.
 */
export function helperDirs({ env = process.env, toolsRoot = null }: { env?: Env; toolsRoot?: string | null } = {}): string[] {
  const asked = String(env.OMNIRUSH_BOX_BIN_DIR || "").trim();
  return [...(asked ? [asked] : []), ...(toolsRoot ? [path.join(toolsRoot, "box")] : [])];
}

// Desktop: the sidecars folder (the engine binary's folder), set by the server at start.
let platformTools: string | null = null;
export function setToolsRoot(dir: string | null | undefined): void {
  platformTools = dir || null;
}

/** The helper's file, or null when no folder has it (the box is then unavailable). */
export function helperPath(name: string, { goos, goarch, env = process.env, toolsRoot = platformTools }: { goos: string | undefined; goarch: string | undefined; env?: Env; toolsRoot?: string | null }): string | null {
  if (!goos || !goarch) return null;
  const ext = goos === "windows" && name === "boxsh" ? ".exe" : "";
  const rel = path.join(`${goos}-${goarch}`, name + ext);
  return helperDirs({ env, toolsRoot }).map((dir) => path.join(dir, rel)).find((file) => existsSync(file)) ?? null;
}

/**
 * The shell file the engine is given: a link (Windows: a copy) named `bash`
 * to boxsh, so the engine describes its shell tool as bash.
 */
export function installShell(home: string, { platform = process.platform, arch = process.arch, env = process.env }: { platform?: NodeJS.Platform; arch?: string; env?: Env } = {}): string {
  const source = helperPath("boxsh", { goos: GOOS[platform], goarch: GOARCH[arch], env });
  if (!source) throw new Error(`the sandbox shell helper is missing (${GOOS[platform] ?? platform}-${GOARCH[arch] ?? arch}/boxsh)`);
  const dir = path.join(home, "shell-desktop");
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, platform === "win32" ? "bash.exe" : "bash");
  if (platform === "win32") {
    let same = false;
    try { same = statSync(target).size === statSync(source).size && statSync(target).mtimeMs >= statSync(source).mtimeMs; } catch { /* missing */ }
    if (!same) {
      const tmp = `${target}.${process.pid}.tmp`;
      copyFileSync(source, tmp);
      try { renameSync(tmp, target); } catch { rmSync(tmp, { force: true }); }
    }
    return target;
  }
  let current: string | null = null;
  try { current = lstatSync(target).isSymbolicLink() ? path.resolve(dir, readlinkSync(target)) : null; } catch { /* missing */ }
  if (current !== source) {
    const tmp = `${target}.${process.pid}.tmp`;
    rmSync(tmp, { force: true });
    symlinkSync(source, tmp);
    renameSync(tmp, target);
  }
  return target;
}

/**
 * A tar with one executable file at `name` (and its folders), for `cp - <c>:/`:
 * `cp <file> <c>:<path>` needs the folder to exist in the image already.
 */
export function singleFileTar(name: string, data: Buffer, mode = 0o755): Buffer {
  const blocks: Buffer[] = [];
  const header = (entry: string, type: string, size: number, entryMode: number) => {
    const h = Buffer.alloc(512);
    h.write(entry, 0, 100, "utf8");
    h.write(`${entryMode.toString(8).padStart(7, "0")}\0`, 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
    h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return h;
  };
  const parts = name.split("/");
  for (let i = 1; i < parts.length; i += 1) blocks.push(header(`${parts.slice(0, i).join("/")}/`, "5", 0, 0o755));
  blocks.push(header(name, "0", data.length, mode));
  blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// --- the runtime CLI ------------------------------------------------------------

export type BoxRuntime = Pick<RuntimeInfo, "name" | "bin"> & Partial<Pick<RuntimeInfo, "version" | "flavor" | "rootless" | "arch" | "vm" | "prefix" | "wsl">>;

/** Runs the runtime's CLI (`wsl.exe -e docker ...` for a WSL engine). */
export function rt(runtime: BoxRuntime, run: RunCommand = runCommand) {
  const prefix = Array.isArray(runtime.prefix) ? runtime.prefix : [];
  return (args: string[], opts: RunOptions = {}) => run(runtime.bin, [...prefix, ...args], { timeoutMs: 60_000, ...opts });
}

/** A Windows path as a WSL engine mounts it: C:\x\y -> /mnt/c/x/y. */
export function wslPath(p: string): string {
  const match = /^([a-zA-Z]):[\\/]?(.*)$/.exec(String(p));
  if (!match) return String(p).replace(/\\/g, "/");
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, "/")}`.replace(/\/+$/, "");
}

/** Where the runtime finds a folder of this machine (a WSL engine sees Windows drives under /mnt). */
function source(runtime: BoxRuntime, p: string): string {
  return runtime.wsl ? wslPath(p) : p;
}

/** Whether `image` is present locally; its id and repo digest when it is. */
export async function inspectImage(runtime: BoxRuntime, image: string, { run = runCommand }: { run?: RunCommand } = {}): Promise<{ id: string; digest: string | null; arch: string; size: number } | null> {
  const res = await rt(runtime, run)(["image", "inspect", image, "--format", "{{json .}}"], { timeoutMs: 20_000 });
  if (res.code !== 0) return null;
  try {
    const info = JSON.parse(res.stdout.trim().split("\n")[0] ?? "");
    const digests: unknown[] = Array.isArray(info.RepoDigests) ? info.RepoDigests : [];
    const digest = digests.map((entry) => String(entry).split("@")[1]).find((d) => /^sha256:[0-9a-f]{64}$/.test(d || "")) || null;
    return { id: String(info.Id || ""), digest, arch: String(info.Architecture || ""), size: Number(info.Size || 0) };
  } catch {
    return null;
  }
}

/** `pull` with retries (a flaky link picks up where it stopped). */
export async function pullImage(runtime: BoxRuntime, image: string, { run = runCommand, pauses = [2_000, 8_000], timeoutMs = 60 * 60_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) }: { run?: RunCommand; pauses?: number[]; timeoutMs?: number; sleep?: (ms: number) => Promise<unknown> } = {}): Promise<{ ok: true; attempts: number } | { ok: false; error: string }> {
  let last = null;
  for (let attempt = 0; attempt <= pauses.length; attempt += 1) {
    last = await rt(runtime, run)(["pull", image], { timeoutMs });
    if (last.code === 0) return { ok: true, attempts: attempt + 1 };
    if (attempt < pauses.length) await sleep(pauses[attempt]!);
  }
  const said = String(last?.stderr || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || `pull exited with ${last?.code}`;
  return { ok: false, error: said.slice(0, 300) };
}

type ContainerInfo = { id: string; running: boolean; image: string; labels: Record<string, string>; env: string[]; mounts: string[] };

async function inspectContainer(runtime: BoxRuntime, name: string, run: RunCommand): Promise<ContainerInfo | null> {
  const res = await rt(runtime, run)(["container", "inspect", name, "--format", "{{json .}}"], { timeoutMs: 20_000 });
  if (res.code !== 0) return null;
  try {
    const info = JSON.parse(res.stdout.trim().split("\n")[0] ?? "");
    return {
      id: String(info.Id || ""),
      running: Boolean(info.State?.Running),
      image: String(info.Image || ""),
      labels: info.Config?.Labels ?? {},
      env: Array.isArray(info.Config?.Env) ? info.Config.Env : [],
      mounts: Array.isArray(info.Mounts) ? info.Mounts.map((mount: { Destination?: unknown }) => String(mount.Destination ?? "")) : [],
    };
  } catch {
    return null;
  }
}

/** The host port boxd is published on. */
async function publishedPort(runtime: BoxRuntime, name: string, run: RunCommand): Promise<number | null> {
  const res = await rt(runtime, run)(["port", name, `${BOX_PORT}/tcp`], { timeoutMs: 15_000 });
  if (res.code !== 0) return null;
  for (const line of res.stdout.split("\n")) {
    const match = /:(\d+)\s*$/.exec(line.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

/** Resource limits a new box gets (a VM runtime has its own; only the process cap then). */
export function resourceArgs({ runtime, env = process.env, cpus = os.cpus().length, memory = os.totalmem() }: { runtime: BoxRuntime; env?: Env; cpus?: number; memory?: number }): string[] {
  const args = ["--pids-limit", String(Number(env.OMNIRUSH_BOX_PIDS) || 4096)];
  const askedCpus = Number(env.OMNIRUSH_BOX_CPUS);
  const askedMem = String(env.OMNIRUSH_BOX_MEMORY || "").trim();
  if (askedCpus > 0) args.push("--cpus", String(askedCpus));
  else if (!runtime.vm) args.push("--cpus", String(Math.max(1, Math.min(8, cpus - 1))));
  if (askedMem) args.push("--memory", askedMem);
  else if (!runtime.vm) {
    const gib = Math.max(2, Math.min(8, Math.floor(memory / 2 / 1024 ** 3)));
    args.push("--memory", `${gib}g`);
  }
  return args;
}

/** Who commands run as: root where root maps to the user (rootless, VMs), else the user's own uid. */
export function commandUser(runtime: BoxRuntime, { platform = process.platform, uid = process.getuid?.(), gid = process.getgid?.() }: { platform?: NodeJS.Platform; uid?: number; gid?: number } = {}): { uid: number; gid: number } {
  if (platform !== "linux" || runtime.rootless || runtime.vm || uid === undefined || gid === undefined || uid === 0) return { uid: 0, gid: 0 };
  return { uid, gid };
}

/**
 * Create a box container (not started): the project folder at `croot`, the
 * launcher's run folder at /run/omnirush, the package-manager wrappers (when
 * there are) read-only, boxd published on this machine's loopback only.
 * Nothing else of this machine goes in: no home folder, no credentials, no
 * docker socket.
 */
/** The install log (phase 1): its folder, the wrappers' folder and the pip hook's, all on this machine. */
export type BoxInstallLog = { root: string; bin: string; py: string };

export function createArgs({ name, key, root, croot, image, runtime, run: runFolder, shims, pkglog = null, token, user, env = process.env, platform = process.platform }: { name: string; key: string; root: string; croot: string; image: string; runtime: BoxRuntime; run: string; shims: string | null; pkglog?: BoxInstallLog | null; token: string; user: { uid: number; gid: number }; env?: Env; platform?: NodeJS.Platform }): string[] {
  return [
    "create", "--name", name, "--hostname", "omnirush-box", "--init",
    "--label", `${LABEL}=1`, "--label", `${LABEL}.key=${key}`, "--label", `${LABEL}.root=${root}`, "--label", `${LABEL}.version=1`,
    "--mount", `type=bind,source=${source(runtime, root)},target=${croot}`,
    "--mount", `type=bind,source=${source(runtime, runFolder)},target=${RUN_DIR}`,
    ...(shims ? ["--mount", `type=bind,source=${source(runtime, shims)},target=${SHIMS_DIR}-src,readonly`] : []),
    // The install log's folder (phase 1: its wrappers, pip hook and the per-run folders the
    // wrappers note calls in), at the path the launcher reads it at.
    ...(pkglog ? ["--mount", `type=bind,source=${source(runtime, pkglog.root)},target=${containerRoot(pkglog.root, platform)}`] : []),
    "-p", `127.0.0.1::${BOX_PORT}`,
    "-e", `BOXD_TOKEN=${token}`, "-e", `BOXD_UID=${user.uid}`, "-e", `BOXD_GID=${user.gid}`,
    "-e", `BOXD_HOME=${HOME_IN_BOX}`, "-e", `BOXD_ROOT=${croot}`, "-e", `BOXD_ENV_FILE=${RUN_DIR}/env`,
    "-e", "LANG=C.UTF-8", "-e", "DEBIAN_FRONTEND=noninteractive",
    "-w", croot,
    ...resourceArgs({ runtime, env }),
    ...(runtime.name === "podman" ? ["--security-opt", "label=disable"] : []),
    ...(user.uid === 0 ? ["--security-opt", "no-new-privileges"] : []),
    "--entrypoint", "/opt/omnirush/bin/boxd",
    image,
  ];
}

// --- snapshot rules -------------------------------------------------------------

const H = HOME_IN_BOX;
/** Never part of a turn's environment: runtime state, logs, download caches the ledger replays. */
export const NOISE_PREFIXES = [
  "/run", "/proc", "/sys", "/dev", "/var/log", "/var/cache/apt", "/var/lib/apt/lists", "/var/cache/debconf/templates.dat-old",
  "/opt/omnirush", "/usr/sbin/docker-init", "/sbin/docker-init", "/var/lib/dpkg/lock", "/var/lib/dpkg/lock-frontend", "/var/cache/ldconfig/aux-cache",
  `${H}/.cache/pip`, `${H}/.cache/uv`, `${H}/.cache/pre-commit`, `${H}/.cache/yarn`, `${H}/.cache/go-build`, `${H}/.cache/pnpm`,
  `${H}/.npm/_cacache`, `${H}/.npm/_logs`, `${H}/.npm/_update-notifier-last-checked`, `${H}/.npm/_npx`,
  `${H}/.bun/install/cache`, `${H}/.yarn/berry/cache`, `${H}/.local/share/pnpm/store`, `${H}/.cargo/registry/cache`, "/usr/local/cargo/registry/cache",
  `${H}/go/pkg/mod/cache/download`, `${H}/.cache/go-build`, `${H}/.m2/repository/.cache`, `${H}/.gem/cache`, `${H}/.local/share/gem/cache`,
  `${H}/.gradle/caches`, `${H}/.gradle/daemon`, `${H}/.gradle/native`, `${H}/.bash_history`, `${H}/.python_history`,
  `${H}/.node_repl_history`, `${H}/.lesshst`, `${H}/.wget-hsts`, `${H}/.sudo_as_admin_successful`,
];
/**
 * Kept although they are under a cache folder: rebuilt turns need them
 * (bake-off 2026-10-11: pnpm via corepack and Playwright browsers break otherwise).
 */
export const KEEP_PREFIXES = [`${H}/.cache/node/corepack`, `${H}/.cache/ms-playwright`];
export const NOISE_PATTERNS = [/(?:^|\/)__pycache__(?:\/|$)/, /\.py[co]$/, /(?:^|\/)\.(?:pytest|mypy|ruff)_cache(?:\/|$)/, /^\/tmp\/\.bun-[^/]+\.(?:node|so)$/, /^\/tmp\/\.X11-unix/];
export const NOISE_FILES = new Set(["/etc/passwd", "/etc/group", "/etc/shadow", "/etc/gshadow", "/etc/passwd-", "/etc/group-", "/etc/.pwd.lock", "/etc/hostname", "/etc/hosts", "/etc/resolv.conf", "/etc/mtab", "/etc/sudoers.d/omnirush", "/etc/sudoers.d"]);
const CREDENTIAL_NAMES = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".netrc", ".git-credentials", ".pypirc", ".password-store", ".vault-token", ".docker"]);
const CREDENTIAL_SUBPATHS = [".config/gh", ".config/gcloud", ".config/hub", ".config/op", ".config/rclone", ".config/doctl"];
const CREDENTIAL_FILE = /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx|kdbx|jks|keystore))$/i;
/** Project dependency folders whose contents a turn's snapshot carries (capped). */
export const DEPENDENCY_DIRS = new Set(["node_modules", ".venv", "venv"]);

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** Package trees: their .pem/.key files are package data (certifi's cacert.pem), never a user's key. */
const PACKAGE_SEGMENT = /(?:^|\/)(?:site-packages|dist-packages|node_modules|gems|pkg\/mod|\.rustup|\.cargo|\.m2|\.gradle|\.npm|\.cache|\.local\/lib|\.local\/share|go|\.bun|\.pyenv|\.nvm|\.venv|venv)(?:\/|$)/;

/** A credential under a home folder (the box's own, or a user's). */
export function credentialPath(entry: string): boolean {
  const home = /^(?:\/root|\/home\/[^/]+)\/(.*)$/.exec(entry);
  if (!home) return false;
  const rel = home[1]!;
  const first = rel.split("/")[0]!;
  if (CREDENTIAL_NAMES.has(first)) return true;
  if (CREDENTIAL_SUBPATHS.some((prefix) => within(rel, prefix))) return true;
  return CREDENTIAL_FILE.test(rel) && !PACKAGE_SEGMENT.test(path.posix.dirname(rel));
}

export type DiffEntry = { kind: string; path: string };

export function parseDiff(stdout: string): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const line of String(stdout).split("\n")) {
    const match = /^([ACD]) (\/.*)$/.exec(line);
    if (match) out.push({ kind: match[1]!, path: match[2]! });
  }
  return out;
}

function ancestors(entry: string): string[] {
  const out: string[] = [];
  let current = path.posix.dirname(entry);
  while (current !== "/" && current !== ".") {
    out.push(current);
    current = path.posix.dirname(current);
  }
  return out;
}

/** What of `docker diff` is the environment: no noise, nothing in a mount, no credentials. */
export function filterChanges(entries: DiffEntry[], { mounts = [] }: { mounts?: string[] } = {}): DiffEntry[] {
  const dropped = new Set<string>();
  const kept: DiffEntry[] = [];
  for (const entry of entries) {
    const p = entry.path;
    const keep = KEEP_PREFIXES.some((prefix) => within(p, prefix));
    const noise = !keep && (NOISE_FILES.has(p)
      || NOISE_PREFIXES.some((prefix) => within(p, prefix))
      || NOISE_PATTERNS.some((pattern) => pattern.test(p))
      || credentialPath(p))
      || mounts.some((target) => within(p, target) || within(target, p));
    if (noise) dropped.add(p);
    else kept.push(entry);
  }
  // A folder listed only because of what was dropped below it is no change.
  // Deepest first, so `C /var` goes once `C /var/lib/apt` has gone.
  const keptBelow = new Map<string, number>();
  for (const { path: p } of kept) for (const parent of ancestors(p)) keptBelow.set(parent, (keptBelow.get(parent) ?? 0) + 1);
  const droppedBelow = new Set<string>();
  for (const p of dropped) for (const parent of ancestors(p)) droppedBelow.add(parent);
  const gone = new Set<string>();
  const deepestFirst = kept.filter(({ kind }) => kind === "C").sort((a, b) => b.path.split("/").length - a.path.split("/").length);
  for (const { path: p } of deepestFirst) {
    if (!droppedBelow.has(p) || keptBelow.get(p)) continue;
    gone.add(p);
    for (const parent of ancestors(p)) {
      keptBelow.set(parent, (keptBelow.get(parent) ?? 1) - 1);
      droppedBelow.add(parent);
    }
  }
  return kept.filter(({ path: p }) => !gone.has(p));
}

function signature(entry: BoxStat): string {
  if (entry.type === "dir") return `d|${entry.mode}|${entry.uid}:${entry.gid}`;
  if (entry.type === "symlink") return `l|${entry.link}|${entry.uid}:${entry.gid}`;
  return `${entry.type}|${entry.mode}|${entry.size}|${entry.mtime_ns}|${entry.ctime_ns}|${entry.uid}:${entry.gid}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
}

/** Topmost paths only (a removed folder covers what was under it). */
function topmost(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort();
  const out: string[] = [];
  for (const p of sorted) if (!out.some((top) => within(p, top))) out.push(p);
  return out;
}

/** Dependency folders of the project (top level, and one or two levels down). */
export function dependencyFolders(root: string, { maxDepth = 2 }: { maxDepth?: number } = {}): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (DEPENDENCY_DIRS.has(entry.name)) { out.push(full); continue; }
      if (depth < maxDepth && !entry.name.startsWith(".") && entry.name !== "dist" && entry.name !== "build" && entry.name !== "target") visit(full, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

// --- the box ---------------------------------------------------------------------

export type BoxState = "starting" | "pulling" | "ready" | "failed";
type OnState = (state: BoxState, error: string | null) => void;

/**
 * Open (create or start) the project's box. Returns a Box. `onState` sees
 * "starting", "pulling", "ready", "failed" (the record boxsh reads says the
 * same). Throws only for programming errors; a box that cannot start is a
 * Box with state "failed" and `error`.
 */
export async function openBox({ root, runtime, env = process.env, platform = process.platform, home = boxHome(env), run = runCommand, log = () => {}, shims = null, pkglog = null, pull = true, image: asked = null, onState = () => {} }: { root: string; runtime: BoxRuntime; env?: Env; platform?: NodeJS.Platform; home?: string; run?: RunCommand; log?: BoxLog; shims?: string | null; pkglog?: BoxInstallLog | null; pull?: boolean; image?: BoxImage | null; onState?: OnState }): Promise<Box> {
  const projectRoot = path.resolve(root);
  const key = boxKey(projectRoot, { platform });
  const name = containerName(key, env);
  const croot = containerRoot(projectRoot, platform);
  const runFolder = runDir(home, key);
  mkdirSync(path.join(runFolder, "state"), { recursive: true });
  const box = new Box({ key, name, root: projectRoot, croot, runtime, home, runFolder, run, log, platform, env });
  const lock = await acquireLock(home, key);
  try {
    box.setState("starting", null, onState);
    let info = await inspectContainer(runtime, name, run);
    if (info && info.labels?.[`${LABEL}.root`] && info.labels[`${LABEL}.root`] !== projectRoot) {
      throw new Error(`container ${name} belongs to another folder`);
    }
    if (!info) {
      const chosen = asked ?? imageFor(detectStack(projectRoot), { env });
      let present = await inspectImage(runtime, chosen.pull, { run });
      if (!present) {
        if (!pull) return box.fail("the sandbox image is not downloaded yet", onState);
        box.setState("pulling", null, onState);
        const pulled = await pullImage(runtime, chosen.pull, { run });
        if (!pulled.ok) return box.fail(`could not download the sandbox image: ${pulled.error}`, onState);
        present = await inspectImage(runtime, chosen.pull, { run });
        if (!present) return box.fail("the sandbox image is not there after the download", onState);
      }
      const goarch = GOARCH[present.arch] || GOARCH[runtime.arch ?? ""] || "amd64";
      const boxd = helperPath("boxd", { goos: "linux", goarch, env });
      if (!boxd) return box.fail(`the sandbox helper is missing (linux-${goarch}/boxd)`, onState);
      const token = randomBytes(24).toString("hex");
      const user = commandUser(runtime, { platform });
      const created = await rt(runtime, run)(createArgs({ name, key, root: projectRoot, croot, image: chosen.pull, runtime, run: runFolder, shims, pkglog, token, user, env, platform }), { timeoutMs: 120_000 });
      if (created.code !== 0) return box.fail(`could not create the sandbox: ${firstLine(created.stderr)}`, onState);
      const copied = await rt(runtime, run)(["cp", "-", `${name}:/`], { timeoutMs: 60_000, input: singleFileTar("opt/omnirush/bin/boxd", readFileSync(boxd)) });
      if (copied.code !== 0) {
        await rt(runtime, run)(["rm", "-f", name], { timeoutMs: 30_000 });
        return box.fail(`could not copy the sandbox helper in: ${firstLine(copied.stderr)}`, onState);
      }
      writeJson(path.join(home, "chains", key, "image.json"), { ref: chosen.ref, pull: chosen.pull, digest: chosen.digest || present.digest, id: present.id, stack: chosen.stack, created_at: new Date().toISOString() });
      info = await inspectContainer(runtime, name, run);
      if (!info) return box.fail("the sandbox was not there after it was created", onState);
      log("info", "box created", { key, image: chosen.pull, stack: chosen.stack });
    }
    if (!info.running) {
      const started = await rt(runtime, run)(["start", name], { timeoutMs: 60_000 });
      if (started.code !== 0) return box.fail(`could not start the sandbox: ${firstLine(started.stderr)}`, onState);
    }
    const token = (info.env.find((kv) => kv.startsWith("BOXD_TOKEN=")) || "").slice("BOXD_TOKEN=".length);
    const uid = Number((info.env.find((kv) => kv.startsWith("BOXD_UID=")) || "BOXD_UID=0").slice(9));
    const gid = Number((info.env.find((kv) => kv.startsWith("BOXD_GID=")) || "BOXD_GID=0").slice(9));
    const port = await publishedPort(runtime, name, run);
    if (!port || !token) return box.fail("the sandbox started without its port", onState);
    box.connect({ port, token, uid, gid, containerId: info.id, imageId: info.image });
    const endpoint = box.endpoint!;
    const deadline = Date.now() + 15_000;
    let identity = null;
    while (!identity && Date.now() < deadline) {
      identity = await client.ping(endpoint, { timeoutMs: 1_000 });
      if (!identity) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!identity) return box.fail("the sandbox helper did not answer", onState);
    box.identity = identity;
    if (shims) await box.installShims().catch((error) => log("warn", "box wrappers not installed", { error: String(error?.message || error) }));
    else if (pkglog) {
      if (info.mounts.includes(containerRoot(pkglog.root, platform))) box.useInstallLog(pkglog);
      else log("info", "box made before the install log: its wrappers are not in this box (Reset sandbox adds them)", { key });
    }
    box.setState("ready", null, onState);
    return box;
  } catch (error) {
    return box.fail(error instanceof Error ? error.message : String(error), onState);
  } finally {
    lock.release();
  }
}

function firstLine(text: unknown): string {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 300) ?? "";
}

async function acquireLock(home: string, key: string, { waitMs = 60_000 }: { waitMs?: number } = {}): Promise<{ release: () => void }> {
  const file = path.join(home, "locks", `${key}.lock`);
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return { release: () => { try { unlinkSync(file); } catch { /* gone */ } } };
    } catch {
      let stale = false;
      try {
        const pid = Number(readFileSync(file, "utf8"));
        stale = !pid || Date.now() - statSync(file).mtimeMs > 120_000 || !alive(pid);
      } catch { stale = true; }
      if (stale) { try { unlinkSync(file); } catch { /* raced */ } continue; }
      if (Date.now() > deadline) return { release: () => {} };
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"; }
}

export type CheckpointSummary = {
  schema: number;
  label: string;
  turn: number | null;
  tar: string | null;
  bytes: number;
  sha256: string | null;
  full: boolean;
  leaf?: true;
  delta: { parent: string | null; changed: string[]; removed: string[] };
  checkpoint: Record<string, unknown>;
  skipped: Array<{ path: string; size: number; reason: string }>;
  deps?: Record<string, unknown>;
  stats: { source: string; diff_entries: number; kept: number; copied: number; removed: number; diff_ms: number; stat_ms: number; tar_ms: number; total_ms: number; warning?: string };
};

export type Checkpoint = {
  summary: CheckpointSummary;
  commit: (to?: string) => CheckpointSummary;
  discard: () => void;
};

type Chain = { container: string; last: string | null; signatures: Record<string, string> };

export type BoxLabel = {
  kind: string;
  box_id: string;
  runtime: { name: string; flavor: string; version: string | null; rootless: boolean };
  image: { ref: string | null; digest: string | null; stack: string | null };
  host_os: string;
  host_arch: string;
};

type BoxInit = { key: string; name: string; root: string; croot: string; runtime: BoxRuntime; home: string; runFolder: string; run: RunCommand; log: BoxLog; platform: NodeJS.Platform; env: Env };

export class Box {
  readonly key: string;
  readonly name: string;
  readonly root: string;
  readonly croot: string;
  readonly runtime: BoxRuntime;
  readonly home: string;
  readonly runFolder: string;
  readonly run: RunCommand;
  readonly log: BoxLog;
  readonly platform: NodeJS.Platform;
  readonly env: Env;
  readonly container: string;
  state: BoxState = "starting";
  error: string | null = null;
  endpoint: BoxEndpoint | null = null;
  identity: Record<string, unknown> | null = null;
  pathPrefix = "";
  uid: number | undefined;
  gid: number | undefined;
  containerId: string | undefined;
  imageId: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor({ key, name, root, croot, runtime, home, runFolder, run, log, platform, env }: BoxInit) {
    this.key = key;
    this.name = name;
    this.root = root;
    this.croot = croot;
    this.runtime = runtime;
    this.home = home;
    this.runFolder = runFolder;
    this.run = run;
    this.log = log;
    this.platform = platform;
    this.env = env;
    this.container = name;
  }

  connect({ port, token, uid, gid, containerId, imageId }: { port: number; token: string; uid: number; gid: number; containerId: string; imageId: string }): void {
    this.endpoint = { host: "127.0.0.1", port, token };
    this.uid = uid;
    this.gid = gid;
    this.containerId = containerId;
    this.imageId = imageId;
  }

  /** The record boxsh reads (boxes/<key>.json). */
  writeRecord(): void {
    const record: BoxRecord = {
      v: 1, key: this.key, root: this.root, croot: this.croot, container: this.name, runtime: this.runtime?.bin ?? "", runtime_args: this.runtime?.prefix ?? [],
      host: this.endpoint?.host ?? "127.0.0.1", port: this.endpoint?.port ?? 0, token: this.endpoint?.token ?? "",
      state: this.state, error: this.error ?? "", uid: this.uid ?? 0, gid: this.gid ?? 0, home: HOME_IN_BOX, shell: "/bin/bash",
      path_prefix: this.pathPrefix, env_file: `${RUN_DIR}/env`, updated: Date.now(), pid: process.pid,
    };
    writeJson(recordFile(this.home, this.key), record);
  }

  setState(state: BoxState, error: string | null, onState: OnState = () => {}): void {
    this.state = state;
    this.error = error;
    this.writeRecord();
    onState(state, error);
  }

  fail(error: string, onState?: OnState): Box {
    this.setState("failed", error, onState);
    this.log("warn", "box failed", { key: this.key, error });
    return this;
  }

  get ready(): boolean {
    return this.state === "ready";
  }

  /** The image the container runs (pin, digest, stack) as recorded at creation. */
  image(): { ref: string | null; digest: string | null; id: string | null; stack: string | null; created_at?: string } {
    return readJson(path.join(this.home, "chains", this.key, "image.json")) ?? { ref: null, digest: null, id: this.imageId ?? null, stack: null };
  }

  /** The package-manager wrappers, installed inside (their install.sh), and the env they need. */
  async installShims(): Promise<void> {
    const res = await client.exec(this.endpoint!, ["/bin/sh", `${SHIMS_DIR}-src/install.sh`, SHIMS_DIR, `${RUN_DIR}/ledger.jsonl`, `${RUN_DIR}/state`], { timeoutMs: 30_000, root: true });
    if (res.code !== 0) throw new Error(firstLine(res.stderr) || `install.sh exited ${res.code}`);
    const lines: string[] = [];
    for (const raw of res.stdout.split("\n")) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(raw.trim());
      if (!match) continue;
      const [, name, value] = match;
      // `dir:$PATH`, `dir${PYTHONPATH:+:$PYTHONPATH}`: our part only (boxd adds PATH itself).
      const own = value!.replace(/\$\{[A-Z_]+:\+[^}]*\}/g, "").replace(/:?\$[A-Z_]+$/, "").replace(/ \$\{NODE_OPTIONS[^}]*\}$/, "");
      if (name === "PATH") this.pathPrefix = own;
      else lines.push(`${name}=${own}`);
    }
    // boxd puts BOXD_PATH_PREFIX in front of the image's own PATH.
    if (this.pathPrefix) lines.push(`BOXD_PATH_PREFIX=${this.pathPrefix}`);
    writeFileSync(path.join(this.runFolder, "env"), `${lines.join("\n")}\n`, { mode: 0o644 });
    this.writeRecord();
  }

  /**
   * The install log's wrappers (phase 1) in front of the box's PATH and its
   * pip hook on PYTHONPATH; the per-run folder they note calls in comes with
   * each call (OMNIRUSH_PKGLOG_DIR, forwarded by boxsh).
   */
  useInstallLog(pkglog: BoxInstallLog): void {
    const inBox = (p: string) => containerRoot(p, this.platform);
    this.pathPrefix = inBox(pkglog.bin);
    const lines = [`BOXD_PATH_PREFIX=${this.pathPrefix}`, `PYTHONPATH=${inBox(pkglog.py)}`];
    writeFileSync(path.join(this.runFolder, "env"), `${lines.join("\n")}\n`, { mode: 0o644 });
    this.writeRecord();
  }

  /** The prompt number the package-manager wrappers write into their lines. */
  setTurn(turn: number): void {
    try { writeFileSync(path.join(this.runFolder, "state", "turn"), `${turn}\n`); } catch { /* best effort */ }
  }

  /** Where the wrappers' lines land on this machine. */
  get ledgerPath(): string {
    return path.join(this.runFolder, "ledger.jsonl");
  }

  /** The record a session's snapshots folder starts with (record.json; environment.sandbox in uploads). */
  describe() {
    const image = this.image();
    return {
      schema: RECORD_SCHEMA,
      kind: "omnirush-box",
      box: { id: `box_${this.key}`, container: this.name, created_at: image.created_at ?? null },
      runtime: { name: this.runtime.name, version: this.runtime.version ?? null, flavor: this.runtime.flavor ?? "unknown", rootless: Boolean(this.runtime.rootless), os: "linux", arch: this.runtime.arch || null },
      image: { ref: image.ref ?? null, digest: image.digest ?? null, id: image.id ?? this.imageId ?? null, stack: image.stack ?? null },
      host: { os: this.platform, arch: process.arch, os_version: os.release() },
      project: { host_root: this.root, container_root: this.croot },
      user: { uid: this.uid ?? 0, gid: this.gid ?? 0, home: HOME_IN_BOX },
      environment: { HOME: HOME_IN_BOX, shims: this.pathPrefix ? SHIMS_DIR : null },
      excluded: { prefixes: NOISE_PREFIXES, keep: KEEP_PREFIXES, patterns: NOISE_PATTERNS.map(String), dependency_dirs: [...DEPENDENCY_DIRS] },
    };
  }

  /** The block trace envelopes carry as environment.sandbox. */
  label(): BoxLabel {
    const d = this.describe();
    return { kind: d.kind, box_id: d.box.id, runtime: { name: d.runtime.name, flavor: d.runtime.flavor, version: d.runtime.version, rootless: d.runtime.rootless }, image: { ref: d.image.ref, digest: d.image.digest, stack: d.image.stack }, host_os: d.host.os, host_arch: d.host.arch };
  }

  /** Run a command in the box (toolchain probes, status). */
  exec(argv: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<client.ExecResult> {
    return client.exec(this.endpoint!, argv, opts);
  }

  /**
   * The checkpoint of turn `turn` for a session: what the box changed since
   * the session's previous committed checkpoint in `dir` (all of it for the
   * first). It is staged: `commit()` places it in `dir` and makes it the
   * parent of the next one (`leaf`: placed, never a parent: `final`);
   * `discard()` drops it (a turn that never came). Checkpoints are taken one
   * at a time. Resolves { summary, commit, discard }.
   */
  checkpoint(dir: string, turn: number | null, opts: { label?: string | null; leaf?: boolean; deps?: boolean; tarMax?: number; depsMax?: number } = {}): Promise<Checkpoint> {
    const work = this.queue.then(() => this.takeCheckpoint(dir, turn, opts));
    this.queue = work.catch(() => undefined);
    return work;
  }

  private async takeCheckpoint(dir: string, turn: number | null, { label: asked = null, leaf = false, deps = this.env.OMNIRUSH_BOX_DEPS !== "off", tarMax = Number(this.env.OMNIRUSH_BOX_TAR_MAX) || TAR_MAX_BYTES, depsMax = Number(this.env.OMNIRUSH_BOX_DEPS_MAX) || DEPS_MAX_BYTES }: { label?: string | null; leaf?: boolean; deps?: boolean; tarMax?: number; depsMax?: number } = {}): Promise<Checkpoint> {
    if (!this.ready || !this.endpoint) throw new Error(`the sandbox is ${this.state}`);
    const endpoint = this.endpoint;
    const t0 = Date.now();
    mkdirSync(dir, { recursive: true });
    const chainFile = path.join(dir, ".chain.json");
    let chain = readJson<Chain>(chainFile);
    const full = !chain || chain.container !== this.containerId;
    if (!chain || full) chain = { container: this.containerId ?? "", last: null, signatures: {} };

    // What the box changed against its image: boxd's walk (fast, any runtime), else `diff`
    // (overlay2's naive diff walks the whole image on most Linux kernels: ~1 s for 1 GB).
    const mounts = [this.croot, RUN_DIR, `${SHIMS_DIR}-src`];
    const walked = await client.changes(endpoint, NOISE_PREFIXES, KEEP_PREFIXES);
    let entries: DiffEntry[];
    let stats: BoxStat[];
    let source = "boxd";
    if (walked) {
      entries = filterChanges(walked.map((entry) => ({ kind: entry.kind, path: entry.path })), { mounts });
      const keptPaths = new Set(entries.map((entry) => entry.path));
      stats = walked.filter((entry) => entry.kind !== "D" && keptPaths.has(entry.path));
    } else {
      source = "diff";
      const diff = await rt(this.runtime, this.run)(["diff", this.name], { timeoutMs: 120_000, maxBytes: 256 << 20 });
      if (diff.code !== 0) throw new Error(`diff failed: ${firstLine(diff.stderr)}`);
      entries = filterChanges(parseDiff(diff.stdout), { mounts });
      const present = entries.filter((entry) => entry.kind !== "D").map((entry) => entry.path);
      stats = present.length ? await client.stat(endpoint, present) : [];
    }
    const tDiff = Date.now();
    // Project dependency folders, walked inside (they are in the bind mount, which `diff` never lists).
    let depStats: BoxStat[] = [];
    let depsInfo: { folders: number; entries: number; truncated: boolean } | null = null;
    if (deps) {
      const folders = dependencyFolders(this.root).map((folder) => path.posix.join(this.croot, path.relative(this.root, folder).split(path.sep).join("/")));
      if (folders.length) {
        const walkedDeps = await client.walk(endpoint, folders);
        depStats = (walkedDeps.entries ?? []).filter((entry) => !NOISE_PATTERNS.some((pattern) => pattern.test(entry.path)) && !/\/node_modules\/\.cache(\/|$)/.test(entry.path));
        depsInfo = { folders: folders.length, entries: depStats.length, truncated: Boolean(walkedDeps.truncated) };
      }
    }
    const tStat = Date.now();
    const now: Record<string, string> = {};
    const sized = new Map<string, BoxStat>();
    for (const entry of [...stats, ...depStats]) {
      if (entry.type === "missing" || entry.type === "other") continue;
      now[entry.path] = signature(entry);
      sized.set(entry.path, entry);
    }
    const before = chain.signatures ?? {};
    const isDep = (p: string) => p.startsWith(`${this.croot}/`);
    // In the parent but not changed now: really gone (removed), or back at
    // the image's state, which the rebuild only has if this layer carries it.
    const left = Object.keys(before).filter((p) => !(p in now));
    const gone: string[] = [];
    if (left.length) {
      for (const entry of await client.stat(endpoint, left)) {
        if (entry.type === "missing") gone.push(entry.path);
        else if (entry.type !== "other") {
          now[entry.path] = signature(entry);
          sized.set(entry.path, entry);
        }
      }
    }
    const candidates = Object.keys(now).filter((p) => before[p] !== now[p]).sort();
    const removed = topmost(gone);
    // Caps: whole files past FILE_MAX left out; dependency folders up to depsMax; the tar up to tarMax.
    const skipped: Array<{ path: string; size: number; reason: string }> = [];
    let depBytes = 0;
    let total = 0;
    const changed: string[] = [];
    let depsCut = false;
    for (const p of [...candidates.filter((x) => !isDep(x)), ...candidates.filter(isDep)]) {
      const entry = sized.get(p);
      const size = entry?.type === "file" ? entry.size ?? 0 : 0;
      if (size > FILE_MAX_BYTES) { skipped.push({ path: p, size, reason: "too_large" }); continue; }
      if (isDep(p)) {
        if (depsCut || depBytes + size > depsMax) { depsCut = true; skipped.push({ path: p, size, reason: "dependency_cap" }); continue; }
        depBytes += size;
      }
      if (total + size > tarMax) { skipped.push({ path: p, size, reason: "tar_cap" }); continue; }
      total += size;
      changed.push(p);
    }
    const skippedSet = new Set(skipped.map((item) => item.path));
    const label = asked ?? `turn-${turn}`;
    const stage = path.join(dir, `.stage-${label}-${process.pid}-${randomBytes(3).toString("hex")}`);
    mkdirSync(stage, { recursive: true });
    let tarInfo: Awaited<ReturnType<typeof client.tarTo>> | null = null;
    if (changed.length) tarInfo = await client.tarTo(endpoint, changed, path.join(stage, `${label}.tar`));
    const tTar = Date.now();
    // What a later checkpoint compares with: a path left out stays "unknown", so it is tried again.
    const signatures: Record<string, string> = {};
    for (const [p, sig] of Object.entries(now)) if (!skippedSet.has(p)) signatures[p] = sig;
    const image = this.image();
    const parent = full ? null : chain.last;
    const id = `cp_${createHash("sha256").update(canonical({ schema: RECORD_SCHEMA, box: this.key, container: this.containerId, label, turn, parent, image: image.digest || image.id, changed, removed, sha256: tarInfo?.sha256 ?? null })).digest("hex")}`;
    const summary: CheckpointSummary = {
      schema: RECORD_SCHEMA,
      label,
      turn: turn ?? null,
      tar: tarInfo ? `${label}.tar` : null,
      bytes: tarInfo?.bytes ?? 0,
      sha256: tarInfo?.sha256 ?? null,
      full,
      ...(leaf ? { leaf: true as const } : {}),
      delta: { parent, changed, removed },
      checkpoint: { schema: RECORD_SCHEMA, id, parent, turn: turn ?? null, image: { ref: image.ref ?? null, digest: image.digest ?? null }, status: "complete", capturedAt: new Date().toISOString() },
      skipped,
      ...(depsInfo ? { deps: { ...depsInfo, bytes: depBytes, cut: depsCut } } : {}),
      stats: { source, diff_entries: entries.length, kept: Object.keys(now).length, copied: changed.length, removed: removed.length, diff_ms: tDiff - t0, stat_ms: tStat - tDiff, tar_ms: tTar - tStat, total_ms: Date.now() - t0, ...(tarInfo?.warning ? { warning: tarInfo.warning } : {}) },
    };
    writeJson(path.join(stage, `${label}.json`), summary, 0o600);
    this.log("info", "box checkpoint", { label, full, copied: changed.length, removed: removed.length, bytes: summary.bytes, ms: summary.stats.total_ms });
    let settled = false;
    const record = this.describe();
    return {
      summary,
      /** Place it in `to` (default: the folder it was taken for) and, unless a leaf, chain on from it. */
      commit: (to = dir) => {
        if (settled) return summary;
        settled = true;
        mkdirSync(to, { recursive: true });
        const recordPath = path.join(to, "record.json");
        if (!existsSync(recordPath)) writeJson(recordPath, record, 0o600);
        rmSync(path.join(to, `${label}.tar`), { force: true });
        for (const name of readdirSync(stage)) renameSync(path.join(stage, name), path.join(to, name));
        rmSync(stage, { recursive: true, force: true });
        if (!leaf) writeJson(path.join(to, ".chain.json"), { container: this.containerId, last: id, label, turn, signatures }, 0o600);
        return summary;
      },
      discard: () => {
        if (settled) return;
        settled = true;
        rmSync(stage, { recursive: true, force: true });
      },
    };
  }

  /** Disk the container's own layer uses (bytes), when the runtime says. */
  async upperBytes(): Promise<number | null> {
    const res = await rt(this.runtime, this.run)(["ps", "-a", "-s", "--filter", `name=^/?${this.name}$`, "--format", "{{.Size}}"], { timeoutMs: 30_000 });
    return parseSize(res.stdout);
  }
}

/** "57.2MB (virtual 1.1GB)" -> bytes of the first number. */
export function parseSize(text: string): number | null {
  const match = /([\d.]+)\s*([kKMGT]?i?B)/.exec(String(text));
  if (!match) return null;
  const unit = match[2]!.replace(/i/, "").toUpperCase();
  const mult = ({ B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 } as Record<string, number>)[unit] ?? 1;
  return Math.round(Number(match[1]) * mult);
}

// --- status, reset, gc --------------------------------------------------------------

export type ListedBox = { key: string; name: string; root: string; running: boolean; image: string; created: string };

/** Boxes on this machine: { key, name, root, running, image, created }[] */
export async function listBoxes(runtime: BoxRuntime, { run = runCommand }: { run?: RunCommand } = {}): Promise<ListedBox[]> {
  const res = await rt(runtime, run)(["ps", "-a", "--filter", `label=${LABEL}=1`, "--format", "{{json .}}"], { timeoutMs: 30_000 });
  if (res.code !== 0) return [];
  const out: ListedBox[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const labels: Record<string, string> = typeof row.Labels === "string"
        ? Object.fromEntries(row.Labels.split(",").map((kv: string) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }))
        : (row.Labels ?? {});
      const name = Array.isArray(row.Names) ? row.Names[0] : String(row.Names ?? "");
      out.push({ key: labels[`${LABEL}.key`] ?? "", name, root: labels[`${LABEL}.root`] ?? "", running: /^up|running/i.test(String(row.Status ?? row.State ?? "")), image: String(row.Image ?? ""), created: String(row.CreatedAt ?? row.Created ?? "") });
    } catch { /* skip */ }
  }
  return out;
}

/** Remove a project's box (the next start makes a new one). */
export async function resetBox(runtime: BoxRuntime, root: string, { env = process.env, platform = process.platform, home = boxHome(env), run = runCommand }: { env?: Env; platform?: NodeJS.Platform; home?: string; run?: RunCommand } = {}): Promise<{ key: string; removed: boolean }> {
  const key = boxKey(root, { platform });
  const res = await rt(runtime, run)(["rm", "-f", containerName(key, env)], { timeoutMs: 60_000 });
  rmSync(recordFile(home, key), { force: true });
  rmSync(path.join(home, "chains", key), { recursive: true, force: true });
  return { key, removed: res.code === 0 };
}

/**
 * Remove boxes whose folder is gone or that were not used for `maxIdleDays`,
 * and box images no box uses that are not the current pins. Only containers
 * and images labelled/named as OmniRush boxes are touched; nothing is pruned.
 */
export async function gcBoxes(runtime: BoxRuntime, { env = process.env, home = boxHome(env), run = runCommand, maxIdleDays = 30, pins = null, now = Date.now(), exists = existsSync }: { env?: Env; home?: string; run?: RunCommand; maxIdleDays?: number; pins?: ImagePins | null; now?: number; exists?: (file: string) => boolean } = {}): Promise<Array<{ kind: string; name: string; reason: string }>> {
  const removed: Array<{ kind: string; name: string; reason: string }> = [];
  const boxes = await listBoxes(runtime, { run });
  for (const box of boxes) {
    const rec = readRecord(home, box.key);
    const idle = rec?.updated ? (now - rec.updated) / 86_400_000 : Infinity;
    if ((box.root && !exists(box.root)) || idle > maxIdleDays) {
      const res = await rt(runtime, run)(["rm", "-f", box.name], { timeoutMs: 60_000 });
      if (res.code === 0) {
        removed.push({ kind: "container", name: box.name, reason: box.root && !exists(box.root) ? "folder gone" : "unused" });
        rmSync(recordFile(home, box.key), { force: true });
        rmSync(path.join(home, "chains", box.key), { recursive: true, force: true });
      }
    }
  }
  const images = await rt(runtime, run)(["images", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"], { timeoutMs: 30_000 });
  const current = new Set(Object.values(pins?.images ?? {}).map((pin) => pin.ref));
  const used = new Set((await listBoxes(runtime, { run })).map((box) => box.image));
  for (const line of images.stdout.split("\n")) {
    const [ref, id] = line.trim().split(/\s+/);
    if (!ref || !/(^|\/)omnirush-ai\/box-[a-z]+:/.test(ref) || current.has(ref) || used.has(ref) || (id && used.has(id))) continue;
    const res = await rt(runtime, run)(["rmi", ref], { timeoutMs: 60_000 });
    if (res.code === 0) removed.push({ kind: "image", name: ref, reason: "not current" });
  }
  return removed;
}

/** Count of complete turn checkpoints in a session's folder (resume continues after it). */
export function savedTurns(dir: string): number {
  try {
    return readdirSync(dir).map((name) => /^turn-(\d+)\.json$/.exec(name)?.[1]).filter((n): n is string => Boolean(n)).map(Number).reduce((a, b) => Math.max(a, b), 0);
  } catch {
    return 0;
  }
}
