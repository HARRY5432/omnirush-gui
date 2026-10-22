// Ported from the CLI (omnirush-cli src/box/required.js); keep the two in
// step. required.json (the rules and the texts) is the same file in both,
// listed in PARITY.sha256.
//
// The mandatory sandbox: a server answer with `local_box.required: true`
// puts every new chat in the project's box. What stays out: chats started on
// this machine before (kept_old_chat), projects that only build on this OS
// (host_only), OMNIRUSH_BOX=0 (env_off), and machines where the box cannot
// run (the `required_fallback` answer; the setup screen says why).

import { closeSync, openSync, readSync, readdirSync, type Dirent } from "node:fs";
import path from "node:path";

import { HOST_BUILD_RULES } from "./host-builds.js";
import rules from "./required.json" with { type: "json" };

export type RequiredFallback = "native" | "native_uncounted";
export type RequiredReason = "box" | "kept_old_chat" | "host_only" | "env_off" | "setup_needed" | "cannot_run" | "setup_declined";
export type CannotRunWhy = keyof typeof rules.texts.why;
type HostOnlyPattern = { name?: string; suffix?: string; contains: string };
type HostOnlyRules = { dirs_suffix: string[]; files: string[]; file_patterns: HostOnlyPattern[] };

export const REQUIRED_RULES = rules;

/** The fallback a server answer names (`required_fallback`), else the default. */
export function requiredFallback(value: unknown): RequiredFallback {
  return value === "native" || value === "native_uncounted" ? value : "native";
}

/** A desktop text of required.json with its `{name}` parts filled in. */
export function desktopText(key: keyof typeof rules.texts.desktop, vars: Record<string, string> = {}): string {
  return fill(rules.texts.desktop[key], vars);
}

/** Why the box cannot run here, in words (required.json texts.why). */
export function whyText(why: string | null | undefined): string | null {
  if (!why) return null;
  const texts: Record<string, string> = rules.texts.why;
  return texts[why] ?? null;
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (all, name: string) => vars[name] ?? all);
}

/** Read at most `max` bytes of a file as text (empty when it cannot be read). */
function head(file: string, max = 256 * 1024): string {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.toString("utf8", 0, n);
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function entries(dir: string, read: (dir: string) => Dirent[]): Dirent[] {
  try {
    return read(dir);
  } catch {
    return [];
  }
}

/**
 * A project that only builds on this OS (an Xcode project on macOS; a WPF,
 * WinForms or MAUI app, a C++ .vcxproj on Windows): the markers it has (the
 * project root and one level down), else null. Linux: never.
 */
export function hostOnlyProject(root: string, { platform = process.platform, readDir = (dir: string) => readdirSync(dir, { withFileTypes: true }), readHead = head }: { platform?: string; readDir?: (dir: string) => Dirent[]; readHead?: (file: string) => string } = {}): { things: string[]; notice: string } | null {
  const table: Record<string, HostOnlyRules> = { darwin: rules.host_only.darwin, win32: rules.host_only.win32 };
  const set = table[platform];
  if (!set) return null;
  const things: string[] = [];
  const look = (dir: string, depth: number) => {
    for (const entry of entries(dir, readDir)) {
      if (things.length >= 3) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (set.dirs_suffix.some((suffix) => entry.name.endsWith(suffix))) things.push(entry.name);
        else if (depth === 0 && !entry.name.startsWith(".") && entry.name !== "node_modules") look(full, 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (set.files.includes(entry.name)) { things.push(entry.name); continue; }
      const pattern = set.file_patterns.find((p) => (p.name ? entry.name === p.name : p.suffix ? entry.name.endsWith(p.suffix) : false));
      if (pattern && new RegExp(pattern.contains).test(readHead(full))) things.push(entry.name);
    }
  };
  look(root, 0);
  if (!things.length) return null;
  const host = HOST_BUILD_RULES.hosts[platform];
  return { things, notice: desktopText("host_only", { label: host?.label ?? platform, things: things.join(", "), machine: host?.machine ?? "this computer" }) };
}

/** What a Windows machine says about running WSL 2 (PowerShell CIM, the build, S mode). */
export type WindowsFacts = {
  build: number | null;
  hypervisorPresent: boolean | null;
  firmwareEnabled: boolean | null;
  /** Win32_ComputerSystem Model / Manufacturer (a VM guest names its hypervisor). */
  model: string | null;
  sMode: boolean | null;
  /** WSL's own output (`wsl --status`, the setup log), checked for a virtualization error. */
  wslSaid?: string | null;
  /** WSL is blocked by policy (the setup log, `wsl` output). */
  policy?: boolean;
};

const VM_MODEL = /virtual machine|vmware|virtualbox|kvm|qemu|hvm domu|parallels|xen|bochs/i;

/**
 * Why WSL 2 cannot run on this Windows (required.json texts.why keys), or
 * null when nothing rules it out. A running hypervisor is a pass (the
 * firmware flag reads false while Hyper-V runs).
 */
export function windowsWhy(facts: WindowsFacts): CannotRunWhy | null {
  if (facts.sMode) return "s_mode";
  if (facts.build !== null && facts.build < rules.setup.win32.min_build) return "old_windows";
  if (facts.policy) return "policy";
  const vmError = Boolean(facts.wslSaid && virtualizationError(facts.wslSaid));
  if (facts.hypervisorPresent === true && !vmError) return null;
  if (facts.firmwareEnabled === false || vmError) return facts.model && VM_MODEL.test(facts.model) ? "nested_vm" : "firmware_off";
  return null;
}

/** Whether WSL's output is one of its "no virtualization" errors. */
export function virtualizationError(text: string): boolean {
  return new RegExp(rules.setup.win32.virtualization_errors, "i").test(text);
}

/** The PowerShell that reads the facts windowsWhy needs (one JSON line). */
export const WINDOWS_FACTS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1",
  "$cs = Get-CimInstance Win32_ComputerSystem",
  "$s = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy' -Name SkuPolicyRequired).SkuPolicyRequired",
  "[pscustomobject]@{ build = [Environment]::OSVersion.Version.Build; hypervisor = $cs.HypervisorPresent; firmware = $cpu.VirtualizationFirmwareEnabled; model = \"$($cs.Manufacturer) $($cs.Model)\"; smode = ($s -eq 1) } | ConvertTo-Json -Compress",
].join("; ");

/** The facts from WINDOWS_FACTS_SCRIPT's output (unknown fields: null). */
export function parseWindowsFacts(stdout: string): WindowsFacts {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(stdout).trim().split("\n").pop() ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = Object.fromEntries(Object.entries(parsed));
  } catch { /* nothing known */ }
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  return {
    build: typeof value.build === "number" ? value.build : null,
    hypervisorPresent: bool(value.hypervisor),
    firmwareEnabled: bool(value.firmware),
    model: typeof value.model === "string" ? value.model.trim() || null : null,
    sMode: bool(value.smode),
  };
}

/** The elevated setup script (required.json setup.win32.install_script) as a .ps1 file's text. */
export function windowsInstallScript(): string {
  return `${rules.setup.win32.install_script.join("\r\n")}\r\n`;
}
