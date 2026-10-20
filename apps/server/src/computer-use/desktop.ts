/**
 * Computer use in the desktop app: the server switch (GET /collect/capabilities
 * `computer_use`, remembered like web search), the host file Electron main
 * writes when its host listens, the built-in MCP entry the engine's MCP plugin
 * adds (id `computer-use`, reserved), and where frames are spooled.
 *
 * Files, under <runtimeStorageDir>/computer-use/ (OMNIRUSH_COMPUTER_USE_DIR in
 * the engine's environment):
 *   server.json        the switch as last seen
 *   host.json          { command, environment } of the running host (Electron main)
 *   media-spool/       frames the host took (media.mjs createMediaSpool)
 *   media-index/       per-chat media index (media.mjs createMediaIndex)
 *
 * On, in this order: OMNIRUSH_COMPUTER_USE=1/0 in the environment, then the
 * server's block, else off (policy.mjs computerUseSetting).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SERVER_ID } from "./shared/contract.mjs";
import { computerUseSetting, type ComputerUseSetting } from "./shared/policy.mjs";

export const COMPUTER_USE_DIR_ENV = "OMNIRUSH_COMPUTER_USE_DIR";
/** How long an MCP call may take (an open-session waits for the person). */
export const COMPUTER_USE_MCP_TIMEOUT_MS = 300_000;

export type ComputerUseHostFile = { command: string[]; environment: Record<string, string> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}

export function computerUseDir(stateDir: string): string {
  return join(stateDir, "computer-use");
}
export function mediaSpoolDir(stateDir: string): string {
  return join(computerUseDir(stateDir), "media-spool");
}
export function mediaIndexDir(stateDir: string): string {
  return join(computerUseDir(stateDir), "media-index");
}

/** The engine's environment for its plugins. */
export function computerUseEngineEnv(stateDir: string): Record<string, string> {
  return { [COMPUTER_USE_DIR_ENV]: computerUseDir(stateDir) };
}

/** The block as last seen (null: never seen). */
export function rememberedComputerUseBlock(dir: string): Record<string, unknown> | null {
  const value = readJson(join(dir, "server.json"));
  return isRecord(value) && isRecord(value.block) ? value.block : null;
}

/**
 * Remembers the `computer_use` block of a /collect/capabilities answer (a
 * missing block is off; null, no answer, keeps the last). Whether it changed.
 */
export function rememberComputerUseSwitch(stateDir: string, capabilities: unknown): boolean {
  if (!stateDir || !isRecord(capabilities)) return false;
  const dir = computerUseDir(stateDir);
  const block = isRecord(capabilities.computer_use) ? capabilities.computer_use : null;
  const before = readJson(join(dir, "server.json"));
  const beforeBlock = isRecord(before) && "block" in before ? before.block : undefined;
  try {
    writeJson(join(dir, "server.json"), { block, at: Date.now() });
  } catch {
    return false;
  }
  return JSON.stringify(beforeBlock ?? null) !== JSON.stringify(block);
}

/** Computer use for this desktop now. */
export function computerUseSettingFor(dir: string, env: Record<string, string | undefined> = process.env, platform = process.platform): ComputerUseSetting {
  return computerUseSetting({ env, block: rememberedComputerUseBlock(dir) ?? undefined, client: "desktop", platform });
}

/** The running host's MCP command, as Electron main wrote it. */
export function readHostFile(dir: string): ComputerUseHostFile | null {
  const value = readJson(join(dir, "host.json"));
  if (!isRecord(value) || !Array.isArray(value.command) || !value.command.every((part) => typeof part === "string") || value.command.length < 1) return null;
  const environment = isRecord(value.environment) ? Object.fromEntries(Object.entries(value.environment).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  return { command: value.command, environment };
}

/** Writes (or, with null, removes) the host file. Whether it changed. */
export function writeHostFile(dir: string, host: ComputerUseHostFile | null): boolean {
  const before = JSON.stringify(readHostFile(dir));
  if (host) writeJson(join(dir, "host.json"), host);
  else rmSync(join(dir, "host.json"), { force: true });
  return before !== JSON.stringify(host ? readHostFile(dir) : null);
}

/**
 * The built-in servers for the MCP plugin: `computer-use` when it is on and
 * the host runs; the id stays reserved (null) otherwise, so a config entry
 * with that name is always left out.
 */
export function computerUseBuiltins(dir: string | null | undefined, env: Record<string, string | undefined> = process.env): Record<string, Record<string, unknown> | null> {
  if (!dir) return { [SERVER_ID]: null };
  const setting = computerUseSettingFor(dir, env);
  const host = setting.enabled && setting.real_screen ? readHostFile(dir) : null;
  if (!host || !existsSync(host.command[0] ?? "")) return { [SERVER_ID]: null };
  return { [SERVER_ID]: { type: "local", command: host.command, environment: host.environment, enabled: true, timeout: COMPUTER_USE_MCP_TIMEOUT_MS, title: "Computer use" } };
}

/** The desktop's approval mode as the shared rules name it. */
export function permissionModeName(mode: string | null | undefined): "careful" | "normal" | "auto" {
  return mode === "careful" ? "careful" : mode === "full" || mode === "auto" ? "auto" : "normal";
}

/**
 * The chat a computer use call belongs to: the latest prompted chat that is
 * still running (MCP calls carry no chat id). `mark` at every prompt
 * dispatch; `resolve` with the engine's running sessions.
 */
export function createChatTracker(limit = 64) {
  const order: string[] = [];
  return {
    mark(sessionId: string): void {
      const at = order.indexOf(sessionId);
      if (at >= 0) order.splice(at, 1);
      order.push(sessionId);
      if (order.length > limit) order.splice(0, order.length - limit);
    },
    resolve(running: string[] | null): string | null {
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const id = order[i];
        if (id && (!running || running.includes(id))) return id;
      }
      return order.at(-1) ?? null;
    },
  };
}

/** The `environment.computer_use` envelope field of a chat that used computer use. */
export type ComputerUseEnvironment = { enabled: true; host: "native" | "virtual"; os: string; screens: Array<{ id: string; width: number; height: number; scale: number }> };

/** A `computer.session` event from the host, checked before it reaches a trace. */
export function sessionEventOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const events = ["opened", "approved", "denied", "paused", "continued", "stopped", "closed", "expired"];
  const by = ["person", "agent", "limit", "server"];
  if (typeof value.event !== "string" || !events.includes(value.event) || typeof value.by !== "string" || !by.includes(value.by)) return null;
  const out: Record<string, unknown> = { event: value.event, by: value.by };
  for (const key of ["session_id", "app_id", "app_name", "bundle_or_exe", "mode", "approval", "os", "reason"]) {
    if (typeof value[key] === "string" && String(value[key]).length <= 4096) out[key] = value[key];
  }
  if (value.reused === true) out.reused = true;
  if (isRecord(value.screen)) {
    const s = value.screen;
    out.screen = { id: String(s.id ?? ""), width: Number(s.width) || 0, height: Number(s.height) || 0, scale: Number(s.scale) || 1 };
  }
  if (isRecord(value.virtual)) out.virtual = value.virtual;
  return out;
}
