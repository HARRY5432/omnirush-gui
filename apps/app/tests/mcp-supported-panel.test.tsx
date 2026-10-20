import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { OmniRushMcpPolicyView, OmniRushMcpPreset } from "../src/app/lib/omnirush-server";
import { projectCodeNotice } from "../src/lib/capability-call";
import type { McpServerEntry } from "../src/app/types";
import {
  MCP_BLOCKED_HINTS,
  MCP_ENGINE_V2_NOTE,
  MCP_REMOTE_NOT_SUPPORTED,
  McpSupportedPanel,
  mcpServerState,
  presetCommandLine,
  presetConfigured,
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
    expect(html).toContain('text-amber-11">Blocked');
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

  test("what the project's own config could not load is said once, in the panel and as a notice", () => {
    const line = "Not loaded from this project's config: plugins evil.ts.";
    const shown = line.replace(/'/g, "&#x27;");
    expect(render({ policy: policy({ ignoredNotice: line }) })).toContain(shown);
    expect(render({ policy: policy({ enabled: false, ignoredNotice: line }) })).toContain(shown);
    expect(render()).not.toContain("mcp-project-code-ignored");
    expect(projectCodeNotice("ws_1", line)).toEqual({ id: "project-code-ignored:ws_1", text: line });
    expect(projectCodeNotice("ws_1", line)).toBeNull();
    expect(projectCodeNotice("ws_2", line)).not.toBeNull();
    expect(projectCodeNotice("ws_3", null)).toBeNull();
  });

  test("a missing runner says how to fix it", () => {
    expect(mcpServerState(server("x"), { name: "x", status: "blocked", code: "runner_missing", reason: "npx or uvx was not found on this computer outside the project folder, so the server does not start." }))
      .toMatchObject({ hint: "Install Node.js (for npx) or uv (for uvx), then restart the app." });
  });

  test("helpers", () => {
    expect(presetCommandLine({ command: ["uvx", "mcp-server-git", "--repository", "my repo"] })).toBe("uvx mcp-server-git --repository 'my repo'");
    expect(presetConfigured(filesystem, [], [{ name: "files", status: "allowed", code: "allowed", id: "filesystem" }])).toBe(true);
    expect(presetConfigured(filesystem, [server("other")], [])).toBe(false);
    expect(mcpServerState(server("x", { type: "local", command: ["npx", "x"], enabled: false }), { name: "x", status: "allowed", code: "allowed" })).toEqual({ kind: "off" });
    expect(mcpServerState(server("x"), null)).toEqual({ kind: "pending" });
  });
});
