// Ported from the CLI (omnirush-cli src/box/runtime.js, feat/local-box);
// keep the two in step. Only types were added here.
//
// Which container runtime runs a project's box: rootless Podman or Docker on
// Linux, Docker Desktop / OrbStack / colima / Rancher Desktop / Podman
// machine on macOS and Windows, Docker inside WSL2. Never blocks a start: a
// probe has a short time limit, its result is cached, and "none" means the
// session runs on this machine with one line saying why.
//
// The old sandbox (CLI 2.2.3 to 2.3.6) failed users here: Docker Desktop's
// ~/.docker/bin not on PATH, a Windows docker.exe reached from WSL through
// /mnt/c, the docker-group permission error shown as "the reason is above".
// Each of those has a rule below and a test.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Probe results are reused this long (ms): a working runtime, and a missing one. */
export const CACHE_OK_MS = 10 * 60_000;
export const CACHE_FAIL_MS = 2 * 60_000;

type Env = NodeJS.ProcessEnv;

export type RunResult = { code: number; stdout: string; stderr: string; error?: string };
export type RunOptions = { env?: Env; timeoutMs?: number; input?: string | Buffer; maxBytes?: number };
export type RunCommand = (bin: string, args: string[], options?: RunOptions) => Promise<RunResult>;

export type RuntimeCandidate = { name: string; bin: string; skipped?: string };
export type RuntimeInfo = {
  ok: true;
  name: string;
  bin: string;
  version: string;
  os: string;
  arch: string;
  rootless: boolean;
  flavor: string;
  vm: boolean;
  cached?: boolean;
};
export type RuntimeFailure = { ok: false; name?: string; bin?: string; reason: string; tried?: Array<{ name?: string; bin?: string; reason: string }>; cached?: boolean };
export type RuntimeResult = RuntimeInfo | RuntimeFailure;

/** Whether this Linux is WSL (the kernel says Microsoft). */
export function isWsl(env: Env = process.env, release = os.release()): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP) || /microsoft/i.test(release);
}

/** Folders a runtime's CLI is installed in beyond PATH, per platform. */
export function searchDirs({ platform = process.platform, home = os.homedir(), env = process.env }: { platform?: NodeJS.Platform; home?: string; env?: Env } = {}): string[] {
  if (platform === "darwin") {
    return [
      "/usr/local/bin", "/opt/homebrew/bin", path.posix.join(home, ".docker", "bin"),
      "/Applications/Docker.app/Contents/Resources/bin", path.posix.join(home, ".orbstack", "bin"),
      path.posix.join(home, ".rd", "bin"), "/opt/podman/bin", "/opt/local/bin",
    ];
  }
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    const local = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
    return [
      path.win32.join(pf, "Docker", "Docker", "resources", "bin"),
      path.win32.join(pf, "RedHat", "Podman"),
      path.win32.join(local, "Programs", "Rancher Desktop", "resources", "resources", "win32", "bin"),
      path.win32.join(pf, "Rancher Desktop", "resources", "resources", "win32", "bin"),
    ];
  }
  return ["/usr/bin", "/usr/local/bin", "/snap/bin", path.posix.join(home, ".local", "bin"), path.posix.join(home, "bin"), path.posix.join(home, ".docker", "bin")];
}

/** A Windows binary seen from WSL (/mnt/c/...): it cannot mount this Linux's folders. */
export function windowsBinaryInWsl(file: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(String(file));
}

/**
 * Runtime CLIs to try, best first: OMNIRUSH_BOX_RUNTIME (docker, podman or a
 * path) alone when set; else on Linux Podman then Docker (rootless Podman
 * keeps files owned by the user with no daemon), on macOS and Windows Docker
 * then Podman (Docker Desktop, OrbStack, colima, Rancher all speak docker).
 */
export function candidates({ platform = process.platform, home = os.homedir(), env = process.env, exists = existsSync, wsl = platform === "linux" && isWsl(env) }: { platform?: NodeJS.Platform; home?: string; env?: Env; exists?: (file: string) => boolean; wsl?: boolean } = {}): RuntimeCandidate[] {
  const ext = platform === "win32" ? ".exe" : "";
  const sep = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const pathDirs = String(env.PATH || env.Path || "").split(sep).filter(Boolean);
  const dirs = [...pathDirs, ...searchDirs({ platform, home, env })];
  const asked = String(env.OMNIRUSH_BOX_RUNTIME || "").trim();
  const out: RuntimeCandidate[] = [];
  const seen = new Set<string>();
  const add = (name: string, file: string, skipped?: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    out.push({ name, bin: file, ...(skipped ? { skipped } : {}) });
  };
  if (asked && /[\\/]/.test(asked)) {
    add(/podman/i.test(path.basename(asked)) ? "podman" : "docker", asked);
    return out;
  }
  const names = asked ? [asked] : platform === "linux" ? ["podman", "docker"] : ["docker", "podman"];
  for (const name of names) {
    for (const dir of dirs) {
      const file = join(dir, name + ext);
      if (!exists(file)) continue;
      if (wsl && windowsBinaryInWsl(file)) {
        add(name, file, "a Windows program seen from WSL; install Docker in WSL or turn on Docker Desktop's WSL integration");
        continue;
      }
      add(name, file);
    }
  }
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : "spawn";
}

/** Run a program with a time limit; never throws. */
export function runCommand(bin: string, args: string[], { env = process.env, timeoutMs = 8_000, input, maxBytes = 64 << 20 }: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: errorText(error), error: errorCode(error) });
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    const err: Buffer[] = [];
    let done = false;
    const finish = (value: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      finish({ code: -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), error: "timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { outBytes += chunk.length; if (outBytes <= maxBytes) out.push(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { if (err.length < 64) err.push(chunk); });
    child.on("error", (error) => finish({ code: -1, stdout: "", stderr: errorText(error), error: errorCode(error) }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

function firstLine(text: unknown): string {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

/** A user-facing reason for a failed probe, from what the runtime printed. */
export function explainFailure(name: string, result: Partial<RunResult>, { platform = process.platform }: { platform?: NodeJS.Platform } = {}): string {
  const said = firstLine(result.stderr) || firstLine(result.stdout);
  if (result.error === "ENOENT") return `${name} is not installed`;
  if (result.error === "timeout") return `${name} did not answer in time (is it starting?)`;
  if (/permission denied/i.test(said) && /docker\.sock|docker daemon socket/i.test(said)) {
    return "Docker refused this user (add it to the docker group: `sudo usermod -aG docker $USER`, then log in again), or use rootless Podman";
  }
  if (/cannot connect to the docker daemon|is the docker daemon running|error during connect|docker_engine/i.test(said)) {
    return platform === "linux" ? "the Docker daemon is not running" : "Docker is installed but not running (start Docker Desktop, OrbStack or colima)";
  }
  if (/podman machine|cannot connect to podman|unable to connect to podman/i.test(said)) return "Podman is installed but its machine is not running (`podman machine start`)";
  if (said) return `${name}: ${said.slice(0, 200)}`;
  return `${name} exited with ${result.code}`;
}

type Info = Record<string, unknown> & {
  OperatingSystem?: unknown;
  Name?: unknown;
  host?: { distribution?: { distribution?: unknown }; os?: unknown; arch?: unknown; security?: { rootless?: unknown } };
  version?: { Version?: unknown };
  OSType?: unknown;
  ServerErrors?: unknown;
  SecurityOptions?: unknown;
  ServerVersion?: unknown;
  Architecture?: unknown;
};

/** What kind of installation answered (shown in status; recorded in uploads). */
export function flavorOf({ name, info = {}, platform = process.platform, wsl = false }: { name: string; info?: Info; platform?: NodeJS.Platform; wsl?: boolean }): string {
  const system = String(info.OperatingSystem || info.host?.distribution?.distribution || "");
  const host = String(info.Name || "");
  if (/docker desktop/i.test(system)) return "desktop";
  if (/orbstack/i.test(system) || /orbstack/i.test(host)) return "orbstack";
  if (/colima/i.test(host) || /colima/i.test(system)) return "colima";
  if (/rancher/i.test(system)) return "rancher";
  if (name === "podman" && platform !== "linux") return "podman-machine";
  if (wsl) return "wsl";
  return "engine";
}

/**
 * Probe one runtime CLI: { ok: true, name, bin, version, os, arch, flavor,
 * rootless, vm } or { ok: false, name, bin, reason }.
 */
export async function probe(candidate: RuntimeCandidate, { run = runCommand, env = process.env, platform = process.platform, wsl = platform === "linux" && isWsl(env), timeoutMs = 8_000 }: { run?: RunCommand; env?: Env; platform?: NodeJS.Platform; wsl?: boolean; timeoutMs?: number } = {}): Promise<RuntimeResult> {
  const { name, bin } = candidate;
  if (candidate.skipped) return { ok: false, name, bin, reason: `${bin}: ${candidate.skipped}` };
  if (name === "docker") {
    const host = String(env.DOCKER_HOST || "");
    if (/^(ssh|tcp|https?):\/\//i.test(host) && env.OMNIRUSH_BOX_ALLOW_REMOTE !== "1") {
      return { ok: false, name, bin, reason: "DOCKER_HOST points at another machine, which cannot see this folder" };
    }
  }
  const args = name === "podman" ? ["info", "--format", "json"] : ["info", "--format", "{{json .}}"];
  const result = await run(bin, args, { env, timeoutMs });
  if (result.code !== 0) return { ok: false, name, bin, reason: explainFailure(name, result, { platform }) };
  let info: Info;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    return { ok: false, name, bin, reason: `could not read \`${name} info\`` };
  }
  if (name === "podman") {
    const hostInfo = info.host ?? {};
    return {
      ok: true, name, bin,
      version: String(info.version?.Version ?? ""),
      os: String(hostInfo.os ?? "linux"),
      arch: String(hostInfo.arch ?? ""),
      rootless: Boolean(hostInfo.security?.rootless),
      flavor: flavorOf({ name, info, platform, wsl }),
      vm: platform !== "linux",
    };
  }
  const osType = String(info.OSType ?? "linux");
  if (osType !== "linux") return { ok: false, name, bin, reason: `Docker is set to ${osType} containers; switch it to Linux containers` };
  if (Array.isArray(info.ServerErrors) && info.ServerErrors.length) return { ok: false, name, bin, reason: explainFailure(name, { code: 1, stderr: String(info.ServerErrors[0]) }, { platform }) };
  const security = Array.isArray(info.SecurityOptions) ? info.SecurityOptions.join(",") : "";
  const flavor = flavorOf({ name, info, platform, wsl });
  return {
    ok: true, name, bin,
    version: String(info.ServerVersion ?? ""),
    os: osType,
    arch: String(info.Architecture ?? ""),
    rootless: /rootless/.test(security),
    flavor,
    // Docker Desktop, OrbStack, colima: files cross into a VM; ownership is mapped there.
    vm: platform !== "linux" || flavor === "desktop",
  };
}

function cacheFile(boxHome: string): string {
  return path.join(boxHome, "runtime.json");
}

function readCache(boxHome: string, now: number, key: string): RuntimeResult | null {
  try {
    const cached = JSON.parse(readFileSync(cacheFile(boxHome), "utf8"));
    if (cached?.key !== key) return null;
    const age = now - Number(cached.at);
    if (!(age >= 0)) return null;
    if (cached.result?.ok ? age < CACHE_OK_MS : age < CACHE_FAIL_MS) return cached.result;
  } catch { /* none */ }
  return null;
}

function writeCache(boxHome: string, key: string, result: RuntimeResult, now: number): void {
  try {
    mkdirSync(boxHome, { recursive: true });
    const file = cacheFile(boxHome);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ key, at: now, result }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* best effort */ }
}

/**
 * The runtime for boxes on this machine (cached; `fresh` skips the cache):
 * the first candidate that answers, or { ok: false, reason, tried } where
 * `reason` is one line for the user.
 */
export async function detectRuntime({ boxHome, env = process.env, platform = process.platform, home = os.homedir(), exists = existsSync, run = runCommand, wsl = platform === "linux" && isWsl(env), now = Date.now(), fresh = false, timeoutMs }: { boxHome?: string; env?: Env; platform?: NodeJS.Platform; home?: string; exists?: (file: string) => boolean; run?: RunCommand; wsl?: boolean; now?: number; fresh?: boolean; timeoutMs?: number } = {}): Promise<RuntimeResult> {
  const key = JSON.stringify([platform, env.OMNIRUSH_BOX_RUNTIME || "", env.DOCKER_HOST || "", env.PATH || env.Path || ""]);
  if (boxHome && !fresh) {
    const cached = readCache(boxHome, now, key);
    if (cached) return { ...cached, cached: true };
  }
  const list = candidates({ platform, home, env, exists, wsl });
  const tried: RuntimeFailure[] = [];
  let result: RuntimeResult | null = null;
  for (const candidate of list) {
    const probed = await probe(candidate, { run, env, platform, wsl, ...(timeoutMs ? { timeoutMs } : {}) });
    if (probed.ok) { result = probed; break; }
    tried.push(probed);
  }
  if (!result) {
    const reason = tried.length
      ? tried.map((entry) => entry.reason).join("; ")
      : platform === "linux"
        ? "no container runtime found (install Podman or Docker)"
        : platform === "darwin"
          ? "no container runtime found (install Docker Desktop, OrbStack, colima or Podman)"
          : "no container runtime found (install Docker Desktop with the WSL 2 backend, or Podman)";
    result = { ok: false, reason, tried: tried.map(({ name, bin, reason: why }) => ({ name, bin, reason: why })) };
  }
  if (boxHome) writeCache(boxHome, key, result, now);
  return result;
}
