// Engine plugin: MCP servers follow the server's list (mcp-allow/mcp-allow.mjs,
// the same module as the CLI's). Loaded last, so no plugin before it can add
// servers after the list was applied.
//
// - config: the project's MCP entries (its config files, plus the ones added
//   in the app: OMNIRUSH_MCP_WORKSPACE_DIR) are replaced by the allowed ones,
//   keyed by their id, pinned, paths checked, and run in the project's sandbox
//   when it is on. The report (OMNIRUSH_MCP_REPORT_DIR) says which and why.
// - tool.execute.before: servers limited to local pages refuse other pages.
//
// No policy file (OMNIRUSH_MCP_POLICY_FILE missing or unreadable): no MCP.
// The engine calls every function a plugin module exports: export only the plugin.
import { existsSync } from "node:fs";
import path from "node:path";

import { createMcpPolicyHooks, type McpBox } from "../mcp-allow/mcp-allow.mjs";
import { readWorkspaceMcp } from "../mcp-allow/state.js";
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
      // Fails closed: an error while applying the list leaves no servers at all.
      await hooks.config(configInput, output);
    },
    "tool.execute.before": hooks["tool.execute.before"],
  };
}
