// The sandbox's one-time setup when it is required (required.json `setup`),
// run by the app for the user. This module runs in the desktop app's main
// process (the embedded server):
//
// - Linux, AppArmor blocking user namespaces (Ubuntu 23.10+): "Allow the
//   sandbox" runs the CLI's `sandbox enable` step through pkexec (one polkit
//   prompt): OmniRush's bubblewrap copied root-owned to ENABLED_BWRAP and its
//   AppArmor profile loaded. Nothing system-wide changes.
// - Windows, WSL 2 missing: "Set up (one restart)" runs the shared install
//   script elevated (one UAC prompt: one `Start-Process -Verb RunAs -Wait`
//   with a temp .ps1 and a log), then an HKCU RunOnce value reopens the app
//   after the restart, which finishes the setup (WSL update when it asks for
//   one, the distro import and the image download: the usual box start).
// - Windows that cannot run WSL 2 (virtualization off in the firmware, a VM
//   without nested virtualization, S mode, an old build, a policy): why, from
//   PowerShell CIM before the install and WSL's errors after it.
// - macOS: the OmniRush VM (Lima) is a separate backend; until it is in this
//   build, a Mac without a running container app reads "runtime" (the card's
//   usual next step).
//
// The state of the last setup step is in <box home>/setup.json.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { GOARCH, helperPath } from "./common.js";
import { APPARMOR_PROFILE, ENABLED_BWRAP, apparmorProfile } from "./backends/bwrap.js";
import { REQUIRED_RULES, parseWindowsFacts, virtualizationError, whyText, windowsInstallScript, windowsWhy, WINDOWS_FACTS_SCRIPT, type CannotRunWhy, type RequiredFallback, type WindowsFacts } from "./required.js";
import { runCommand, type RunCommand, type RuntimeResult } from "./runtime.js";

/** What the sandbox needs on this computer before it can run. */
export type SetupNeed = "none" | "linux_allow" | "win_install" | "win_restart" | "win_update" | "mac_vm" | "runtime" | "cannot_run";

export type BoxSetup = {
  need: SetupNeed;
  /** cannot_run: why (required.json texts.why), and in words. */
  why: CannotRunWhy | null;
  whyText: string | null;
  /** The user cancelled the setup (the admin prompt, or "Not now"): chats run here meanwhile. */
  declined: boolean;
  /** The last setup step's answer (the polkit prompt, the install): one line. */
  result: { ok: boolean; message: string; at: number } | null;
  /** What a chat does while the sandbox cannot run (the server's required_fallback). */
  fallback: RequiredFallback;
};

type StepState = { state: "installed" | "allowed" | "failed" | "declined"; at: number; message: string; update?: number };
export type SetupState = { win?: StepState; linux?: StepState; declinedAt?: number };

export function setupFile(home: string): string {
  return path.join(home, "setup.json");
}

export function readSetupState(home: string): SetupState {
  try {
    const value: unknown = JSON.parse(readFileSync(setupFile(home), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function writeSetupState(home: string, update: (state: SetupState) => SetupState): SetupState {
  const next = update(readSetupState(home));
  try {
    mkdirSync(home, { recursive: true });
    const tmp = `${setupFile(home)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, setupFile(home));
  } catch { /* best effort */ }
  return next;
}

/** Every reason the backend probe gave (the chosen one's and each tried one's). */
function reasons(runtime: RuntimeResult | null): string[] {
  if (!runtime || runtime.ok) return [];
  return [runtime.reason, ...(runtime.tried ?? []).map((tried) => tried.reason)].filter(Boolean);
}

/**
 * What the sandbox needs here, from the backend probe, this machine's facts
 * (Windows) and the last setup step. Pure.
 */
export function classifySetup({ runtime, platform, facts = null, state = {}, fallback, macVm = false }: { runtime: RuntimeResult | null; platform: string; facts?: WindowsFacts | null; state?: SetupState; fallback: RequiredFallback; macVm?: boolean }): BoxSetup {
  const step = platform === "win32" ? state.win : platform === "linux" ? state.linux : undefined;
  const base = { why: null, whyText: null, declined: Boolean(state.declinedAt), result: step ? { ok: step.state === "installed" || step.state === "allowed", message: step.message, at: step.at } : null, fallback };
  if (runtime?.ok) return { ...base, need: "none", declined: false };
  const said = reasons(runtime);
  const cannot = (why: CannotRunWhy | null, text?: string | null): BoxSetup => ({ ...base, need: "cannot_run", why, whyText: why ? whyText(why) : text ?? null, declined: false });
  if (platform === "linux") {
    if (said.some((reason) => /sandbox enable/.test(reason))) return { ...base, need: "linux_allow" };
    const blocked = said.find((reason) => /user namespaces|inside a container|container engine/i.test(reason));
    if (blocked && !said.some((reason) => /apt install|usermod|systemctl start/.test(reason))) return cannot(null, blocked);
    return { ...base, need: "runtime" };
  }
  if (platform === "win32") {
    const why = facts ? windowsWhy({ ...facts, wslSaid: step?.message ?? null, policy: /policy/i.test(step?.message ?? "") }) : null;
    if (why) return cannot(why);
    if (said.some((reason) => /wsl --update/.test(reason))) return { ...base, need: "win_update" };
    if (said.some((reason) => /WSL 2 is not enabled/.test(reason))) return { ...base, need: step?.state === "installed" ? "win_restart" : "win_install" };
    return { ...base, need: "runtime" };
  }
  if (platform === "darwin") {
    const version = Number(/^(\d+)/.exec(os.release())?.[1] ?? 0);
    // Darwin 22 is macOS 13.
    if (version && version < 22) return cannot("old_macos");
    return { ...base, need: macVm ? "mac_vm" : "runtime" };
  }
  return { ...base, need: "runtime" };
}

// --- Windows -------------------------------------------------------------------------------

let factsCache: { at: number; facts: WindowsFacts } | null = null;

/** This Windows' facts (PowerShell CIM), cached for 10 minutes unless `fresh`. */
export async function windowsFacts({ run = runCommand, fresh = false, now = Date.now() }: { run?: RunCommand; fresh?: boolean; now?: number } = {}): Promise<WindowsFacts> {
  if (!fresh && factsCache && now - factsCache.at < 10 * 60_000) return factsCache.facts;
  const res = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_FACTS_SCRIPT], { timeoutMs: 15_000 });
  const facts = parseWindowsFacts(res.stdout);
  factsCache = { at: now, facts };
  return facts;
}

/** A PowerShell single-quoted string. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The one elevated start: the .ps1 with its log path, waited for; exit 1223 when the admin prompt was cancelled. */
export function elevatedCommand(script: string, log: string): string {
  return [
    "try {",
    `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(`"${script}"`)},${psQuote(`"${log}"`)}) -Verb RunAs -Wait -PassThru -WindowStyle Hidden;`,
    "exit $p.ExitCode",
    "} catch { Write-Output 'cancelled'; exit 1223 }",
  ].join(" ");
}

/** The HKCU RunOnce value that reopens the app after the restart. */
export function runOnceArgs(exe: string): string[] {
  return ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce", "/v", REQUIRED_RULES.setup.win32.resume_run_once, "/t", "REG_SZ", "/d", `"${exe}"`, "/f"];
}

/**
 * Turn on WSL 2 (the shared install script, elevated once). Installed: the
 * RunOnce value is set (`exe`: the app) and the state says a restart is
 * needed; cancelled at the admin prompt: declined.
 */
export async function windowsInstall({ home, run = runCommand, exe = process.versions.electron ? process.execPath : null, tmp = os.tmpdir() }: { home: string; run?: RunCommand; exe?: string | null; tmp?: string }): Promise<StepState> {
  const dir = path.join(tmp, `omnirush-setup-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "setup.ps1");
  const log = path.join(home, "setup-wsl.log");
  mkdirSync(home, { recursive: true });
  writeFileSync(script, windowsInstallScript());
  writeFileSync(log, "");
  const res = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", elevatedCommand(script, log)], { timeoutMs: 30 * 60_000 });
  let said = "";
  try { said = readFileSync(log, "utf8"); } catch { /* none */ }
  rmSync(dir, { recursive: true, force: true });
  const last = said.trim().split(/\r?\n/).filter((line) => line.trim() && line.trim() !== "done").pop()?.trim().slice(0, 300) ?? "";
  let step: StepState;
  if (res.code === 1223 || /cancelled/.test(res.stdout)) step = { state: "declined", at: Date.now(), message: "The administrator prompt was cancelled." };
  else if (/\bdone\b/.test(said) && !virtualizationError(said)) step = { state: "installed", at: Date.now(), message: last || "WSL 2 is installed." };
  else step = { state: "failed", at: Date.now(), message: last || `The setup stopped (${res.code}).` };
  if (step.state === "installed" && exe) await run("reg.exe", runOnceArgs(exe), { timeoutMs: 15_000 });
  writeSetupState(home, (state) => ({ ...state, win: step, ...(step.state === "declined" ? { declinedAt: step.at } : { declinedAt: undefined }) }));
  return step;
}

/** Restart Windows now (the screen's "Restart now"; never while a chat runs: the caller checks). */
export function windowsRestart({ run = runCommand }: { run?: RunCommand } = {}): Promise<unknown> {
  return run("shutdown.exe", ["/r", "/t", "5", "/c", "OmniRush finishes the sandbox setup after the restart."], { timeoutMs: 15_000 });
}

/** After the restart, WSL asks for an update: `wsl --update` once (it asks for admin itself when it needs to). */
export async function windowsUpdate({ home, run = runCommand }: { home: string; run?: RunCommand }): Promise<StepState> {
  const res = await run("wsl.exe", ["--update", "--web-download"], { timeoutMs: 15 * 60_000, env: { ...process.env, WSL_UTF8: "1" } });
  const step: StepState = { ...(readSetupState(home).win ?? { state: "installed", at: Date.now(), message: "" }), update: Date.now(), message: res.code === 0 ? "WSL is up to date." : `\`wsl --update\` stopped (${res.code}).` };
  writeSetupState(home, (state) => ({ ...state, win: step }));
  return step;
}

/** The setup finished (the box is ready): the step and the RunOnce value are no longer needed. */
export async function setupDone(home: string, { platform = process.platform, run = runCommand }: { platform?: string; run?: RunCommand } = {}): Promise<void> {
  const state = readSetupState(home);
  if (!state.win && !state.linux && !state.declinedAt) return;
  writeSetupState(home, () => ({}));
  if (platform === "win32" && state.win) {
    await run("reg.exe", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce", "/v", REQUIRED_RULES.setup.win32.resume_run_once, "/f"], { timeoutMs: 15_000 });
  }
}

// --- Linux -------------------------------------------------------------------------------------

/**
 * The root step `sandbox enable` does (CLI src/box/backends/bwrap.js
 * enableBwrap), as one shell script for pkexec: $1 is the bubblewrap to
 * install (checked against $2, its sha256), copied root-owned to
 * ENABLED_BWRAP, and the AppArmor profile for that copy only.
 */
export function linuxAllowScript(): string {
  const dir = path.posix.dirname(ENABLED_BWRAP);
  return [
    "set -eu",
    'src="$1"; sum="$2"',
    `dst=${ENABLED_BWRAP}; prof=${APPARMOR_PROFILE}`,
    `mkdir -p ${dir}`,
    'cp "$src" "$dst.tmp"',
    'if [ -n "$sum" ] && [ "$(sha256sum "$dst.tmp" | cut -d" " -f1)" != "$sum" ]; then rm -f "$dst.tmp"; echo "checksum mismatch" >&2; exit 3; fi',
    'chown 0:0 "$dst.tmp"; chmod 0755 "$dst.tmp"; mv -f "$dst.tmp" "$dst"',
    `chown 0:0 ${dir}; chmod 0755 ${dir}`,
    'parser=""; for p in /sbin/apparmor_parser /usr/sbin/apparmor_parser; do [ -x "$p" ] && parser="$p" && break; done',
    'if [ -z "$parser" ] || [ ! -d /etc/apparmor.d ]; then echo "installed; no AppArmor here"; exit 0; fi',
    `cat > "$prof" <<'OMNIRUSH_PROFILE'`,
    apparmorProfile(ENABLED_BWRAP).trimEnd(),
    "OMNIRUSH_PROFILE",
    'chmod 0644 "$prof"',
    '"$parser" -r "$prof"',
    'echo "installed; AppArmor profile loaded"',
  ].join("\n");
}

/** The bubblewrap "Allow" installs: the one shipped with the app, else the system's. */
export function allowSource({ env = process.env, arch = process.arch, exists = existsSync }: { env?: NodeJS.ProcessEnv; arch?: string; exists?: (file: string) => boolean } = {}): string | null {
  const shipped = helperPath("bwrap", { goos: "linux", goarch: GOARCH[arch] || "amd64", env });
  if (shipped) return shipped;
  return ["/usr/bin/bwrap", "/usr/local/bin/bwrap"].find((file) => exists(file)) ?? null;
}

/**
 * "Allow the sandbox": pkexec (OMNIRUSH_BOX_PKEXEC replaces it in test rigs)
 * runs linuxAllowScript as root. The bubblewrap is first copied to the box
 * home (root may not read the app's own mount, an AppImage). pkexec exits
 * 126 when the prompt was dismissed and 127 when not authorised.
 */
export async function linuxAllow({ home, env = process.env, run = runCommand, source = allowSource({ env }) }: { home: string; env?: NodeJS.ProcessEnv; run?: RunCommand; source?: string | null }): Promise<StepState> {
  let step: StepState;
  if (!source) {
    step = { state: "failed", at: Date.now(), message: "No bubblewrap to install: install your system's bubblewrap package, then try again." };
  } else {
    const staged = path.join(home, "setup-bwrap");
    mkdirSync(home, { recursive: true });
    copyFileSync(source, staged);
    const sum = createHash("sha256").update(readFileSync(staged)).digest("hex");
    const pkexec = String(env.OMNIRUSH_BOX_PKEXEC || "").trim() || "pkexec";
    const res = await run(pkexec, ["/bin/sh", "-c", linuxAllowScript(), "omnirush-sandbox-allow", staged, sum], { timeoutMs: 10 * 60_000 });
    rmSync(staged, { force: true });
    const said = `${res.stdout}\n${res.stderr}`.trim().split("\n").filter(Boolean).pop()?.slice(0, 300) ?? "";
    if (res.code === 0) step = { state: "allowed", at: Date.now(), message: said ? `Allowed (${said}).` : "Allowed." };
    else if (res.code === 126) step = { state: "declined", at: Date.now(), message: "The password prompt was dismissed." };
    else if (res.code === 127 || res.error === "ENOENT") step = { state: "failed", at: Date.now(), message: res.error === "ENOENT" ? "pkexec is missing: run `sudo omnirush sandbox enable` in a terminal instead (OmniRush CLI)." : `Not authorised${said ? `: ${said}` : ""}.` };
    else step = { state: "failed", at: Date.now(), message: said || `The step stopped (${res.code}).` };
  }
  writeSetupState(home, (state) => ({ ...state, linux: step, ...(step.state === "declined" ? { declinedAt: step.at } : { declinedAt: undefined }) }));
  return step;
}
