// The sandbox's one-time setup when it is required (required.json `setup`),
// run by the app for the user. Ported from the CLI (omnirush-cli
// src/box/setup-state.js, src/box/win-setup.js); keep the shared parts in
// step: <box home>/setup.json is the same file for both (the CLI and the app
// share the box home), with the same entries. This module runs in the
// desktop app's main process (the embedded server):
//
// - Linux, AppArmor blocking user namespaces (Ubuntu 23.10+): "Allow the
//   sandbox" runs the CLI's `sandbox enable` step through pkexec (one polkit
//   prompt): OmniRush's bubblewrap copied root-owned to ENABLED_BWRAP and its
//   AppArmor profile loaded. Nothing system-wide changes.
// - Windows, WSL 2 missing: "Set up (one restart)" checks the build, S mode
//   and virtualization (PowerShell CIM), then runs the shared install script
//   elevated (one UAC prompt: one `Start-Process -Verb RunAs -Wait` with a
//   temp .ps1 and a log). The resume marker (setup.json win: restart) and an
//   HKCU RunOnce value reopen the app after the restart, which finishes the
//   setup (`wsl --update` when WSL asks for it; then the distro import and
//   the image download: the usual box start).
// - Windows that cannot run WSL 2 (virtualization off in the firmware, a VM
//   without nested virtualization, S mode, an old build, a policy): why,
//   before the install and from WSL's errors after it.
// - macOS: the OmniRush VM (Lima, backends/lima.ts) sets itself up (no admin):
//   while it is not made yet the need is "mac_vm" and the panel shows the VM's
//   real progress (Lima, the VM image, the VM's first boot, the box image).
//   A Mac where it cannot run (macOS < 13) reads cannot_run; one where it
//   failed and no container app runs reads "runtime" (the card's next step).
// Never edits .wslconfig.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { GOARCH, helperPath } from "./common.js";
import { APPARMOR_PROFILE, ENABLED_BWRAP, apparmorProfile } from "./backends/bwrap.js";
import { withoutWsl1Notes, wslCall, wslExe } from "./backends/wsl.js";
import { REQUIRED_RULES, whyText, type CannotRunWhy, type RequiredFallback } from "./required.js";
import { runCommand, type RunCommand, type RuntimeResult } from "./runtime.js";

const WIN = REQUIRED_RULES.setup.win32;
const VIRTUALIZATION = new RegExp(WIN.virtualization_errors, "i");
const POLICY = /group policy|blocked by (?:your|the) (?:administrator|organi[sz]ation)|0x800f0950|0x800f0922|0x80070422/i;
const VM_MODEL = /virtual machine|vmware|virtualbox|kvm|qemu|xen|parallels|hyper-v|bochs/i;
// `wsl --status` on a PC whose WSL 2 cannot start a VM (after the restart).
const NO_VM_START = /unable to start since virtualization is not enabled|virtualization is not enabled on this machine/i;

/** The install log kept for support (<box home>/setup-win.log, the last run's). */
export function installLogFile(home: string): string {
  return path.join(home, "setup-win.log");
}

/** Why a PC that cannot start WSL 2's VM can't: inside a VM (its model says so), else the firmware switch. */
export function blockedWhy(checks: Partial<WindowsChecks> | null | undefined): "nested_vm" | "firmware_off" {
  return VM_MODEL.test(String(checks?.model ?? "")) ? "nested_vm" : "firmware_off";
}

// --- setup.json (CLI: setup-state.js) --------------------------------------------------

/** How long a declined setup is not offered again at a chat start. */
export const DECLINED_QUIET_MS = 7 * 24 * 3_600_000;

/** One OS's entry: a restart pending, declined, a machine that cannot run it (and why); the app adds the last step's line. */
export type SetupEntry = { state: "restart" | "declined" | "blocked" | "failed"; why?: CannotRunWhy; message?: string; at: number };
export type SetupState = { win?: SetupEntry; linux?: SetupEntry };

export function setupFile(home: string): string {
  return path.join(home, "setup.json");
}

export function setupState(home: string): SetupState {
  try {
    const value: unknown = JSON.parse(readFileSync(setupFile(home), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Set (or with `entry` null, clear) one OS's entry. */
export function saveSetupState(home: string, which: "win" | "linux", entry: Omit<SetupEntry, "at"> | null, { now = Date.now() }: { now?: number } = {}): SetupState {
  const state = setupState(home);
  if (entry) state[which] = { ...entry, at: now };
  else delete state[which];
  try {
    mkdirSync(home, { recursive: true });
    const file = setupFile(home);
    if (Object.keys(state).length === 0) {
      rmSync(file, { force: true });
      return state;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* best effort */ }
  return state;
}

/** Whether an entry is a decline still within its quiet time. */
export function recentlyDeclined(entry: SetupEntry | undefined, { now = Date.now(), quietMs = DECLINED_QUIET_MS }: { now?: number; quietMs?: number } = {}): boolean {
  return entry?.state === "declined" && now - Number(entry.at) < quietMs;
}

// --- what is needed ----------------------------------------------------------------------

/** What the sandbox needs on this computer before it can run. */
export type SetupNeed = "none" | "linux_allow" | "win_install" | "win_restart" | "win_update" | "mac_vm" | "runtime" | "cannot_run";

export type BoxSetup = {
  need: SetupNeed;
  /** cannot_run: why (required.json texts.why), and in words. */
  why: CannotRunWhy | null;
  whyText: string | null;
  /** The user said "Not now" (or cancelled the admin prompt) within the last week: chats run here meanwhile. */
  declined: boolean;
  /** The last setup step's answer (the polkit prompt, the install), one line. */
  result: { ok: boolean; message: string; at: number } | null;
  /** What a chat does while the sandbox cannot run (the server's required_fallback). */
  fallback: RequiredFallback;
};

/** Every reason the backend probe gave (the chosen one's and each tried one's). */
function reasons(runtime: RuntimeResult | null): string[] {
  if (!runtime || runtime.ok) return [];
  return [runtime.reason, ...(runtime.tried ?? []).map((tried) => tried.reason)].filter(Boolean);
}

/**
 * What the sandbox needs here, from the backend probe, this PC's checks
 * (Windows) and setup.json. Pure.
 */
export function classifySetup({ runtime, platform, checks = null, state = {}, fallback, macVm = false, release = os.release(), now = Date.now() }: { runtime: RuntimeResult | null; platform: string; checks?: WindowsChecks | null; state?: SetupState; fallback: RequiredFallback; macVm?: boolean; release?: string; now?: number }): BoxSetup {
  const entry = platform === "win32" ? state.win : platform === "linux" ? state.linux : undefined;
  const base = { why: null, whyText: null, declined: recentlyDeclined(entry, { now }), result: entry?.message ? { ok: entry.state === "restart", message: entry.message, at: entry.at } : null, fallback };
  // The OmniRush VM picked and not made yet: it sets itself up now (the panel shows how far).
  if (platform === "darwin" && macVm && runtime?.ok) return { ...base, need: "mac_vm", declined: false };
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
    if (entry?.state === "blocked" && entry.why) return cannot(entry.why);
    // Before the restart WSL says what a PC without virtualization says: the restart step first (CLI: the same).
    if (entry?.state === "restart" && said.some((reason) => VIRTUALIZATION.test(reason) || /WSL 2 is not enabled/.test(reason))) return { ...base, need: "win_restart" };
    if (said.some((reason) => VIRTUALIZATION.test(reason))) return cannot(blockedWhy(checks));
    const decision = checks ? setupDecision(checks) : { ok: true as const };
    if (!decision.ok) return cannot(decision.why);
    if (said.some((reason) => /wsl --update/.test(reason))) return { ...base, need: "win_update" };
    if (said.some((reason) => /WSL 2 is not enabled/.test(reason))) return { ...base, need: entry?.state === "restart" ? "win_restart" : "win_install" };
    return { ...base, need: "runtime" };
  }
  if (platform === "darwin") {
    // Darwin 22 is macOS 13.
    const darwin = Number(/^(\d+)/.exec(release)?.[1] ?? 0);
    if (darwin && darwin < 22) return cannot("old_macos");
    if (said.some((reason) => /needs macOS 1\d or later/.test(reason))) return cannot("old_macos");
    return { ...base, need: "runtime" };
  }
  return { ...base, need: "runtime" };
}

// --- Windows (CLI: win-setup.js) -------------------------------------------------------------

/** The Windows build number from os.release() ("10.0.19045" -> 19045), or null. */
export function windowsBuild(release = os.release()): number | null {
  const m = /^\d+\.\d+\.(\d+)/.exec(String(release ?? ""));
  return m ? Number(m[1]) : null;
}

/** The one PowerShell call that reads what the decision needs, as JSON. */
export const CHECK_SCRIPT = [
  "$o = @{}",
  "try { $p = Get-CimInstance Win32_Processor | Select-Object -First 1; $o.firmware = [bool]$p.VirtualizationFirmwareEnabled } catch {}",
  "try { $c = Get-CimInstance Win32_ComputerSystem; $o.hypervisor = [bool]$c.HypervisorPresent; $o.model = \"$($c.Manufacturer) $($c.Model)\" } catch {}",
  "try { $o.s_mode = ((Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy' -ErrorAction Stop).SkuPolicyRequired -eq 1) } catch { $o.s_mode = $false }",
  "$o | ConvertTo-Json -Compress",
].join("; ");

/** powershell.exe, as Windows has it. */
export function powershellExe(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export type WindowsChecks = { build: number | null; firmware: boolean | null; hypervisor: boolean | null; model: string | null; s_mode: boolean | null };

/** { build, firmware, hypervisor, model, s_mode } (unknown values null). */
export async function windowsChecks({ run = runCommand, env = process.env, release = os.release() }: { run?: RunCommand; env?: NodeJS.ProcessEnv; release?: string } = {}): Promise<WindowsChecks> {
  const out: WindowsChecks = { build: windowsBuild(release), firmware: null, hypervisor: null, model: null, s_mode: null };
  const res = await run(powershellExe(env), ["-NoProfile", "-NonInteractive", "-Command", CHECK_SCRIPT], { env, timeoutMs: 20_000 }).catch(() => null);
  try {
    const value: unknown = JSON.parse(String(res?.stdout ?? "").trim().split(/\r?\n/).pop() || "{}");
    if (value && typeof value === "object") {
      const read = (key: string): unknown => Reflect.get(value, key);
      for (const key of ["firmware", "hypervisor", "s_mode"] as const) {
        const v = read(key);
        if (typeof v === "boolean") out[key] = v;
      }
      const model = read("model");
      if (typeof model === "string") out.model = model.trim().slice(0, 120);
    }
  } catch { /* unknown: the install tries */ }
  return out;
}

let checksCache: { at: number; checks: WindowsChecks } | null = null;

/** windowsChecks, kept 10 minutes unless `fresh` ("Check again"). */
export async function cachedWindowsChecks({ fresh = false, now = Date.now(), run = runCommand }: { fresh?: boolean; now?: number; run?: RunCommand } = {}): Promise<WindowsChecks> {
  if (!fresh && checksCache && now - checksCache.at < 10 * 60_000) return checksCache.checks;
  const checks = await windowsChecks({ run });
  checksCache = { at: now, checks };
  return checks;
}

/**
 * Whether the WSL install can work here: { ok: true } or { ok: false, why }
 * (old_windows, s_mode, firmware_off, nested_vm). HypervisorPresent=true
 * passes (the firmware flag reads false under a running Hyper-V); an unknown
 * answer passes (the install says).
 */
export function setupDecision(checks: Partial<WindowsChecks> | null, { minBuild = WIN.min_build }: { minBuild?: number } = {}): { ok: true } | { ok: false; why: CannotRunWhy } {
  if (Number.isFinite(checks?.build) && Number(checks?.build) < minBuild) return { ok: false, why: "old_windows" };
  if (checks?.s_mode === true) return { ok: false, why: "s_mode" };
  if (checks?.hypervisor === true) return { ok: true };
  if (checks?.firmware === false) return { ok: false, why: blockedWhy(checks) };
  return { ok: true };
}

/**
 * What the elevated install's log says: installed (its last line is `done`:
 * the install, or the DISM route after it, worked; a virtualization message
 * wsl.exe printed on the way does not undo that), blocked (virtualization,
 * policy) or failed with a line. CLI: win-setup.js, the same.
 */
export function parseInstallLog(text: string): { result: "installed" } | { result: "blocked"; why: CannotRunWhy } | { result: "failed"; line: string } {
  const clean = String(text ?? "").replace(/^\uFEFF/, "").replace(/\u0000/g, "");
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.at(-1) === "done") return { result: "installed" };
  if (VIRTUALIZATION.test(clean)) return { result: "blocked", why: "firmware_off" };
  if (POLICY.test(clean)) return { result: "blocked", why: "policy" };
  const failed = [...lines].reverse().find((l) => /error|failed|denied/i.test(l));
  return { result: "failed", line: (failed ?? lines.at(-1) ?? "no output").slice(0, 240) };
}

/** The Start-Process command line that runs `ps1` elevated, once, waiting for it. */
export function elevatedArgs(ps1: string, log: string): string[] {
  const q = (p: string) => p.replace(/'/g, "''");
  return ["-NoProfile", "-NonInteractive", "-Command",
    // RemoteSigned, not Bypass: enough for our own local script on a Restricted default, and Bypass reads as malware to scanners.
    `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy RemoteSigned -File "${q(ps1)}" "${q(log)}"'`];
}

/** The HKCU RunOnce value that reopens the app after the restart. */
export function runOnceArgs(exe: string): string[] {
  return ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce", "/v", WIN.resume_run_once, "/t", "REG_SZ", "/d", `"${exe}"`, "/f"];
}

/**
 * "Set up (one restart)": the checks, then the shared install script
 * elevated once. Installed: the resume marker (win: restart) and the RunOnce
 * value (`exe`: this app). The admin prompt cancelled: declined.
 */
export async function windowsInstall({ home, env = process.env, run = runCommand, exe = process.versions.electron ? process.execPath : null, tmpDir = os.tmpdir(), checks: given = null, now = Date.now(), release = os.release() }: { home: string; env?: NodeJS.ProcessEnv; run?: RunCommand; exe?: string | null; tmpDir?: string; checks?: WindowsChecks | null; now?: number; release?: string }): Promise<SetupEntry> {
  const saved = (entry: Omit<SetupEntry, "at">): SetupEntry => {
    saveSetupState(home, "win", entry, { now });
    return { ...entry, at: now };
  };
  const checks = given ?? await windowsChecks({ run, env, release });
  const decision = setupDecision(checks);
  if (!decision.ok) return saved({ state: "blocked", why: decision.why });
  // The elevated script: in a new folder of its own (a random name, made only for this run) and
  // created there exclusively, so nothing else can put its own script in its place first.
  const dir = mkdtempSync(path.join(tmpDir, "omnirush-wsl-setup-"));
  const ps1 = path.join(dir, "setup.ps1");
  const logFile = path.join(dir, "setup.log");
  let text = "";
  let res: Awaited<ReturnType<RunCommand>> | null = null;
  try {
    writeFileSync(ps1, `${WIN.install_script.join("\r\n")}\r\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    writeFileSync(logFile, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    res = await run(powershellExe(env), elevatedArgs(ps1, logFile), { env, timeoutMs: 30 * 60_000 });
    try { text = readFileSync(logFile, "utf8"); } catch { text = ""; }
    try { if (text.trim()) writeFileSync(installLogFile(home), text, "utf8"); } catch { /* best effort */ }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // No log at all and a failed Start-Process: the admin prompt was answered "No" (or never shown).
  if (!text.trim() && res?.code !== 0) return saved({ state: "declined", message: "The administrator prompt was cancelled; nothing changed." });
  const parsed = parseInstallLog(text);
  if (parsed.result === "blocked") return saved({ state: "blocked", why: parsed.why === "firmware_off" ? blockedWhy(checks) : parsed.why });
  if (parsed.result === "failed") return saved({ state: "failed", message: `The WSL install did not finish: ${parsed.line} (log: ${installLogFile(home)})` });
  if (exe) await run("reg.exe", runOnceArgs(exe), { env, timeoutMs: 15_000 });
  return saved({ state: "restart", message: "WSL 2 is installed. Restart Windows to finish." });
}

/** "Restart now" (never while a chat runs: the route checks). */
export function windowsRestart({ run = runCommand }: { run?: RunCommand } = {}): Promise<unknown> {
  return run("shutdown.exe", ["/r", "/t", "5", "/c", "OmniRush finishes the sandbox setup after the restart."], { timeoutMs: 15_000 });
}

/**
 * The start after the restart (the resume marker): `wsl --update` when WSL
 * asks for it, then the marker goes (the box start imports the distro and
 * downloads the image). WSL still off: the marker stays (no restart yet);
 * WSL 2 unable to start a VM: before the restart (Windows booted before the
 * marker) that is the same text, so it waits; after it the machine is marked
 * as unable, with why (nested_vm when this PC is a VM, else firmware_off).
 * WSL 1 notes in `wsl --status` are not "WSL 2 off".
 */
export async function resumeWinSetup({ home, env = process.env, run = runCommand, log = () => {}, now = Date.now(), bin: given = null, checks = null, bootedAt = now - os.uptime() * 1000, updateWaitMs = RESUME_UPDATE_WAIT_MS, onReady = () => {} }: { home: string; env?: NodeJS.ProcessEnv; run?: RunCommand; log?: (level: "info" | "warn", message: string) => void; now?: number; bin?: string | null; checks?: Partial<WindowsChecks> | null; bootedAt?: number; updateWaitMs?: number; onReady?: (result: ResumeResult) => void }): Promise<ResumeResult> {
  const marker = setupState(home).win;
  if (marker?.state !== "restart") return { ok: false, state: "none" };
  // Before the restart WSL says the same as on a PC that cannot run a VM: only after it does that mean "cannot".
  const restarted = !Number.isFinite(Number(marker.at)) || bootedAt > Number(marker.at);
  const bin = given ?? wslExe({ env });
  if (!bin) return { ok: false, state: "restart" };
  const status = async (): Promise<string> => {
    const res = await wslCall(bin, ["--status"], { run, env, timeoutMs: 30_000 });
    return withoutWsl1Notes(`${res.stdout}\n${res.stderr}`);
  };
  const decide = async (said: string): Promise<ResumeResult> => {
    const noVm = VIRTUALIZATION.test(said) || NO_VM_START.test(said);
    if (restarted && noVm) {
      const why = blockedWhy(checks ?? await windowsChecks({ run, env }).catch(() => null));
      saveSetupState(home, "win", { state: "blocked", why }, { now });
      log("info", `sandbox setup resume: WSL 2 cannot start a VM here (${why})`);
      return { ok: false, state: "blocked", why };
    }
    if ((!restarted && noVm) || /not installed|is not enabled|optional component|WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED/i.test(said)) {
      log("info", "sandbox setup resume: WSL 2 not on yet (restart pending)");
      return { ok: false, state: "restart" };
    }
    saveSetupState(home, "win", null, { now });
    await run("reg.exe", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce", "/v", WIN.resume_run_once, "/f"], { env, timeoutMs: 15_000 });
    log("info", "sandbox setup resumed: WSL 2 ready");
    return { ok: true, state: "ready" };
  };
  const said = await status();
  if (!/wsl --update|requires an update|kernel (?:file|component)|update the wsl/i.test(said)) return decide(said);
  // `wsl --update` can take minutes (a download): waited for up to updateWaitMs, then it goes on in
  // the background and finishes the setup itself (onReady). CLI: win-setup.js, the same.
  log("info", "sandbox setup resume: wsl --update");
  const finishing = wslCall(bin, ["--update", "--web-download"], { run, env, timeoutMs: 10 * 60_000 }).then(async () => decide(await status()));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const waited = await Promise.race([finishing.then((result) => ({ result })), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), updateWaitMs); timer.unref?.(); })]);
  if (timer) clearTimeout(timer);
  if (waited) return waited.result;
  log("info", "sandbox setup resume: wsl --update goes on in the background");
  finishing.then((result) => { if (result.ok) { try { onReady(result); } catch { /* the caller's */ } } }).catch((error) => log("warn", `sandbox setup resume failed: ${error instanceof Error ? error.message : String(error)}`));
  return { ok: false, state: "updating" };
}

export type ResumeResult = { ok: boolean; state: "none" | "restart" | "blocked" | "ready" | "updating"; why?: CannotRunWhy };

/** How long the resume waits for its `wsl --update` before it goes on in the background. */
export const RESUME_UPDATE_WAIT_MS = 2 * 60_000;

// --- Linux (CLI: backends/bwrap.js enableBwrap) ----------------------------------------------

/**
 * The root step `sandbox enable` does, as one shell script for pkexec: $1 is
 * the bubblewrap to install (checked against $2, its sha256), copied
 * root-owned to ENABLED_BWRAP, and the AppArmor profile for that copy only.
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
 * 126 when the prompt was dismissed and 127 when not authorised. Allowed:
 * the linux entry goes; dismissed: declined; else failed, with the line.
 */
export async function linuxAllow({ home, env = process.env, run = runCommand, source = allowSource({ env }), now = Date.now() }: { home: string; env?: NodeJS.ProcessEnv; run?: RunCommand; source?: string | null; now?: number }): Promise<{ ok: boolean; message: string }> {
  if (!source) {
    const message = "No bubblewrap to install: install your system's bubblewrap package, then try again.";
    saveSetupState(home, "linux", { state: "failed", message }, { now });
    return { ok: false, message };
  }
  const staged = path.join(home, "setup-bwrap");
  mkdirSync(home, { recursive: true });
  copyFileSync(source, staged);
  const sum = createHash("sha256").update(readFileSync(staged)).digest("hex");
  const pkexec = String(env.OMNIRUSH_BOX_PKEXEC || "").trim() || "pkexec";
  const res = await run(pkexec, ["/bin/sh", "-c", linuxAllowScript(), "omnirush-sandbox-allow", staged, sum], { timeoutMs: 10 * 60_000 });
  rmSync(staged, { force: true });
  const said = `${res.stdout}\n${res.stderr}`.trim().split("\n").filter(Boolean).pop()?.slice(0, 300) ?? "";
  if (res.code === 0) {
    saveSetupState(home, "linux", null, { now });
    return { ok: true, message: said ? `Allowed (${said}).` : "Allowed." };
  }
  if (res.code === 126) {
    const message = "The password prompt was dismissed; nothing changed.";
    saveSetupState(home, "linux", { state: "declined", message }, { now });
    return { ok: false, message };
  }
  const message = res.error === "ENOENT" ? "pkexec is missing here: run `sudo omnirush sandbox enable` in a terminal instead (OmniRush CLI)."
    : res.code === 127 ? `Not authorised${said ? `: ${said}` : ""}.`
    : said || `The step stopped (${res.code}).`;
  saveSetupState(home, "linux", { state: "failed", message }, { now });
  return { ok: false, message };
}

/** "Update WSL" (WSL asks for an update): `wsl --update`, which asks for admin itself when it needs to. */
export async function windowsUpdate({ env = process.env, run = runCommand }: { env?: NodeJS.ProcessEnv; run?: RunCommand } = {}): Promise<{ ok: boolean }> {
  const bin = wslExe({ env });
  if (!bin) return { ok: false };
  const res = await wslCall(bin, ["--update", "--web-download"], { run, env, timeoutMs: 10 * 60_000 });
  return { ok: res.code === 0 };
}
