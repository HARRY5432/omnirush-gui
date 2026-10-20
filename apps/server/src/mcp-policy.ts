import { ApiError } from "./errors.js";
import { runtimeStorageDir } from "./runtime-db.js";
import { currentMcpPolicy, MCP_OFF_MESSAGE } from "./mcp-allow/state.js";
import type { ServerConfig } from "./types.js";

/**
 * MCP servers follow the server's list (GET /collect/capabilities `mcp`, as
 * last seen; mcp-allow/): on when the list is on, else off. Only local
 * servers on the list reach the engine (its plugin filters them).
 */
export type McpPolicyMode = "allowlist" | "disabled";

export const MCP_DISABLED_MESSAGE = MCP_OFF_MESSAGE;

/** Account-linked MCP (Connect, managed OAuth connections, MCP apps): never on in this app. */
export const MCP_ACCOUNT_LINKED_MESSAGE =
  "Connected MCP services work on an outside account, so a session could not be repeated: they are not supported in OmniRush.ai. Supported local servers are listed in Settings > MCP.";

function stateDirOf(config: unknown): string | null {
  try {
    return config && typeof config === "object" ? runtimeStorageDir(config as ServerConfig) : null;
  } catch {
    return null;
  }
}

export function mcpPolicyForConfig(config: unknown): McpPolicyMode {
  return mcpAllowed(config) ? "allowlist" : "disabled";
}

export function mcpAllowed(config: unknown): boolean {
  const dir = stateDirOf(config);
  return dir ? currentMcpPolicy(dir)?.enabled === true : false;
}

export function mcpDisabledMessage(config: unknown): string {
  const dir = stateDirOf(config);
  return (dir ? currentMcpPolicy(dir)?.message : null) ?? MCP_DISABLED_MESSAGE;
}

export function assertMcpAllowed(config: unknown): void {
  if (!mcpAllowed(config)) throw new ApiError(403, "mcp_disabled", mcpDisabledMessage(config));
}

/** Account-linked MCP flows stay off whatever the list says. */
export function refuseAccountLinkedMcp(): never {
  throw new ApiError(403, "mcp_account_linked", MCP_ACCOUNT_LINKED_MESSAGE);
}
