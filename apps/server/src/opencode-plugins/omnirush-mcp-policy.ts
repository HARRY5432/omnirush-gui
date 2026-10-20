// Engine plugin: MCP servers follow the server's list (mcp-allow/mcp-allow.mjs,
// the same module as the CLI's). Loaded last, so no plugin before it can add
// servers after the list was applied.
//
// - config: the project's MCP entries (its config files, plus the ones added
//   in the app: OMNIRUSH_MCP_WORKSPACE_DIR) are replaced by the allowed ones,
//   keyed by their id, pinned, paths checked, and run in the project's sandbox
//   when it is on. The report (OMNIRUSH_MCP_REPORT_DIR) says which and why.
// - tool.execute.before: servers limited to local pages refuse other pages.
// - computer use (computer-use/desktop.ts): the app's built-in `computer-use`
//   server is added when it is on (its id is always reserved), sub-agents get
//   no computer tools, and old screenshots of computer tools are pruned from
//   what the model is sent (the stored chat is untouched).
//
// No policy file (OMNIRUSH_MCP_POLICY_FILE missing or unreadable): no MCP.
// The engine calls every function a plugin module exports: export only the plugin.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createMcpPolicyHooks, reportPath, type McpBox } from "../mcp-allow/mcp-allow.mjs";
import { readWorkspaceMcp } from "../mcp-allow/state.js";
import { computerUseBuiltins, COMPUTER_USE_DIR_ENV } from "../computer-use/desktop.js";
import { isComputerTool, SERVER_ID } from "../computer-use/shared/contract.mjs";
import { pruneImages } from "../computer-use/shared/media.mjs";
import { SCREEN_BASH_RULES, subagentPermissionRules } from "../computer-use/shared/policy.mjs";
import { boxHome, desktopProjects, keyOf, record } from "../box/plugin-lib.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The same choice of target as the shared hooks (both engine hook shapes).
function configTarget(input: unknown, output: unknown): Record<string, unknown> | null {
  if (isRecord(output) && (Object.hasOwn(output, "mcp") || !isRecord(input))) return output;
  return isRecord(input) ? input : isRecord(output) ? output : null;
}

/** The project's sandbox when the desktop has it on: its shell (boxsh), key and folder in the box. */
function boxFor(root: string): McpBox | null {
  const key = keyOf(root);
  if (!desktopProjects().keys.has(key)) return null;
  const rec = record(key);
  if (!rec || rec.state === "off") return null;
  const shell = path.join(boxHome(), "shell", process.platform === "win32" ? "bash.exe" : "bash");
  if (!existsSync(shell)) return null;
  return { shell, key, croot: typeof rec.croot === "string" ? rec.croot : null };
}

const SUBAGENTS = ["general", "explore"];

/**
 * With computer use on, shell commands that capture the screen or inject input
 * ask (policy.mjs SCREEN_BASH_RULES), in the modes whose shell rules ask at
 * all (Normal, Careful); Auto's single allow is left as it is.
 */
function withScreenBashRules(permission: Record<string, unknown>): Record<string, unknown> {
  const bash = permission.bash;
  if (!isRecord(bash) || !Object.values(bash).includes("ask")) return permission;
  const next: Record<string, unknown> = { ...bash };
  for (const [pattern, action] of Object.entries(SCREEN_BASH_RULES)) {
    delete next[pattern];
    next[pattern] = action;
  }
  return { ...permission, bash: next };
}

/** Adds the left-out `computer-use` entry to the project's MCP report (Settings > MCP). */
function reportReserved(root: string): void {
  const dir = process.env.OMNIRUSH_MCP_REPORT_DIR;
  if (!dir) return;
  try {
    const file = reportPath(dir, root);
    const report: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(report) || !Array.isArray(report.decisions)) return;
    report.decisions = [...report.decisions.filter((d) => !(isRecord(d) && d.name === SERVER_ID)), { name: SERVER_ID, status: "blocked", code: "reserved", reason: "This name belongs to the app's built-in computer use; this entry is left out." }];
    const temp = `${file}.${process.pid}.cu.tmp`;
    writeFileSync(temp, JSON.stringify(report), { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    // The report is for display only.
  }
}

/** No computer tools in sub-agents (one host lease per app; v1). */
function withoutSubagentComputerTools(target: Record<string, unknown>): void {
  const agents = isRecord(target.agent) ? { ...target.agent } : {};
  const names = new Set([...SUBAGENTS, ...Object.entries(agents).filter(([, value]) => isRecord(value) && value.mode === "subagent").map(([name]) => name)]);
  for (const name of names) {
    const agent = isRecord(agents[name]) ? { ...agents[name] } : {};
    const permission = typeof agent.permission === "string" ? { "*": agent.permission } : isRecord(agent.permission) ? { ...agent.permission } : {};
    agents[name] = { ...agent, permission: { ...permission, ...subagentPermissionRules() } };
  }
  target.agent = agents;
}

export default async function omnirushMcpPolicy(input?: { directory?: string }) {
  const root = path.resolve(input?.directory || process.cwd());
  const hooks = createMcpPolicyHooks({
    directory: root,
    policyFile: process.env.OMNIRUSH_MCP_POLICY_FILE || null,
    reportDir: process.env.OMNIRUSH_MCP_REPORT_DIR || null,
    box: boxFor,
  });
  return {
    config: async (configInput: unknown, output?: unknown) => {
      const target = configTarget(configInput, output);
      if (target) {
        try {
          const added = readWorkspaceMcp(process.env.OMNIRUSH_MCP_WORKSPACE_DIR, root);
          if (Object.keys(added).length) target.mcp = { ...(isRecord(target.mcp) ? target.mcp : {}), ...added };
        } catch {
          // The app-added servers are left out; the config's own still go through the list.
        }
      }
      // The id `computer-use` belongs to the app's built-in server: a config entry with it is left out (and reported).
      const reserved = target && isRecord(target.mcp) && Object.hasOwn(target.mcp, SERVER_ID);
      if (target && reserved && isRecord(target.mcp)) {
        const { [SERVER_ID]: _dropped, ...rest } = target.mcp;
        target.mcp = rest;
      }
      // Fails closed: an error while applying the list leaves no servers at all.
      await hooks.config(configInput, output);
      if (reserved) reportReserved(root);
      const builtin = target ? computerUseBuiltins(process.env[COMPUTER_USE_DIR_ENV])[SERVER_ID] : null;
      if (target && builtin) {
        target.mcp = { ...(isRecord(target.mcp) ? target.mcp : {}), [SERVER_ID]: builtin };
        // The host asks the person itself (never the engine's permission prompts), in every mode.
        const permission: Record<string, unknown> = typeof target.permission === "string" ? { "*": target.permission } : isRecord(target.permission) ? { ...target.permission } : {};
        delete permission[`${SERVER_ID}_*`];
        target.permission = withScreenBashRules({ ...permission, [`${SERVER_ID}_*`]: "allow" });
        if (isRecord(target.agent) && isRecord(target.agent.omnirush) && isRecord(target.agent.omnirush.permission)) {
          target.agent = { ...target.agent, omnirush: { ...target.agent.omnirush, permission: withScreenBashRules({ ...target.agent.omnirush.permission }) } };
        }
        withoutSubagentComputerTools(target);
      }
    },
    // Old screenshots of computer tools leave the model's context in blocks (keep 12, drop 8);
    // compaction requests serialize messages to text and carry no images anyway.
    "experimental.chat.messages.transform": async (_input: unknown, output: { messages?: unknown[] }) => {
      if (Array.isArray(output?.messages)) pruneImages(output.messages, { match: (part: Record<string, unknown>) => isComputerTool(part.tool) });
    },
    "tool.execute.before": hooks["tool.execute.before"],
  };
}
