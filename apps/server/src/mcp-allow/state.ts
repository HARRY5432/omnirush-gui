// The desktop's side of the MCP allowlist (mcp-allow.mjs is the shared part).
//
// <state>/mcp/policy.json      the server's `mcp` block as last seen (GET /collect/capabilities)
// <state>/mcp/reports/         the engine plugin's report per project (allowed and blocked servers)
// <state>/mcp/workspaces/      the MCP entries a project added in the app (runtime config), per project
//
// The engine gets the three paths in its environment; its plugin
// (opencode-plugins/omnirush-mcp-policy.ts) reads them at each project's start.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  evaluateMcp,
  readPolicyFile,
  readReport,
  reportPath,
  writePolicyFile,
  type McpDecision,
  type McpPolicy,
  type McpReport,
} from "./mcp-allow.mjs";

export const MCP_OFF_MESSAGE = "MCP servers are turned off for this account.";

export function mcpStateDir(stateDir: string): string {
  return path.join(stateDir, "mcp");
}

export function mcpPolicyFile(stateDir: string): string {
  return path.join(mcpStateDir(stateDir), "policy.json");
}

export function mcpReportDir(stateDir: string): string {
  return path.join(mcpStateDir(stateDir), "reports");
}

export function mcpWorkspaceDir(stateDir: string): string {
  return path.join(mcpStateDir(stateDir), "workspaces");
}

/** The engine's environment for its MCP plugin. */
export function mcpEngineEnv(stateDir: string): Record<string, string> {
  return {
    OMNIRUSH_MCP_POLICY_FILE: mcpPolicyFile(stateDir),
    OMNIRUSH_MCP_REPORT_DIR: mcpReportDir(stateDir),
    OMNIRUSH_MCP_WORKSPACE_DIR: mcpWorkspaceDir(stateDir),
  };
}

/** The policy as last seen; null: MCP off (never seen, or unreadable). */
export function currentMcpPolicy(stateDir: string): McpPolicy | null {
  return readPolicyFile(mcpPolicyFile(stateDir));
}

export function mcpPolicyEnabled(stateDir: string): boolean {
  return currentMcpPolicy(stateDir)?.enabled === true;
}

/** Why MCP is off, in the server's words when it gave some. */
export function mcpOffMessage(stateDir: string): string {
  return currentMcpPolicy(stateDir)?.message ?? MCP_OFF_MESSAGE;
}

function rawBlock(stateDir: string): string {
  try {
    const value = JSON.parse(readFileSync(mcpPolicyFile(stateDir), "utf8"));
    return JSON.stringify(value?.policy ?? null);
  } catch {
    return "missing";
  }
}

/**
 * Remembers the `mcp` block of a capabilities answer; whether it changed. No
 * answer (null) keeps the last one; an answer without the block is MCP off.
 */
export function rememberMcpPolicy(stateDir: string, capabilities: { mcp?: unknown } | null | undefined): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const block = capabilities.mcp && typeof capabilities.mcp === "object" && !Array.isArray(capabilities.mcp) ? capabilities.mcp : null;
  const before = rawBlock(stateDir);
  if (before === JSON.stringify(block)) return false;
  try {
    writePolicyFile(mcpPolicyFile(stateDir), block);
  } catch {
    return false;
  }
  return true;
}

/** Re-reads the capabilities every `everyMs` and remembers the block; `apply` runs on a change. Returns the stop. */
export function watchMcpPolicy({ stateDir, read, apply, everyMs }: { stateDir: string; read: () => Promise<{ mcp?: unknown } | null | undefined>; apply?: () => unknown; everyMs: number }): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void read()
      .then((capabilities) => (rememberMcpPolicy(stateDir, capabilities) ? apply?.() : undefined))
      .catch(() => undefined)
      .finally(() => { busy = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The file with a project's app-added MCP entries (the plugin adds them to the project's config). */
export function workspaceMcpFile(stateDir: string, root: string): string {
  return reportPath(mcpWorkspaceDir(stateDir), root);
}

/** Write (or, with no entries, remove) a project's app-added MCP entries; whether the file changed. */
export function writeWorkspaceMcp(stateDir: string, root: string, entries: Record<string, unknown>): boolean {
  const file = workspaceMcpFile(stateDir, root);
  let before: string | null = null;
  try { before = readFileSync(file, "utf8"); } catch { /* none */ }
  if (Object.keys(entries).length === 0) {
    if (before === null) return false;
    rmSync(file, { force: true });
    return true;
  }
  const next = JSON.stringify({ v: 1, root: path.resolve(root), mcp: entries });
  if (before === next) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { mode: 0o600 });
  renameSync(tmp, file);
  return true;
}

/** A project's app-added MCP entries as the plugin reads them. */
export function readWorkspaceMcp(dir: string | null | undefined, root: string): Record<string, Record<string, unknown>> {
  if (!dir) return {};
  try {
    const value = JSON.parse(readFileSync(reportPath(dir, root), "utf8"));
    const mcp = value?.v === 1 && value.mcp && typeof value.mcp === "object" && !Array.isArray(value.mcp) ? value.mcp : {};
    return Object.fromEntries(Object.entries(mcp).filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1])));
  } catch {
    return {};
  }
}

/** The plugin's last report for a project, or null. */
export function workspaceMcpReport(stateDir: string, root: string): McpReport | null {
  return readReport(mcpReportDir(stateDir), path.resolve(root));
}

/**
 * What the policy says about one entry before it is saved (the add route): the
 * decision for it alone, with no sandbox (paths are checked the same way).
 */
export function decideMcpEntry(stateDir: string, root: string, name: string, entry: Record<string, unknown>): McpDecision {
  const { decisions } = evaluateMcp({ [name]: entry }, currentMcpPolicy(stateDir), { root: path.resolve(root) });
  return decisions[0] ?? { name, status: "blocked", code: "invalid", reason: "This MCP server entry is not valid." };
}

export type McpServerUse = { id: string; package: string; version: string; runtime: string; sandbox: boolean };

/** The servers a session in this project uses (from the plugin's report); null when none is on. */
export function mcpServersInUse(report: McpReport | null): McpServerUse[] | null {
  if (!report || !report.enabled) return null;
  const used = report.decisions
    .filter((decision) => decision.status === "allowed" && decision.id && decision.package && decision.version && decision.runtime)
    .map((decision) => ({
      id: decision.id as string,
      package: decision.package as string,
      version: decision.version as string,
      runtime: decision.runtime as string,
      sandbox: decision.sandbox === true,
    }));
  return used.length ? used : null;
}
