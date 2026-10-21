import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { OmniRushMcpPolicyView, OmniRushMcpPreset } from "../src/app/lib/omnirush-server";
import type { McpServerEntry } from "../src/app/types";
import {
  MCP_BLOCKED_HINTS,
  MCP_ENGINE_V2_NOTE,
  MCP_REMOTE_NOT_SUPPORTED,
  McpSupportedPanel,
  mcpServerState,
  presetCommandLine,
  presetConfigured,
  needsSignIn,
} from "../src/react-app/domains/settings/pages/mcp-supported-panel";

const filesystem: OmniRushMcpPreset = {
  id: "filesystem",
  title: "Filesystem",
  why: "Reads and writes files in the project.",
  runtime: "npm",
  package: "@modelcontextprotocol/server-filesystem",
  version: "2026.8.31",
  versions: ">=2025.1.14",
  command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
  localPagesOnly: false,
};
const sqlite: OmniRushMcpPreset = { ...filesystem, id: "sqlite", title: "SQLite", why: null, package: "mcp-server-sqlite-npx", version: "0.8.0", command: ["npx", "-y", "mcp-server-sqlite-npx", "data.db"] };

function policy(overrides: Partial<OmniRushMcpPolicyView> = {}): OmniRushMcpPolicyView {
  return { mode: "allowlist", enabled: true, message: null, engineV2: false, supported: [filesystem, sqlite], decisions: [], reportAt: null, ...overrides };
}

const render = (props: Partial<Parameters<typeof McpSupportedPanel>[0]> = {}) => renderToStaticMarkup(
  <McpSupportedPanel
    policy={policy()}
    servers={[]}
    canAdd
    busy={false}
    addPreset={async () => ({ ok: true })}
    {...props}
  />,
);

const server = (name: string, config: Record<string, unknown> = { type: "local", command: ["npx", "x"] }, source: McpServerEntry["source"] = "config.remote"): McpServerEntry => ({ name, config: config as McpServerEntry["config"], source });

describe("Settings > MCP: supported servers", () => {
  test("MCP off: one calm line, in the server's words when it gave some", () => {
    const off = render({ policy: policy({ enabled: false, mode: "disabled", message: null, supported: [] }) });
    expect(off).toContain("MCP servers are turned off for this account.");
    expect(off).not.toContain("mcp-supported-panel");
    expect(render({ policy: policy({ enabled: false, message: "Paused while we update the list." }) })).toContain("Paused while we update the list.");
  });

  test("presets show what they are, the command they add, and the version they run", () => {
    const html = render();
    expect(html).toContain("Filesystem");
    expect(html).toContain("Reads and writes files in the project.");
    expect(html).toContain("npx -y @modelcontextprotocol/server-filesystem .");
    expect(html).toContain("npx -y mcp-server-sqlite-npx data.db");
    expect(html).toContain("Runs @modelcontextprotocol/server-filesystem@2026.8.31");
    expect(html).toContain(MCP_REMOTE_NOT_SUPPORTED);
    expect(html).toContain(">Add<");
  });

  test("configured servers: on with version and sandbox, blocked with the reason (not an error), or pending", () => {
    const html = render({
      servers: [server("filesystem"), server("notion", { type: "remote", url: "https://mcp.notion.com/mcp" }), server("time", { type: "local", command: ["uvx", "mcp-server-time"] }, "config.project")],
      policy: policy({
        decisions: [
          { name: "filesystem", status: "allowed", code: "allowed", id: "filesystem", package: "@modelcontextprotocol/server-filesystem", version: "2026.8.31", sandbox: true },
          { name: "notion", status: "blocked", code: "remote", reason: "Remote MCP servers are not supported." },
        ],
      }),
    });
    expect(html).toContain("On</span> · @modelcontextprotocol/server-filesystem@2026.8.31 · runs in the sandbox");
    expect(html).toContain("Blocked</span> · Remote MCP servers are not supported.");
    expect(html).toContain("Checked when the project&#x27;s next chat starts.");
    expect(html).toContain("From the project&#x27;s opencode.json");
    expect(html).not.toContain("text-red-11");
    // Blocked reads as a warning, not an error, and the remote hint is not said twice.
    expect(html).toContain('text-warning">Blocked');
    expect(html).not.toContain(MCP_BLOCKED_HINTS.remote);
    // The configured preset says Added instead of offering it again.
    expect(html).toMatch(/data-testid="mcp-preset-filesystem".*Added/s);
  });

  test("the preview engine: MCP stays off there, and nothing is offered", () => {
    const html = render({ policy: policy({ engineV2: true }), canAdd: false });
    expect(html).toContain(MCP_ENGINE_V2_NOTE);
    expect(html).not.toContain(">Add<");
  });

  test("a blocked row says why and what to do", () => {
    expect(mcpServerState(server("gh"), { name: "gh", status: "blocked", code: "denied", reason: "The GitHub server works on your GitHub account." }))
      .toEqual({ kind: "blocked", reason: "The GitHub server works on your GitHub account.", hint: "Not on the supported list." });
    expect(mcpServerState(server("x"), { name: "x", status: "blocked", code: "not_allowed", reason: "This MCP server is not on the supported list." }))
      .toMatchObject({ hint: null });
    expect(mcpServerState(server("x"), { name: "x", status: "blocked", code: "unknown_command", reason: "The app cannot tell which MCP server this is." }))
      .toMatchObject({ hint: "Start it with npx or uvx." });
    expect(mcpServerState(server("x"), { name: "x", status: "blocked", code: "unknown_command", reason: "The app cannot tell which MCP server this is. Start it with npx (npm packages) or uvx (Python packages) and the package name." }))
      .toMatchObject({ hint: null });
    expect(mcpServerState(server("x"), { name: "x", status: "blocked", code: "outside_project", reason: "This MCP server may only use files inside the project folder. (/etc)" }))
      .toMatchObject({ hint: "Point it at a folder or file inside the project." });
  });

  test("backticks in a preset's description show as inline code", () => {
    const html = render({ policy: policy({ supported: [{ ...filesystem, why: "Answers `now` in any time zone." }] }) });
    expect(html).toContain("<code");
    expect(html).toContain(">now</code>");
    expect(html).not.toContain("`");
  });

  test("what the project's own config could not load is said in the panel", () => {
    const line = "Not loaded from this project's config: plugins evil.ts.";
    const shown = line.replace(/'/g, "&#x27;");
    expect(render({ policy: policy({ ignoredNotice: line }) })).toContain(shown);
    expect(render({ policy: policy({ enabled: false, ignoredNotice: line }) })).toContain(shown);
    expect(render()).not.toContain("mcp-project-code-ignored");
    const providers = "Not loaded from this project's config: model provider settings. A project's own plugins, tools, commands and providers could run code just by opening it; the built-in language servers and formatters still work, and your own (user-level) settings apply as usual.";
    expect(render({ policy: policy({ ignored: [{ kind: "provider", name: "provider", source: "/repo/opencode.json" }], ignoredNotice: providers }) })).toContain("model provider settings");
  });

  test("a missing runner says how to fix it", () => {
    expect(mcpServerState(server("x"), { name: "x", status: "blocked", code: "runner_missing", reason: "npx or uvx was not found on this computer outside the project folder, so the server does not start." }))
      .toMatchObject({ hint: "Install Node.js (for npx) or uv (for uvx), then restart the app." });
  });

  test("a server that needs a newer engine says to update", () => {
    expect(mcpServerState(server("x"), { name: "x", status: "blocked", code: "engine_update", reason: "This MCP server needs a newer engine; update OmniRush to use it." }))
      .toEqual({ kind: "blocked", reason: "This MCP server needs a newer engine; update OmniRush to use it.", hint: null });
  });

  test("helpers", () => {
    expect(presetCommandLine({ command: ["uvx", "mcp-server-git", "--repository", "my repo"] })).toBe("uvx mcp-server-git --repository 'my repo'");
    expect(presetConfigured(filesystem, [], [{ name: "files", status: "allowed", code: "allowed", id: "filesystem" }])).toBe(true);
    expect(presetConfigured(filesystem, [server("other")], [])).toBe(false);
    expect(mcpServerState(server("x", { type: "local", command: ["npx", "x"], enabled: false }), { name: "x", status: "allowed", code: "allowed" })).toEqual({ kind: "off" });
    expect(mcpServerState(server("x"), null)).toEqual({ kind: "pending" });
  });

  test("Figma: listed apart as an account server, with its address or command and how to set it up", () => {
    const desk: OmniRushMcpPreset = { ...filesystem, id: "figma", title: "Figma (desktop app)", why: "Reads designs through the Figma desktop app.", runtime: "remote", package: "figma-dev-mode", version: null, command: [], url: "http://127.0.0.1:3845/mcp", oauth: false, setup: "In the Figma desktop app, turn on the MCP server.", account: true };
    const remote: OmniRushMcpPreset = { ...desk, title: "Figma (remote)", package: "figma-remote", url: "https://mcp.figma.com/mcp", oauth: true, setup: "Sign in on the Figma card." };
    const key: OmniRushMcpPreset = { ...filesystem, id: "figma", title: "Figma (API key)", why: null, package: "figma-developer-mcp", version: "0.13.2", command: ["npx", "-y", "figma-developer-mcp"], setup: "Set FIGMA_API_KEY in your environment.", account: true };
    const html = render({ policy: policy({ supported: [filesystem, desk, remote, key] }) });
    expect(html).toContain("mcp-account-servers");
    expect(html).toContain("Servers that use your account");
    expect(html).toContain("http://127.0.0.1:3845/mcp");
    expect(html).toContain("https://mcp.figma.com/mcp");
    expect(html).toContain("npx -y figma-developer-mcp");
    expect(html).toContain("mcp-setup-figma-figma-dev-mode");
    expect(html).toContain("Set FIGMA_API_KEY in your environment.");
    expect(html).toContain("never in a config file");
    // Three routes of one id: each is its own row; one being on marks only that route added.
    const on = [{ name: "figma", status: "allowed" as const, code: "allowed", id: "figma", package: "figma-remote", runtime: "remote" as const, url: "https://mcp.figma.com/mcp", oauth: true }];
    expect(presetConfigured(remote, [server("figma")], on)).toBe(true);
    expect(presetConfigured(desk, [server("figma")], on)).toBe(false);
    expect(presetCommandLine(desk)).toBe("http://127.0.0.1:3845/mcp");
    // The configured remote server offers its sign-in; the desktop app's server does not need one.
    expect(needsSignIn(on[0])).toBe(true);
    expect(needsSignIn({ ...on[0], oauth: false, package: "figma-dev-mode" })).toBe(false);
    const signed = render({ policy: policy({ supported: [remote], decisions: on }), servers: [server("figma", { type: "remote", url: "https://mcp.figma.com/mcp" })], signIn: () => undefined });
    expect(signed).toContain("mcp-sign-in-figma");
    expect(signed).toContain("https://mcp.figma.com/mcp");
    expect(render({ policy: policy({ supported: [remote], decisions: on }), servers: [server("figma", { type: "remote", url: "https://mcp.figma.com/mcp" })] })).not.toContain("mcp-sign-in-figma");
    expect(MCP_BLOCKED_HINTS.secret_missing).toContain("environment");
    // An entry holding one of the app's keys: the refusal says why, the hint what to change.
    const held = mcpServerState(server("mem"), { name: "mem", status: "blocked", code: "protected_value", reason: "This MCP server entry holds one of the app's own keys (in its command, variables or folder), so it does not start." });
    expect(held).toEqual({ kind: "blocked", reason: "This MCP server entry holds one of the app's own keys (in its command, variables or folder), so it does not start.", hint: MCP_BLOCKED_HINTS.protected_value });
  });

  test("a missing MCP filter: one clear warning (no MCP server starts), enabled or not", () => {
    const warning = "The MCP filter did not load, so no MCP servers start in this app (none run unfiltered).";
    expect(render({ policy: policy({ filterMissing: warning }) })).toContain("mcp-filter-missing");
    expect(render({ policy: policy({ enabled: false, mode: "disabled", filterMissing: warning }) })).toContain(warning);
    expect(render()).not.toContain("mcp-filter-missing");
  });
});
