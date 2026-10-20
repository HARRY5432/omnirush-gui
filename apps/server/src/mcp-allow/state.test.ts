import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import omnirushMcpPolicy from "../opencode-plugins/omnirush-mcp-policy.js";
import { keyOf } from "../box/plugin-lib.js";
import { readPolicyFile } from "./mcp-allow.mjs";
import {
  decideMcpEntry,
  mcpEngineEnv,
  mcpPolicyEnabled,
  mcpServersInUse,
  readWorkspaceMcp,
  rememberMcpPolicy,
  workspaceMcpReport,
  writeWorkspaceMcp,
} from "./state.js";
import policyFixture from "./mcp-policy.fixture.json" with { type: "json" };

const dirs: string[] = [];
const saved = { ...process.env };
function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ["OMNIRUSH_MCP_POLICY_FILE", "OMNIRUSH_MCP_REPORT_DIR", "OMNIRUSH_MCP_WORKSPACE_DIR", "OMNIRUSH_BOX_HOME"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const FILESYSTEM = { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."], enabled: true };

describe("the remembered MCP list", () => {
  test("is off until seen, follows each answer, and keeps the last one when no answer came", () => {
    const state = temp("mcp-state-");
    expect(mcpPolicyEnabled(state)).toBe(false);
    expect(rememberMcpPolicy(state, null)).toBe(false);
    expect(rememberMcpPolicy(state, { mcp: policyFixture })).toBe(true);
    expect(rememberMcpPolicy(state, { mcp: policyFixture })).toBe(false);
    expect(mcpPolicyEnabled(state)).toBe(true);
    expect(readPolicyFile(mcpEngineEnv(state).OMNIRUSH_MCP_POLICY_FILE)?.allow.map((entry) => entry.id)).toContain("filesystem");
    // A failed read says nothing: the last list stays.
    expect(rememberMcpPolicy(state, undefined)).toBe(false);
    expect(mcpPolicyEnabled(state)).toBe(true);
    // A backend that sends no block: MCP off.
    expect(rememberMcpPolicy(state, { schema_versions: [1, 2] } as { mcp?: unknown })).toBe(true);
    expect(mcpPolicyEnabled(state)).toBe(false);
  });

  test("decides one entry before it is saved", () => {
    const state = temp("mcp-state-");
    const root = temp("mcp-root-");
    expect(decideMcpEntry(state, root, "filesystem", FILESYSTEM)).toMatchObject({ status: "blocked", code: "disabled" });
    rememberMcpPolicy(state, { mcp: policyFixture });
    expect(decideMcpEntry(state, root, "filesystem", FILESYSTEM)).toMatchObject({ status: "allowed", id: "filesystem", version: "2026.8.31" });
    expect(decideMcpEntry(state, root, "gh", { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-github"] })).toMatchObject({ status: "blocked", code: "denied" });
    expect(decideMcpEntry(state, root, "notion", { type: "remote", url: "https://mcp.notion.com/mcp" })).toMatchObject({ status: "blocked", code: "remote" });
  });

  test("a project's app-added entries round-trip, and none removes the file", () => {
    const state = temp("mcp-state-");
    const root = temp("mcp-root-");
    expect(writeWorkspaceMcp(state, root, { filesystem: FILESYSTEM })).toBe(true);
    expect(writeWorkspaceMcp(state, root, { filesystem: FILESYSTEM })).toBe(false);
    expect(readWorkspaceMcp(mcpEngineEnv(state).OMNIRUSH_MCP_WORKSPACE_DIR, root)).toEqual({ filesystem: FILESYSTEM });
    expect(writeWorkspaceMcp(state, root, {})).toBe(true);
    expect(readWorkspaceMcp(mcpEngineEnv(state).OMNIRUSH_MCP_WORKSPACE_DIR, root)).toEqual({});
  });
});

describe("the engine plugin (omnirush-mcp-policy)", () => {
  function setup() {
    const state = temp("mcp-state-");
    const root = temp("mcp-root-");
    const env = mcpEngineEnv(state);
    Object.assign(process.env, env);
    process.env.OMNIRUSH_BOX_HOME = path.join(state, "box-home");
    return { state, root };
  }

  test("without a list: no MCP at all, and the session environment gets no field", async () => {
    const { state, root } = setup();
    const hooks = await omnirushMcpPolicy({ directory: root });
    const output = { mcp: { filesystem: FILESYSTEM } } as Record<string, unknown>;
    await hooks.config({}, output);
    expect(output.mcp).toEqual({});
    const report = workspaceMcpReport(state, root);
    expect(report?.enabled).toBe(false);
    expect(report?.decisions[0]).toMatchObject({ name: "filesystem", status: "blocked", code: "disabled" });
    expect(mcpServersInUse(report)).toBeNull();
  });

  test("with the list: config and app-added entries are filtered, renamed to their id and pinned", async () => {
    const { state, root } = setup();
    rememberMcpPolicy(state, { mcp: policyFixture });
    writeWorkspaceMcp(state, root, { files: FILESYSTEM, notion: { type: "remote", url: "https://mcp.notion.com/mcp" } });
    const hooks = await omnirushMcpPolicy({ directory: root });
    const output = { mcp: { time: { type: "local", command: ["uvx", "mcp-server-time"] }, script: { type: "local", command: ["node", "server.js"] } } } as Record<string, unknown>;
    await hooks.config({}, output);
    const mcp = output.mcp as Record<string, { command: string[] }>;
    expect(Object.keys(mcp).sort()).toEqual(["filesystem", "time"]);
    const npx = ["npx", "--prefix", path.join(process.env.OMNIRUSH_MCP_REPORT_DIR!, "..", "npx-prefix"), "-y"];
    expect(mcp.filesystem!.command).toEqual([...npx, "@modelcontextprotocol/server-filesystem@2026.8.31", "."]);
    expect(mcp.time!.command).toEqual(["uvx", "--no-config", "mcp-server-time@2026.8.18"]);
    const report = workspaceMcpReport(state, root);
    const byName = Object.fromEntries((report?.decisions ?? []).map((decision) => [decision.name, decision]));
    expect(byName.script).toMatchObject({ status: "blocked", code: "unknown_command" });
    expect(byName.notion).toMatchObject({ status: "blocked", code: "remote" });
    expect(byName.files).toMatchObject({ status: "allowed", renamed_to: "filesystem", sandbox: false });
    expect(mcpServersInUse(report)).toEqual([
      { id: "time", package: "mcp-server-time", version: "2026.8.18", runtime: "pypi", sandbox: false, enabled: true },
      { id: "filesystem", package: "@modelcontextprotocol/server-filesystem", version: "2026.8.31", runtime: "npm", sandbox: false, enabled: true },
    ]);
  });

  test("a server the user turned off is listed, marked enabled: false", async () => {
    const { state, root } = setup();
    rememberMcpPolicy(state, { mcp: policyFixture });
    writeWorkspaceMcp(state, root, { files: { ...FILESYSTEM, enabled: false } });
    const hooks = await omnirushMcpPolicy({ directory: root });
    const output = { mcp: {} } as Record<string, unknown>;
    await hooks.config({}, output);
    const report = workspaceMcpReport(state, root);
    expect(report?.decisions[0]?.enabled).toBe(false);
    expect(mcpServersInUse(report)).toEqual([{ id: "filesystem", package: "@modelcontextprotocol/server-filesystem", version: "2026.8.31", runtime: "npm", sandbox: false, enabled: false }]);
  });

  test("a project whose sandbox is on runs its servers through the box shell", async () => {
    const { state, root } = setup();
    rememberMcpPolicy(state, { mcp: policyFixture });
    const home = process.env.OMNIRUSH_BOX_HOME!;
    const key = keyOf(root);
    mkdirSync(path.join(home, "boxes"), { recursive: true });
    mkdirSync(path.join(home, "shell"), { recursive: true });
    writeFileSync(path.join(home, "desktop-projects.json"), JSON.stringify({ keys: [key] }));
    writeFileSync(path.join(home, "boxes", `${key}.json`), JSON.stringify({ state: "running", croot: "/work" }));
    writeFileSync(path.join(home, "shell", process.platform === "win32" ? "bash.exe" : "bash"), "");
    const hooks = await omnirushMcpPolicy({ directory: root });
    const output = { mcp: { filesystem: FILESYSTEM } } as Record<string, unknown>;
    await hooks.config({}, output);
    const entry = (output.mcp as Record<string, { command: string[]; environment: Record<string, string> }>).filesystem!;
    expect(entry.command[0]).toBe(path.join(home, "shell", process.platform === "win32" ? "bash.exe" : "bash"));
    expect(entry.command.slice(1)).toEqual(["-c", "mkdir -p /tmp/omnirush-mcp-npx && exec npx --prefix /tmp/omnirush-mcp-npx -y @modelcontextprotocol/server-filesystem@2026.8.31 ."]);
    expect(entry.environment).toEqual({ OMNIRUSH_BOX_KEY: key });
    expect(mcpServersInUse(workspaceMcpReport(state, root))?.[0]?.sandbox).toBe(true);
  });

  test("playwright refuses pages away from this machine", async () => {
    const { state, root } = setup();
    rememberMcpPolicy(state, { mcp: policyFixture });
    const hooks = await omnirushMcpPolicy({ directory: root });
    await hooks.config({}, { mcp: { playwright: { type: "local", command: ["npx", "@playwright/mcp"] } } });
    await expect(hooks["tool.execute.before"]({ tool: "playwright_browser_navigate" }, { args: { url: "https://example.com" } })).rejects.toThrow(/this machine only/);
    await hooks["tool.execute.before"]({ tool: "playwright_browser_navigate" }, { args: { url: "http://localhost:3000" } });
    // Other tools are untouched.
    await hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "curl https://example.com" } });
    const reports = mcpEngineEnv(state).OMNIRUSH_MCP_REPORT_DIR;
    expect(readFileSync(path.join(reports, readdirSync(reports)[0] ?? ""), "utf8")).toContain("playwright");
  });
});

