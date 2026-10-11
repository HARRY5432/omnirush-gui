import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

// Whatever reaches the stored config, a registry launch of omnirush-ui-mcp
// (desktop 1.0.x wrote `npx -y omnirush-ui-mcp`) must never be accepted by a
// write route or handed to the engine.

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
      if (url.pathname === "/session/status") return Response.json({});
      if (url.pathname === "/instance/dispose") return Response.json(true);
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  const pushedNames = () => requests
    .filter((entry) => entry.method === "POST" && entry.pathname === "/mcp")
    .map((entry) => (entry.body as { name?: string } | null)?.name);
  return { baseUrl: `http://127.0.0.1:${server.port}`, pushedNames };
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

describe("complete MCP ban at the HTTP and runtime boundaries", () => {
  test("POST /workspace/:id/mcp refuses every configured server and nothing reaches the engine", async () => {
    const { config, engine } = await fixture();
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
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "mcp_disabled" });
    }
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp).toBeUndefined();
    expect(engine.pushedNames()).toEqual([]);
  });

  test("PATCH /workspace/:id/config refuses MCP config before it is stored", async () => {
    const { config, engine } = await fixture();
    const { call } = await start(config, engine.baseUrl);

    const response = await call("PATCH", "/workspace/ws_1/config", {
      opencode: { mcp: { "omnirush-ui": LEGACY, "user-tool": SAFE } },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mcp_disabled" });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp).toBeUndefined();

    const provider = await call("PATCH", "/workspace/ws_1/config", {
      opencode: { provider: { "user-provider": { npm: "@ai-sdk/openai" } } },
    });
    expect(provider.status).toBe(200);
  });

  test("enabling a stored one over HTTP is refused and not pushed", async () => {
    const { config, engine } = await fixture();
    await seedRuntimeRow(config, "ws_1", { mcp: { "omnirush-ui": { ...LEGACY, enabled: false } } });
    const { call } = await start(config, engine.baseUrl);

    const response = await call("POST", "/workspace/ws_1/mcp/omnirush-ui/enabled", { enabled: true });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mcp_disabled" });
    expect(engine.pushedNames()).toEqual([]);
  });

  test("legacy stored rows are hidden from runtime delivery and injected config", async () => {
    const { config, engine } = await fixture();
    await seedRuntimeRow(config, "ws_1", { mcp: { "omnirush-ui": LEGACY, "user-tool": SAFE } });
    await seedRuntimeRow(config, ENGINE_GLOBAL_RUNTIME_CONFIG_ID, {
      mcp: { "global-ui": { type: "local", command: ["sh", "-c", "npx -y omnirush-ui-mcp"] }, "global-tool": SAFE },
    });
    await start(config, engine.baseUrl);

    await syncAllWorkspacesRuntimeMcpToEngine(config);
    expect(engine.pushedNames()).toEqual([]);

    expect((await readEffectiveRuntimeOpencodeConfig(config, "ws_1")).mcp).toBeUndefined();
    await writeOmniRushRuntimeConfigFile(config);
    const injected = JSON.parse(await readFile(omnirushRuntimeConfigFilePath(config), "utf8")) as { mcp?: Record<string, unknown> };
    expect(injected.mcp).toEqual({});

    // The raw legacy row remains readable only so removal/credential cleanup
    // can repair it; runtime and engine boundaries never expose it.
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.["omnirush-ui"]).toEqual(LEGACY);
  });
});
