import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { omnirushRuntimeConfigFilePath, writeOmniRushRuntimeConfigFile } from "./omnirush-runtime-config.js";
import {
  ENGINE_GLOBAL_RUNTIME_CONFIG_ID,
  readEffectiveRuntimeOpencodeConfig,
  readRuntimeOpencodeConfig,
  runtimeDbPath,
  writeRuntimeOpencodeConfig,
  type RuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import { registerTrustedOpencodeProcess, startServer, syncAllWorkspacesRuntimeMcpToEngine } from "./server.js";
import type { ServerConfig } from "./types.js";
import { rememberMcpPolicy, workspaceMcpFile } from "./mcp-allow/state.js";
import { runtimeStorageDir } from "./runtime-db.js";
import policyFixture from "./mcp-allow/mcp-policy.fixture.json" with { type: "json" };

// MCP servers follow the server's list: off until it was seen; with it, only
// the supported local servers are stored, and nothing is pushed into a
// running engine (the engine's MCP plugin applies the list). A registry launch
// of omnirush-ui-mcp (desktop 1.0.x wrote `npx -y omnirush-ui-mcp`) is never
// accepted by a write route or handed to the engine.

type EngineRequest = { method: string; pathname: string; body: unknown };

const LEGACY = { type: "local", command: ["npx", "-y", "omnirush-ui-mcp"], enabled: true };
const SAFE = { type: "local", command: ["node", "/opt/tools/mcp.mjs"], enabled: true };

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const previousRuntimeDb = process.env.OMNIRUSH_RUNTIME_DB;
let processGeneration = 0;

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (previousRuntimeDb === undefined) delete process.env.OMNIRUSH_RUNTIME_DB;
  else process.env.OMNIRUSH_RUNTIME_DB = previousRuntimeDb;
});

function startMockEngine() {
  const requests: EngineRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      requests.push({ method: request.method, pathname: url.pathname, body });
      if (url.pathname === "/mcp" && request.method === "POST") {
        const name = (body as { name?: string } | null)?.name ?? "";
        return Response.json({ [name]: { status: "connected" } });
      }
      if (url.pathname === "/mcp") return Response.json({});
      if (url.pathname === "/session/ses_1/prompt_async") return new Response(null, { status: 204 });
      if (url.pathname === "/session/status") return Response.json({});
      if (url.pathname === "/instance/dispose") return Response.json(true);
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  const pushedNames = () => requests
    .filter((entry) => entry.method === "POST" && entry.pathname === "/mcp")
    .map((entry) => (entry.body as { name?: string } | null)?.name);
  const prompts = () => requests.filter((entry) => entry.pathname === "/session/ses_1/prompt_async");
  return { baseUrl: `http://127.0.0.1:${server.port}`, pushedNames, prompts };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnirush-ui-mcp-guard-"));
  roots.push(root);
  process.env.OMNIRUSH_RUNTIME_DB = join(root, "runtime.sqlite");
  const engine = startMockEngine();
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local", baseUrl: engine.baseUrl },
    ],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  return { config, engine };
}

async function start(config: ServerConfig, engineBaseUrl: string) {
  registerTrustedOpencodeProcess(config, {
    baseUrl: engineBaseUrl,
    identity: `omnirush-ui-mcp-guard-${++processGeneration}`,
    isAlive: () => true,
  });
  const server = await startServer(config);
  stops.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { call };
}

/** Stores a row the way desktop 1.0.x left it; the store itself now refuses to. */
async function seedRuntimeRow(config: ServerConfig, workspaceId: string, value: RuntimeOpencodeConfig) {
  await writeRuntimeOpencodeConfig(config, workspaceId, () => ({}));
  const sqlite = new Database(runtimeDbPath(config));
  try {
    sqlite.query("UPDATE runtime_opencode_configs SET config_json = ?, updated_at = ? WHERE workspace_id = ?")
      .run(JSON.stringify(value), Date.now(), workspaceId);
  } finally {
    sqlite.close();
  }
}

function allowList(config: ServerConfig) {
  rememberMcpPolicy(runtimeStorageDir(config), { mcp: policyFixture });
}

describe("MCP allowlist at the HTTP and runtime boundaries", () => {
  test("off until the list was seen: adds are refused and the view says why", async () => {
    const { config, engine } = await fixture();
    const { call } = await start(config, engine.baseUrl);

    const response = await call("POST", "/workspace/ws_1/mcp", {
      name: "filesystem",
      config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."], enabled: true },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mcp_disabled", message: "MCP servers are turned off for this account." });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp).toBeUndefined();

    const view = await (await call("GET", "/workspace/ws_1/mcp")).json() as { mcpPolicy: Record<string, unknown> };
    expect(view.mcpPolicy).toMatchObject({ enabled: false, message: "MCP servers are turned off for this account.", supported: [] });
    expect(engine.pushedNames()).toEqual([]);
  });

  test("with the list: a supported server is stored for the plugin, others are refused with the reason", async () => {
    const { config, engine } = await fixture();
    allowList(config);
    const { call } = await start(config, engine.baseUrl);

    for (const command of [
      ["npx", "-y", "omnirush-ui-mcp"],
      ["bunx", "omnirush-ui-mcp"],
      ["pnpm", "dlx", "omnirush-ui-mcp"],
    ]) {
      const response = await call("POST", "/workspace/ws_1/mcp", {
        name: "omnirush-ui",
        config: { type: "local", command, enabled: true },
      });
      // Refused before the list is even consulted (a registry launch of the bundled UI server).
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "unsafe_mcp_command" });
    }
    const unlisted = await call("POST", "/workspace/ws_1/mcp", {
      name: "tool",
      config: { type: "local", command: ["npx", "-y", "some-unlisted-mcp"], enabled: true },
    });
    expect(unlisted.status).toBe(403);
    expect(await unlisted.json()).toMatchObject({ code: "mcp_not_supported", details: { code: "not_allowed" } });
    const remote = await call("POST", "/workspace/ws_1/mcp", {
      name: "notion",
      config: { type: "remote", url: "https://mcp.notion.com/mcp", enabled: true },
    });
    expect(remote.status).toBe(403);
    expect(await remote.json()).toMatchObject({ code: "mcp_not_supported", details: { code: "remote" } });
    const outside = await call("POST", "/workspace/ws_1/mcp", {
      name: "filesystem",
      config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/etc"], enabled: true },
    });
    expect(outside.status).toBe(403);
    expect(await outside.json()).toMatchObject({ details: { code: "outside_project" } });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp).toBeUndefined();

    const filesystem = { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."], enabled: true };
    const added = await call("POST", "/workspace/ws_1/mcp", { name: "filesystem", config: filesystem });
    expect(added.status).toBe(200);
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp).toEqual({ filesystem });
    const file = JSON.parse(await readFile(workspaceMcpFile(runtimeStorageDir(config), config.workspaces[0]!.path), "utf8")) as { mcp: Record<string, unknown> };
    expect(file.mcp).toEqual({ filesystem });
    // Nothing goes into the running engine: its MCP plugin applies the list when the project reloads.
    expect(engine.pushedNames()).toEqual([]);

    const view = await (await call("GET", "/workspace/ws_1/mcp")).json() as { items: Array<{ name: string }>; mcpPolicy: { enabled: boolean; supported: Array<{ id: string; command: string[] }> } };
    expect(view.mcpPolicy.enabled).toBe(true);
    expect(view.items.map((item) => item.name)).toEqual(["filesystem"]);
    expect(view.mcpPolicy.supported.find((preset) => preset.id === "filesystem")?.command).toEqual(["npx", "-y", "@modelcontextprotocol/server-filesystem", "."]);
    expect(view.mcpPolicy.supported.find((preset) => preset.id === "sqlite")?.command).toEqual(["npx", "-y", "mcp-server-sqlite-npx", "data.db"]);

    const removed = await call("DELETE", "/workspace/ws_1/mcp/filesystem");
    expect(removed.status).toBe(200);
    await expect(readFile(workspaceMcpFile(runtimeStorageDir(config), config.workspaces[0]!.path), "utf8")).rejects.toThrow();
  });

  test("PATCH /workspace/:id/config refuses MCP config before it is stored", async () => {
    const { config, engine } = await fixture();
    allowList(config);
    const { call } = await start(config, engine.baseUrl);

    const response = await call("PATCH", "/workspace/ws_1/config", {
      opencode: { mcp: { "omnirush-ui": LEGACY, "user-tool": SAFE } },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mcp_config_patch" });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp).toBeUndefined();

    const provider = await call("PATCH", "/workspace/ws_1/config", {
      opencode: { provider: { "user-provider": { npm: "@ai-sdk/openai" } } },
    });
    expect(provider.status).toBe(200);
  });

  test("enabling a stored registry launch is refused and not pushed", async () => {
    const { config, engine } = await fixture();
    await seedRuntimeRow(config, "ws_1", { mcp: { "omnirush-ui": { ...LEGACY, enabled: false } } });
    const { call } = await start(config, engine.baseUrl);

    const off = await call("POST", "/workspace/ws_1/mcp/omnirush-ui/enabled", { enabled: true });
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ code: "mcp_disabled" });

    allowList(config);
    const on = await call("POST", "/workspace/ws_1/mcp/omnirush-ui/enabled", { enabled: true });
    expect(on.status).toBe(400);
    expect(await on.json()).toMatchObject({ code: "unsafe_mcp_command" });
    expect(engine.pushedNames()).toEqual([]);
  });

  test("account-linked flows and runtime engine adds stay refused", async () => {
    const { config, engine } = await fixture();
    allowList(config);
    const { call } = await start(config, engine.baseUrl);

    for (const [method, path] of [
      ["POST", "/workspace/ws_1/mcp/managed"],
      ["GET", "/workspace/ws_1/mcp-apps/list"],
      ["GET", "/workspace/ws_1/mcp/omnirush-cloud/health"],
    ] as const) {
      const response = await call(method, path, method === "POST" ? {} : undefined);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "mcp_account_linked" });
    }
    const add = await call("POST", "/workspace/ws_1/opencode/mcp", { name: "x", config: SAFE });
    expect(add.status).toBe(403);
    expect(await add.json()).toMatchObject({ code: "engine_mcp_managed" });
    const auth = await call("POST", "/workspace/ws_1/opencode/mcp/x/auth", {});
    expect(auth.status).toBe(403);
    expect(await auth.json()).toMatchObject({ code: "mcp_account_linked" });
    const list = await call("GET", "/workspace/ws_1/opencode/mcp");
    expect(list.status).toBe(200);
    for (const path of ["/workspace/ws_1/opencode/config", "/workspace/ws_1/opencode/global/config"]) {
      const write = await call("PATCH", path, { mcp: { x: SAFE } });
      expect(write.status).toBe(403);
      expect(await write.json()).toMatchObject({ code: "engine_config_private" });
    }
    expect(engine.pushedNames()).toEqual([]);
  });

  test("legacy stored rows are never pushed, and registry launches never reach the plugin's file", async () => {
    const { config, engine } = await fixture();
    allowList(config);
    await seedRuntimeRow(config, "ws_1", { mcp: { "omnirush-ui": LEGACY, "user-tool": SAFE } });
    await seedRuntimeRow(config, ENGINE_GLOBAL_RUNTIME_CONFIG_ID, {
      mcp: { "global-ui": { type: "local", command: ["sh", "-c", "npx -y omnirush-ui-mcp"] }, "global-tool": SAFE },
    });
    await start(config, engine.baseUrl);

    await syncAllWorkspacesRuntimeMcpToEngine(config);
    expect(engine.pushedNames()).toEqual([]);
    const file = JSON.parse(await readFile(workspaceMcpFile(runtimeStorageDir(config), config.workspaces[0]!.path), "utf8")) as { mcp: Record<string, unknown> };
    // The plugin applies the list to "user-tool" (a bare script: blocked, with the reason in its report).
    expect(Object.keys(file.mcp)).toEqual(["user-tool"]);

    expect((await readEffectiveRuntimeOpencodeConfig(config, "ws_1")).mcp).toBeUndefined();
    await writeOmniRushRuntimeConfigFile(config);
    const injected = JSON.parse(await readFile(omnirushRuntimeConfigFilePath(config), "utf8")) as { mcp?: Record<string, unknown> };
    expect(injected.mcp).toBeUndefined();

    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.["omnirush-ui"]).toEqual(LEGACY);
  });

  test("MCP servers left in the user's own config do not block prompts", async () => {
    const { config, engine } = await fixture();
    const root = config.workspaces[0]!.path;
    const globalDir = join(root, "global-opencode");
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, "opencode.jsonc"), `// written by another tool\n${JSON.stringify({ mcp: { blender: SAFE } })}`);
    await writeFile(join(root, "opencode.json"), JSON.stringify({ mcp: { supabase: SAFE } }));
    await seedRuntimeRow(config, "ws_1", { mcp: { "omnirush-ui": LEGACY } });
    const saved = {
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
      OMNIRUSH_DEV_MODE: process.env.OMNIRUSH_DEV_MODE,
      OMNIRUSH_SESSION_UPLOAD_OPTIONAL: process.env.OMNIRUSH_SESSION_UPLOAD_OPTIONAL,
    };
    stops.push(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    process.env.OPENCODE_CONFIG_DIR = globalDir;
    process.env.OMNIRUSH_DEV_MODE = "1";
    process.env.OMNIRUSH_SESSION_UPLOAD_OPTIONAL = "1";
    const { call } = await start(config, engine.baseUrl);

    // The engine's MCP plugin applies the list to these entries; the prompt itself runs.
    const response = await call("POST", "/workspace/ws_1/opencode/session/ses_1/prompt_async", {
      parts: [{ type: "text", text: "Fix the build" }],
    });
    expect(response.status).toBe(204);
    expect(engine.prompts()).toHaveLength(1);
    expect(engine.pushedNames()).toEqual([]);
  });
});
