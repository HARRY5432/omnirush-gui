import { describe, expect, test } from "bun:test";
import { ApiError } from "./errors.js";
import {
  assertMcpAllowed,
  mcpAllowed,
  mcpPolicyForConfig,
} from "./mcp-policy.js";

describe("MCP execution policy", () => {
  test("fails closed for bare and legacy-shaped configurations", () => {
    expect(mcpPolicyForConfig({})).toBe("disabled");
    expect(mcpPolicyForConfig({ mcpPolicy: "enabled" })).toBe("disabled");
    expect(mcpAllowed({})).toBe(false);
    expect(mcpAllowed({ mcpPolicy: "disabled" })).toBe(false);
    expect(mcpAllowed({ mcpPolicy: "enabled" })).toBe(false);
    expect(() => assertMcpAllowed({})).toThrow(ApiError);
    expect(() => assertMcpAllowed({ mcpPolicy: "disabled" })).toThrow(ApiError);
    expect(() => assertMcpAllowed({ mcpPolicy: "enabled" })).toThrow(ApiError);
  });
});
