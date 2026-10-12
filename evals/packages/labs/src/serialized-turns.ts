import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

export type SerializedTurnLab = {
  baseUrl: string;
  controlUrl: string;
  token: string;
  stop(): Promise<void>;
};
const TOKEN = "owt_synthetic_serialized_turn";
const ROOT = "ses_serialized_root";
const CHILD = "ses_serialized_child";
const GRANDCHILD = "ses_serialized_grandchild";
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function runtime(): Promise<SerializedTurnLab> {
  const { serve } = await import("bun");
  const { startServer } = await import("../../../../apps/server/src/server.js");
  const dir = await mkdtemp(join(tmpdir(), "serialized-turn-lab-"));
  const root = join(dir, "project");
  await mkdir(root);
  await writeFile(join(root, "README.md"), "Synthetic project\n");
  process.env.OMNIRUSH_DATA_DIR = join(dir, "data");
  process.env.OMNIRUSH_CAPTURE_CONTEXT = "0";
  const ids = [ROOT, CHILD, GRANDCHILD];
  const parents = new Map([[CHILD, ROOT], [GRANDCHILD, CHILD]]);
  const histories = new Map<string, unknown[]>(ids.map(id => [id, []]));
  const busy = new Set<string>();
  const aborts: string[] = [];
  const prompts: Array<{ sessionId: string; body: unknown }> = [];
  const envelopes: unknown[] = [];
  let failStop: string | null = null;
  let hideActivity = false;
  let delayedPrompt = false;
  const engine = serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/control/")) {
      if (request.headers.get("authorization") !== "Bearer " + TOKEN) return Response.json({}, { status: 401 });
      const action = url.pathname.slice("/control/".length);
      const body: unknown = request.method === "POST" ? await request.json() : {};
      if (action === "state" && record(body)) {
        if (Array.isArray(body.busy)) { busy.clear(); for (const id of body.busy) if (typeof id === "string") busy.add(id); }
        if ("failStop" in body) failStop = typeof body.failStop === "string" ? body.failStop : null;
        if ("hideActivity" in body) hideActivity = body.hideActivity === true;
        if ("delayedPrompt" in body) delayedPrompt = body.delayedPrompt === true;
        if (body.runningTool === true) histories.set(GRANDCHILD, [{
          info: { id: "tool-message", role: "assistant" },
          parts: [{ type: "tool", tool: "write", state: { status: "running" } }],
        }]);
        return Response.json({ ok: true });
      }
      if (action === "complete") {
        for (const id of ids) {
          const history = histories.get(id)!;
          const last = history.at(-1);
          if (record(last) && record(last.info) && last.info.role === "user") {
            history.push({ info: { id: "answer-" + prompts.length, role: "assistant", parentID: last.info.id, finish: "stop", time: { completed: Date.now() } }, parts: [{ type: "text", text: "Done." }] });
          }
        }
        busy.clear();
        return Response.json({ ok: true });
      }
      if (action === "witness") return Response.json({ prompts, aborts, envelopes });
      return Response.json({}, { status: 404 });
    }
    if (url.pathname === "/session/status") return hideActivity
      ? Response.json({}, { status: 503 })
      : Response.json(Object.fromEntries([...busy].map(id => [id, { type: "busy" }])));
    const match = url.pathname.match(/^\/session\/([^/]+)(?:\/(.+))?$/);
    if (match) {
      const id = match[1]!;
      if (!ids.includes(id)) return Response.json({}, { status: 404 });
      const action = match[2];
      if (!action) return Response.json({ id, directory: root, ...(parents.has(id) ? { parentID: parents.get(id) } : {}) });
      if (action === "children") return Response.json(ids.filter(child => parents.get(child) === id).map(child => ({ id: child, parentID: id, directory: root })));
      if (action === "message" && request.method === "GET") return Response.json(histories.get(id));
      if (action === "abort") {
        aborts.push(id);
        if (failStop === id) return Response.json({}, { status: 500 });
        busy.delete(id);
        const history = histories.get(id)!;
        for (const item of history) if (record(item) && Array.isArray(item.parts)) {
          for (const part of item.parts) if (record(part) && part.type === "tool" && record(part.state)) part.state.status = "error";
        }
        const last = history.at(-1);
        if (record(last) && record(last.info) && last.info.role === "user") history.push({
          info: { id: "stopped-" + prompts.length, role: "assistant", parentID: last.info.id, error: { name: "MessageAbortedError" } }, parts: [],
        });
        return Response.json(true);
      }
      if (["prompt", "prompt_async", "command", "shell", "message"].includes(action ?? "")) {
        const body: unknown = await request.json();
        prompts.push({ sessionId: id, body });
        if (!delayedPrompt) {
          histories.get(id)!.push({ info: { id: "user-" + prompts.length, role: "user" }, parts: record(body) && Array.isArray(body.parts) ? body.parts : [] });
          busy.add(id);
        }
        return new Response(null, { status: 204 });
      }
      if (action === "revert") return Response.json({ id });
    }
    return Response.json({});
  } });
  const gateway = serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/omnirush/collect") {
      envelopes.push(JSON.parse(zstdDecompressSync(Buffer.from(await request.arrayBuffer())).toString("utf8")));
      return Response.json({ ok: true }, { status: 201 });
    }
    return Response.json({}, { status: 404 });
  } });
  const server = await startServer({
    host: "127.0.0.1", port: 0, token: TOKEN, hostToken: "synthetic_host_token",
    configPath: join(dir, "server.json"), approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"], workspaces: [{ id: "ws_serialized", name: "Synthetic", path: root, preset: "starter", workspaceType: "local", baseUrl: engine.url.origin }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "json", logRequests: false,
    omnirushGatewayCredentials: { gatewayUrl: gateway.url.origin + "/omnirush/v1", accessToken: "synthetic_access", refreshToken: "synthetic_refresh" },
    omnirushEngineToken: "synthetic_engine",
  });
  return {
    baseUrl: "http://127.0.0.1:" + server.port, controlUrl: engine.url.origin, token: TOKEN,
    stop: async () => { await server.stop(true); engine.stop(true); gateway.stop(true); await rm(dir, { recursive: true, force: true }); },
  };
}
export async function startSerializedTurnLab(): Promise<SerializedTurnLab> {
  if (process.versions.bun) return runtime();
  const modulePath = fileURLToPath(import.meta.url);
  const child = spawn("bun", ["--conditions=development", "--eval", `
    import { startSerializedTurnLab } from ${JSON.stringify(modulePath)};
    const lab = await startSerializedTurnLab();
    console.log(JSON.stringify({ serializedLab: true, baseUrl: lab.baseUrl, controlUrl: lab.controlUrl, token: lab.token }));
    process.on("SIGTERM", async () => { await lab.stop(); process.exit(0); });
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-16000); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  try {
    const ready = await new Promise<Omit<SerializedTurnLab, "stop">>((resolve, reject) => {
      let pending = "";
      const timer = setTimeout(() => reject(new Error("Serialized server lab startup timed out: " + stderr)), 30_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Serialized server lab exited: " + stderr)); });
      child.stdout.on("data", chunk => {
        pending += String(chunk);
        const lines = pending.split("\n"); pending = lines.pop()!;
        for (const line of lines) {
          try {
            const value: unknown = JSON.parse(line);
            if (record(value) && value.serializedLab === true && typeof value.baseUrl === "string" && typeof value.controlUrl === "string" && typeof value.token === "string") {
              clearTimeout(timer); resolve({ baseUrl: value.baseUrl, controlUrl: value.controlUrl, token: value.token });
            }
          } catch {}
        }
      });
    });
    return { ...ready, stop };
  } catch (error) { await stop(); throw error; }
}
