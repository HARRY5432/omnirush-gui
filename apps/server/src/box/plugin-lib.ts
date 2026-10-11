// Ported from the CLI (omnirush-cli src/box/plugin-lib.js, feat/local-box);
// keep the two in step. Desktop: types, and desktopProjects() (below).
//
// Helpers of the box engine plugin (opencode-plugins/omnirush-box.ts), apart
// because the engine calls every function a plugin module exports.
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "list", "ls", "apply_patch", "patch", "multiedit"]);

export function boxHome(): string {
  return path.resolve(String(process.env.OMNIRUSH_BOX_HOME || "").trim() || path.join(os.homedir(), ".omnirush", "box"));
}

export function keyOf(dir: string): string {
  let resolved = path.resolve(dir);
  try { resolved = realpathSync.native(resolved); } catch { /* keep */ }
  if (process.platform === "win32") resolved = resolved.toLowerCase();
  return createHash("sha256").update(resolved).digest("hex").slice(0, 12);
}

export function record(key: string): { state?: string; uid?: number } | null {
  try { return JSON.parse(readFileSync(path.join(boxHome(), "boxes", `${key}.json`), "utf8")); } catch { return null; }
}

/**
 * Desktop: the projects whose box the desktop's engine uses
 * (<box home>/desktop-projects.json, written by the desktop server). The CLI
 * shares the box home and its records; a project's record alone (left by a
 * CLI run) never turns the box on for a desktop chat.
 */
export const DESKTOP_PROJECTS_FILE = "desktop-projects.json";

export function desktopProjects(): Set<string> {
  try {
    const value = JSON.parse(readFileSync(path.join(boxHome(), DESKTOP_PROJECTS_FILE), "utf8"));
    return new Set(Array.isArray(value?.keys) ? value.keys.filter((key: unknown): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

export function within(child: string, parent: string): boolean {
  const a = process.platform === "win32" ? child.toLowerCase() : child;
  const b = process.platform === "win32" ? parent.toLowerCase() : parent;
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** The engine's own folders (config, data incl. truncated tool output, cache, state). */
export function engineDirs(): string[] {
  const home = os.homedir();
  const xdg = (name: string, fallback: string[]) => path.join(process.env[name] || path.join(home, ...fallback), "omnirush");
  return [
    xdg("XDG_CONFIG_HOME", [".config"]), xdg("XDG_DATA_HOME", [".local", "share"]),
    xdg("XDG_CACHE_HOME", [".cache"]), xdg("XDG_STATE_HOME", [".local", "state"]),
  ];
}

function patchPaths(text: unknown): string[] {
  const out: string[] = [];
  for (const match of String(text || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) out.push((match[1] || match[2] || "").trim());
  return out;
}

export function toolPaths(tool: string, args: Record<string, unknown> = {}): string[] {
  if (tool === "apply_patch" || tool === "patch") return patchPaths(args.patchText ?? args.patch);
  if (tool === "multiedit") return [args.filePath].filter((value): value is string => typeof value === "string" && Boolean(value));
  return [args.filePath, args.path, args.file_path].filter((value): value is string => typeof value === "string" && Boolean(value));
}

export const BOX_NOTE = (root: string, uid = 0): string => [
  `Sandbox: shell commands run in a Linux (Debian) container, ${uid === 0 ? "as root" : "as a user with passwordless sudo"}, with HOME=/root.`,
  `The project folder ${root} is the same folder inside the container (same path); changes to it are visible on both sides.`,
  "Files outside the project folder (/tmp, HOME, system folders) exist only inside the container: read and change them with shell commands, not with the file tools.",
  "Install what the task needs with the usual package managers (apt-get, pip, npm, cargo, go, ...); installs persist in this project's container across sessions.",
].join("\n");
