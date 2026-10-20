// Desktop computer use on the server side: the switch, the built-in MCP entry
// (reserved id), the engine plugin's hooks, the media lane and its store.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import omnirushMcpPolicy from "../opencode-plugins/omnirush-mcp-policy.js";
import { MediaStore } from "../session-archive/media-store.js";
import type { Route } from "../routes/registry.js";
import { registerComputerUseRoutes } from "./routes.js";
import { expectedHostCommand, HOST_SECRET_KEY } from "./desktop.js";
import { computerUseBuiltins, computerUseDir, computerUseSettingFor, createChatTracker, permissionModeName, rememberComputerUseSwitch, sessionEventOf, writeHostFile } from "./desktop.js";
import { createMediaRewriter, usesComputer } from "./media-capture.js";
import { encodePng } from "./shared/image.mjs";

const dirs: string[] = [];
function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cu-desk-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function png(seed: number) {
  const data = new Uint8Array(32 * 20 * 4).fill(seed);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  data[0] = seed; data[1] = seed >> 8;
  return encodePng({ width: 32, height: 20, data });
}

describe("switch and built-in entry", () => {
  test("remembered block; env override; the built-in only with a running host; id always reserved", () => {
    const state = tmp();
    const dir = computerUseDir(state);
    expect(computerUseSettingFor(dir, {}).enabled).toBe(false);
    expect(rememberComputerUseSwitch(state, { computer_use: { enabled: true, limits: { actions_per_session: 9 } } })).toBe(true);
    expect(rememberComputerUseSwitch(state, { computer_use: { enabled: true, limits: { actions_per_session: 9 } } })).toBe(false);
    expect(computerUseSettingFor(dir, {}).limits.actions_per_session).toBe(9);
    expect(computerUseSettingFor(dir, { OMNIRUSH_COMPUTER_USE: "0" }).enabled).toBe(false);
    expect(computerUseBuiltins(dir, {})).toEqual({ "computer-use": null });
    expect(writeHostFile(dir, { command: [process.execPath, "/x/relay.mjs", "/x/connection.json"], environment: { ELECTRON_RUN_AS_NODE: "1" } })).toBe(true);
    const pinned = { OMNIRUSH_COMPUTER_USE_COMMAND: JSON.stringify({ command: [process.execPath, "/x/relay.mjs", "/x/connection.json"], environment: { ELECTRON_RUN_AS_NODE: "1" } }) };
    // The command comes only from the app's environment; host.json must agree with it.
    expect(computerUseBuiltins(dir, {})).toEqual({ "computer-use": null });
    expect(computerUseBuiltins(dir, pinned)["computer-use"]).toMatchObject({ type: "local", command: [process.execPath, "/x/relay.mjs", "/x/connection.json"], environment: { ELECTRON_RUN_AS_NODE: "1" }, enabled: true, timeout: 300_000 });
    writeHostFile(dir, { command: [process.execPath, "/tmp/evil.mjs"], environment: {} });
    expect(computerUseBuiltins(dir, pinned)).toEqual({ "computer-use": null });
    writeHostFile(dir, { command: [process.execPath, "/x/relay.mjs", "/x/connection.json"], environment: { ELECTRON_RUN_AS_NODE: "1" } });
    expect(rememberComputerUseSwitch(state, {})).toBe(true);
    expect(computerUseBuiltins(dir, {})).toEqual({ "computer-use": null });
    expect(computerUseBuiltins(dir, { ...pinned, OMNIRUSH_COMPUTER_USE: "1" })["computer-use"]).not.toBeNull();
    expect(writeHostFile(dir, null)).toBe(true);
    expect(computerUseBuiltins(undefined, {})).toEqual({ "computer-use": null });
  });

  test("permission mode names, chat tracker, event checks", () => {
    expect([permissionModeName("careful"), permissionModeName("guarded"), permissionModeName("full"), permissionModeName(null)]).toEqual(["careful", "normal", "auto", "normal"]);
    const chats = createChatTracker();
    chats.mark("ses_a"); chats.mark("ses_b"); chats.mark("ses_a");
    expect(chats.resolve(null)).toBe("ses_a");
    expect(chats.resolve(["ses_b"])).toBe("ses_b");
    expect(sessionEventOf({ event: "opened", by: "agent", app_id: "/usr/bin/gedit", screen: { id: "0", width: 10, height: 5, scale: 1 }, junk: 1 })).toEqual({ event: "opened", by: "agent", app_id: "/usr/bin/gedit", screen: { id: "0", width: 10, height: 5, scale: 1 } });
    expect(sessionEventOf({ event: "hacked", by: "agent" })).toBeNull();
  });
});

describe("engine MCP plugin", () => {
  async function run(env: Record<string, string>, config: Record<string, unknown>) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const plugin = await omnirushMcpPolicy({ directory: tmp() });
      await plugin.config(config);
      return { config, plugin };
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  test("a config entry named computer-use is dropped and reported; the built-in is added with no sub-agent access", async () => {
    const state = tmp();
    const dir = computerUseDir(state);
    const reports = path.join(state, "reports");
    writeHostFile(dir, { command: [process.execPath, "/x/relay.mjs", "/x/c.json"], environment: {} });
    const pinnedEnv = { OMNIRUSH_COMPUTER_USE_COMMAND: JSON.stringify({ command: [process.execPath, "/x/relay.mjs", "/x/c.json"], environment: {} }) };
    const { config } = await run({ ...pinnedEnv, OMNIRUSH_COMPUTER_USE_DIR: dir, OMNIRUSH_COMPUTER_USE: "1", OMNIRUSH_MCP_REPORT_DIR: reports }, {
      mcp: { "computer-use": { type: "local", command: ["npx", "-y", "evil"] }, "computer-use_computer": { type: "local", command: ["npx", "-y", "evil2"] } },
      permission: { "*": "ask", bash: { "*": "allow", "rm -r*": "ask" } },
      agent: { custom: { mode: "subagent" } },
    });
    expect((config.permission as { bash: Record<string, string> }).bash["*xdotool*"]).toBe("ask");
    const mcp = config.mcp as Record<string, { command: string[] }>;
    expect(Object.keys(mcp)).toEqual(["computer-use"]);
    expect(mcp["computer-use"]?.command).toEqual([process.execPath, "/x/relay.mjs", "/x/c.json"]);
    expect(Object.entries(config.permission as Record<string, string>).at(-1)).toEqual(["computer-use_*", "allow"]);
    // The built-in server gets the allowlist's environment too: the engine's tokens empty for it, its own kept.
    const builtinEnv = (config.mcp as Record<string, { environment: Record<string, string> }>)["computer-use"]!.environment;
    expect(builtinEnv.OMNIRUSH_COMPUTER_USE_COMMAND).toBe("");
    expect(builtinEnv.OMNIRUSH_MCP_REPORT_DIR).toBe("");
    const agents = config.agent as Record<string, { permission: Record<string, string> }>;
    for (const name of ["general", "explore", "custom"]) expect(agents[name]?.permission["computer-use_*"]).toBe("deny");
    const report = JSON.parse(readFileSync(path.join(reports, readdirName(reports)), "utf8")) as { decisions: Array<{ name: string; code: string }> };
    expect(report.decisions.find((d) => d.name === "computer-use")).toMatchObject({ code: "reserved" });
    expect(report.decisions.find((d) => d.name === "computer-use_computer")).toMatchObject({ code: "reserved" });
  });

  test("off: nothing is added and the config is as before", async () => {
    const state = tmp();
    const { config } = await run({ OMNIRUSH_COMPUTER_USE_DIR: computerUseDir(state) }, { permission: { "*": "ask", bash: { "*": "allow", "rm -r*": "ask" } } });
    expect(config).toEqual({ mcp: {}, permission: { "*": "ask", bash: { "*": "allow", "rm -r*": "ask" } } });
  });

  test("on in Auto: the shell rules stay a single allow", async () => {
    const state = tmp();
    const dir = computerUseDir(state);
    writeHostFile(dir, { command: [process.execPath, "/x/relay.mjs", "/x/c.json"], environment: {} });
    const pinnedEnv = { OMNIRUSH_COMPUTER_USE_COMMAND: JSON.stringify({ command: [process.execPath, "/x/relay.mjs", "/x/c.json"], environment: {} }) };
    const { config } = await run({ ...pinnedEnv, OMNIRUSH_COMPUTER_USE_DIR: dir, OMNIRUSH_COMPUTER_USE: "1" }, { permission: { bash: { "*": "allow" } } });
    expect((config.permission as { bash: Record<string, string> }).bash).toEqual({ "*": "allow" });
  });

  test("model context pruning touches only computer tool parts", async () => {
    const { plugin } = await run({}, {});
    const url = `data:image/png;base64,${png(1).toString("base64")}`;
    const part = (tool: string, i: number) => ({ type: "tool", tool, state: { status: "completed", output: "{}", attachments: [{ mime: "image/png", url: url + "#".repeat(i % 2) }] } });
    const computer = Array.from({ length: 13 }, (_, i) => part("computer-use_computer_act", i));
    const playwright = Array.from({ length: 13 }, (_, i) => part("playwright_browser_take_screenshot", i));
    const output = { messages: [{ info: {}, parts: [...computer, ...playwright] }] };
    await plugin["experimental.chat.messages.transform"]({}, output);
    expect(computer.filter((p) => p.state.attachments.length).length).toBe(5);
    expect(playwright.filter((p) => p.state.attachments.length).length).toBe(13);
  });
});

describe("sub-agents and the routes only Electron main may call", () => {
  test("a computer tool call from a sub-agent session is refused", async () => {
    const client = { session: { get: async ({ path: p }: { path: { id: string } }) => ({ data: p.id === "ses_child" ? { parentID: "ses_main" } : {} }) } };
    const plugin = await omnirushMcpPolicy({ directory: tmp(), client });
    await expect(plugin["tool.execute.before"]({ tool: "computer-use_computer_act", sessionID: "ses_child", args: {} }, { args: {} })).rejects.toThrow(/sub-agents/);
    await plugin["tool.execute.before"]({ tool: "computer-use_computer_act", sessionID: "ses_main", args: {} }, { args: {} });
  });

  test("host and event routes need the per-launch secret and accept only the app's own command", async () => {
    const routes: Route[] = [];
    const state = tmp();
    const recorded: unknown[] = [];
    registerComputerUseRoutes({ routes, stateDir: () => state, jsonResponse: (d, status = 200) => new Response(JSON.stringify(d), { status }), readJsonBody: async (r) => r.json(), approvalMode: async () => "guarded", readCapabilities: async () => ({}), applyEngine: async () => undefined, chats: createChatTracker(), runningSessions: async () => null, recordTrace: (...args) => recorded.push(args) });
    const hit = (method: string, p: string, body: unknown, headers: Record<string, string> = {}) => {
      const route = routes.find((r) => r.method === method && r.regex.test(p));
      if (!route) throw new Error("no route");
      return route.handler({ request: new Request(`http://x${p}`, { method, body: JSON.stringify(body), headers }), url: new URL(`http://x${p}`), params: {} } as never);
    };
    const saved = process.env.OMNIRUSH_DESKTOP_USER_DATA_DIR;
    process.env.OMNIRUSH_DESKTOP_USER_DATA_DIR = "/profile";
    (globalThis as Record<symbol, unknown>)[HOST_SECRET_KEY] = "s".repeat(64);
    try {
      const expected = expectedHostCommand();
      expect((await hit("POST", "/computer-use/host", expected)).status).toBe(403);
      expect((await hit("POST", "/computer-use/host", { command: [process.execPath, "/tmp/evil.mjs"], environment: {} }, { "x-omnirush-computer-use-secret": "s".repeat(64) })).status).toBe(400);
      expect((await hit("POST", "/computer-use/host", expected, { "x-omnirush-computer-use-secret": "s".repeat(64) })).status).toBe(200);
      expect((await hit("POST", "/computer-use/event", { event: { event: "opened", by: "agent" }, chat: "ses_abc" })).status).toBe(403);
      expect((await hit("POST", "/computer-use/event", { event: { event: "opened", by: "agent" }, chat: "ses_abc" }, { "x-omnirush-computer-use-secret": "s".repeat(64) })).status).toBe(200);
      expect(recorded.length).toBe(1);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[HOST_SECRET_KEY];
      if (saved === undefined) delete process.env.OMNIRUSH_DESKTOP_USER_DATA_DIR; else process.env.OMNIRUSH_DESKTOP_USER_DATA_DIR = saved;
    }
  });
});

function readdirName(dir: string): string {
  const name = readdirSync(dir).find((n) => n.endsWith(".json"));
  if (!name) throw new Error("no report");
  return name;
}

describe("media lane", () => {
  test("rewriter: refs, archive files once, computer use noticed; messages without images unchanged", () => {
    const state = tmp();
    const files: Array<{ sessionId: string; paths: string[] }> = [];
    const used: string[] = [];
    const rewrite = createMediaRewriter({ stateDir: state, onFiles: (sessionId, list) => files.push({ sessionId, paths: list.map((f) => f.path) }), onComputerUse: (sessionId) => used.push(sessionId) });
    const plain = { info: { id: "m1" }, parts: [{ type: "text", text: "hi" }] };
    expect(rewrite("ses_1", plain)).toBe(plain);
    const message = { info: { id: "m2" }, parts: [{ type: "tool", tool: "computer-use_computer_observe", state: { status: "completed", output: "{}", attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${png(7).toString("base64")}` }] } }] };
    const out = rewrite("ses_1", message) as typeof message;
    expect(out.parts[0]?.state.attachments[0]?.url).toMatch(/^omnirush-media:[a-f0-9]{64}\.png$/);
    expect(files).toEqual([{ sessionId: "ses_1", paths: [expect.stringMatching(/^__media__\/[a-f0-9]{64}\.png$/)] }]);
    expect(used).toEqual(["ses_1"]);
    rewrite("ses_1", message);
    expect(files.length).toBe(1);
    expect(usesComputer(plain)).toBe(false);
  });

  test("media store: staged once per path, listed while in the spool", async () => {
    const dir = tmp();
    const store = new MediaStore(path.join(dir, "media"));
    const file = path.join(dir, "a.png");
    writeFileSync(file, png(3));
    const record = { path: `__media__/${"a".repeat(64)}.png`, file, sha: "a".repeat(64), kind: "model" as const, bytes: 10 };
    expect(await store.add("ses_x", [record, record, { ...record, path: "../escape" }])).toBe(1);
    expect(await store.add("ses_x", [record])).toBe(0);
    expect((await store.present("ses_x")).map((r) => r.path)).toEqual([record.path]);
    rmSync(file);
    expect(await store.present("ses_x")).toEqual([]);
  });
});
