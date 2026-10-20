/**
 * The user's own skill folders (`skills.paths`), kept in the engine config the
 * app writes.
 *
 * The engine merges its config files in order (its global config folder
 * ~/.config/omnirush, then OPENCODE_CONFIG, the file this app writes, then
 * project files and OPENCODE_CONFIG_DIR) and a later file's `skills.paths`
 * replaces an earlier list instead of adding to it. The app's file lists its
 * own skills (the swarm procedure, the Best practices guides), so the folders
 * a user listed in ~/.config/omnirush/opencode.json (the OmniRush CLI's
 * global config too) were dropped. The app's list now carries them after its
 * own.
 * The user's files are only read, never written.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsoncFile } from "./jsonc.js";

/** Larger global config files are not read for skill folders. */
const MAX_CONFIG_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The string entries of a config's `skills.paths`, or undefined when it does not set the key. */
export function configSkillPaths(config: unknown): string[] | undefined {
  if (!isRecord(config) || !isRecord(config.skills) || !Array.isArray(config.skills.paths)) return undefined;
  return config.skills.paths.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/** The engine's own global config folder: <XDG config home>/omnirush (~/.config on every system, as the engine resolves it). */
export function engineGlobalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "omnirush");
}

/**
 * The `skills.paths` of the engine's global config, as the engine takes it:
 * config.json, opencode.json, opencode.jsonc; the last file that sets the key
 * wins. Missing or unreadable files are skipped.
 */
export async function userGlobalSkillPaths(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const dir = engineGlobalConfigDir(env);
  let paths: string[] = [];
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    const file = join(dir, name);
    // Followed like the engine follows it (a dotfile manager's link), and only a file of a sane size.
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size > MAX_CONFIG_BYTES) continue;
    const read = await readJsoncFile<unknown>(file, undefined, { allowInvalid: true }).catch(() => null);
    const listed = configSkillPaths(read?.data);
    if (listed) paths = listed;
  }
  return paths;
}

/** The app's folders first, then the user's, each once. */
export function mergeSkillPaths(own: string[], ...user: (string[] | undefined)[]): string[] {
  return [...new Set([...own, ...user.flatMap((list) => list ?? [])])];
}
