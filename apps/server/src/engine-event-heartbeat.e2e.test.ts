import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

import { clearEnginePoolForConfig, computeEngineConfigFingerprint, type EngineSpawnTemplate } from "./engine-pool.js";
import type { ManagedOpencodeServer } from "./managed-opencode.js";
import { createEnginePoolForConfig, registerTrustedOpencodeProcess, startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

/**
 * The merged engine event stream must keep quiet-but-healthy connections
 * attestable: SSE comments are invisible to SSE parsers (they only yield
 * frames with data lines), so the keepalive has to be a data-bearing
 * heartbeat event. Otherwise the renderer's stale-stream watchdog cannot
 * tell a healthy silent stream from a dead socket and churns reconnects.
 */

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

function startMockEngine(eventBody?: () => ReadableStream<Uint8Array>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/event" && eventBody) {
        return new Response(eventBody(), { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname === "/event") {
        // Held open and silent like a real engine between task events; ends
        // when the proxy aborts it after its client disconnects.
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname === "/session/status") return Response.json({});
      if (url.pathname === "/session") return Response.json([]);
      if (url.pathname === "/mcp") return Response.json({});
      if (url.pathname === "/instance/dispose") return Response.json({ disposed: true });
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served & { port: number };
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}` };
}

function syntheticManagedHandle(url: string): ManagedOpencodeServer {
  return {
    url,
    username: "event-heartbeat-user",
    password: "event-heartbeat-pass",
    pid: null,
    execution: { command: "opencode", args: [], cwd: "/", env: [] },
    isAlive: () => true,
    close: async () => undefined,
  };
}

async function startPooledOmniRushServer(input: { root: string; engineUrl: string }) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws_heartbeat",
      name: "Heartbeat",
      path: input.root,
      preset: "starter",
      workspaceType: "local",
      baseUrl: input.engineUrl,
    }],
    authorizedRoots: [input.root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  registerTrustedOpencodeProcess(config, {
    baseUrl: input.engineUrl,
    identity: "test-event-heartbeat",
    isAlive: () => true,
  });
  const runtimeConfigPath = join(input.root, ".opencode", "runtime-config.json");
  await writeFile(runtimeConfigPath, "{}\n", "utf8");
  const template: EngineSpawnTemplate = {
    cwd: input.root,
    runtimeConfigPath,
    env: {},
    reservedPorts: () => [],
  };
  const pool = createEnginePoolForConfig({
    config,
    template,
    handle: syntheticManagedHandle(input.engineUrl),
    fingerprint: await computeEngineConfigFingerprint(template),
    registryId: null,
    trustedIdentity: null,
  });
  stops.push(async () => {
    clearEnginePoolForConfig(config);
    await pool.disposeAll();
  });
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, token: config.token };
}

describe("engine event stream heartbeat", () => {
  test("emits data-bearing heartbeats on a quiet stream instead of SSE comments", async () => {
    setEnv("OMNIRUSH_ENGINE_EVENT_HEARTBEAT_MS", "50");
    const root = await mkdtemp(join(tmpdir(), "omnirush-event-heartbeat-"));
    roots.push(root);
    await mkdir(join(root, ".opencode"), { recursive: true });
    const engine = startMockEngine();
    const omnirush = await startPooledOmniRushServer({ root, engineUrl: engine.url });

    const controller = new AbortController();
    const response = await fetch(`${omnirush.base}/workspace/ws_heartbeat/opencode/event`, {
      headers: { Authorization: `Bearer ${omnirush.token}`, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const deadline = Date.now() + 3_000;
    let heartbeats = 0;
    while (Date.now() < deadline && heartbeats < 2) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
      if (chunk === null) continue;
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      heartbeats = (buffered.match(/data: \{"type":"server\.heartbeat"\}/g) ?? []).length;
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);

    // Two heartbeats prove a periodic signal, not a one-shot frame. Comment
    // keepalives would be dropped by SSE parsers before any liveness
    // tracking, so none may remain.
    expect(heartbeats).toBeGreaterThanOrEqual(2);
    expect(buffered).not.toContain(": ping");
  }, 20_000);

  test("closes the stream of a client that stopped reading instead of queueing every event", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-event-backlog-"));
    roots.push(root);
    await mkdir(join(root, ".opencode"), { recursive: true });
    const frame = new TextEncoder().encode(`data: ${JSON.stringify({ type: "message.part.updated", properties: { text: "x".repeat(1024 * 1024) } })}\n\n`);
    let sent = 0;
    const engine = startMockEngine(() => new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < 200) { sent += 1; controller.enqueue(frame); }
      },
    }));
    const omnirush = await startPooledOmniRushServer({ root, engineUrl: engine.url });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    // A window that never reads (frozen): its socket is paused after the request.
    const port = Number(new URL(omnirush.base).port);
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET /workspace/ws_heartbeat/opencode/event HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${omnirush.token}\r\naccept: text/event-stream\r\n\r\n`);
      socket.pause();
    });
    socket.on("error", () => undefined);
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !warnings.some((line) => line.includes("client stopped reading"))) await Bun.sleep(50);
      expect(warnings.some((line) => line.includes("client stopped reading"))).toBe(true);
      // Cut near the cap, not after the whole turn's events were queued.
      expect(sent).toBeLessThan(200);
    } finally {
      console.warn = warn;
      socket.destroy();
    }
  }, 30_000);
});
