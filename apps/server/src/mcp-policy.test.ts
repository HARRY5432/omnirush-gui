import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApiError } from "./errors.js";
import {
  assertMcpAllowed,
  MCP_DISABLED_MESSAGE,
  mcpAllowed,
  mcpDisabledMessage,
  mcpPolicyForConfig,
  refuseAccountLinkedMcp,
} from "./mcp-policy.js";
import { rememberMcpPolicy } from "./mcp-allow/state.js";
import type { ServerConfig } from "./types.js";

const dirs: string[] = [];
function configIn(): { config: ServerConfig; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-policy-"));
  dirs.push(dir);
  return { config: { configPath: path.join(dir, "server.json") } as ServerConfig, dir };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MCP policy", () => {
  test("is off until the server's list was seen", () => {
    const { config } = configIn();
    expect(mcpPolicyForConfig(config)).toBe("disabled");
    expect(mcpAllowed(config)).toBe(false);
    expect(() => assertMcpAllowed(config)).toThrow(ApiError);
    expect(mcpDisabledMessage(config)).toBe(MCP_DISABLED_MESSAGE);
    expect(MCP_DISABLED_MESSAGE).toBe("MCP servers are turned off for this account.");
  });

  test("follows the remembered list", () => {
    const { config, dir } = configIn();
    expect(rememberMcpPolicy(dir, { mcp: { enabled: true, allow: [], deny: [] } })).toBe(true);
    expect(mcpPolicyForConfig(config)).toBe("allowlist");
    expect(mcpAllowed(config)).toBe(true);
    expect(() => assertMcpAllowed(config)).not.toThrow();
    // An answer without the block: off again.
    expect(rememberMcpPolicy(dir, {})).toBe(true);
    expect(mcpAllowed(config)).toBe(false);
  });

  test("the 403 carries the server's message", () => {
    const { config, dir } = configIn();
    rememberMcpPolicy(dir, { mcp: { enabled: false, message: "Paused for maintenance." } });
    try {
      assertMcpAllowed(config);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(403);
      expect((error as ApiError).message).toBe("Paused for maintenance.");
    }
  });

  test("account-linked MCP stays refused", () => {
    expect(() => refuseAccountLinkedMcp()).toThrow(ApiError);
  });
});
