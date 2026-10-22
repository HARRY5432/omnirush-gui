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
 * WinForms or MAUI app, a C++ .vcxproj on Windows): its markers, the root
 * first, then one level down (CLI: required.js hostOnly), else null. Linux:
 * never. Bounded: a couple of directory reads and a few small files.
 */
export function hostOnlyProject(root: string, { platform = process.platform, readDir = (dir: string) => readdirSync(dir, { withFileTypes: true }), readHead = head, maxFiles = 40 }: { platform?: string; readDir?: (dir: string) => Dirent[]; readHead?: (file: string) => string; maxFiles?: number } = {}): { things: string[]; notice: string } | null {
  const table: Record<string, HostOnlyRules> = { darwin: rules.host_only.darwin, win32: rules.host_only.win32 };
  const set = table[platform];
  if (!set) return null;
  const things: string[] = [];
  let read = 0;
  const contains = (file: string, pattern: string) => {
    if (read >= maxFiles) return false;
    read += 1;
    return new RegExp(pattern).test(readHead(file));
  };
  const check = (dir: string, prefix: string) => {
    for (const entry of entries(dir, readDir)) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && set.dirs_suffix.some((suffix) => entry.name.endsWith(suffix))) { things.push(rel); continue; }
      if (!entry.isFile()) continue;
      if (set.files.includes(entry.name)) { things.push(rel); continue; }
      for (const pattern of set.file_patterns) {
        const named = pattern.name ? entry.name === pattern.name : pattern.suffix ? entry.name.endsWith(pattern.suffix) : false;
        if (named && contains(path.join(dir, entry.name), pattern.contains)) { things.push(rel); break; }
      }
    }
  };
  check(root, "");
  for (const entry of entries(root, readDir)) {
    if (things.length > 0) break;
    if (entry.isDirectory() && !entry.name.startsWith(".") && !rules.shadows.skip_dirs.includes(entry.name) && !set.dirs_suffix.some((suffix) => entry.name.endsWith(suffix))) check(path.join(root, entry.name), entry.name);
  }
  if (!things.length) return null;
  const host = HOST_BUILD_RULES.hosts[platform];
  return { things, notice: desktopText("host_only", { label: host?.label ?? platform, things: things.slice(0, 3).join(", "), machine: host?.machine ?? "this computer" }) };
}
