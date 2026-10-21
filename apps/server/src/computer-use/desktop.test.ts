// Desktop computer use on the server side: the switch, the built-in MCP entry
// (reserved id), the engine plugin's hooks, the media lane and its store.
import { afterAll, describe, expect, test } from "bun:test";
import { REAL_SCREEN_DENY_RULES } from "./shared/policy.mjs";
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
import { MCP_ENV_ONLY_MARK, MCP_REASONS, writePolicyFile } from "../mcp-allow/mcp-allow.mjs";
import policyFixture from "../mcp-allow/mcp-policy.fixture.json" with { type: "json" };
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
    // The server allows only the agent's own display: the built-in still runs (it serves "virtual:main").
    rememberComputerUseSwitch(state, { computer_use: { enabled: true, real_screen: false, virtual_display: true } });
    expect(computerUseBuiltins(dir, pinned)["computer-use"]).not.toBeNull();
    rememberComputerUseSwitch(state, { computer_use: { enabled: true, real_screen: false, virtual_display: false } });
    expect(computerUseBuiltins(dir, pinned)).toEqual({ "computer-use": null });
    rememberComputerUseSwitch(state, { computer_use: { enabled: true, limits: { actions_per_session: 9 } } });
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
    // For grants only one running prompted chat names a chat; unknown, none or several: none.
    expect(chats.only(null)).toBeNull();
    expect(chats.only([])).toBeNull();
    expect(chats.only(["ses_b"])).toBe("ses_b");
    // Running chats come without sub-agent sessions; an unmarked running chat (steered, not captured) counts.
    expect(chats.only(["ses_b", "ses_b"])).toBe("ses_b");
    expect(chats.only(["ses_b", "ses_unmarked"])).toBeNull();
    expect(chats.only(["ses_a", "ses_b"])).toBeNull();
    expect(chats.only(["ses_unmarked"])).toBeNull();
    expect(sessionEventOf({ event: "opened", by: "agent", app_id: "/usr/bin/gedit", screen: { id: "0", width: 10, height: 5, scale: 1 }, junk: 1 })).toEqual({ event: "opened", by: "agent", app_id: "/usr/bin/gedit", screen: { id: "0", width: 10, height: 5, scale: 1 } });
    expect(sessionEventOf({ event: "hacked", by: "agent" })).toBeNull();
    // No question was asked: the agent's own display (virtual) or the person's real-screen setting (by_setting).
    expect(sessionEventOf({ event: "approved", by: "agent", approval: "virtual", virtual: { width: 1280, height: 800, kind: "agent-browser" } })).toEqual({ event: "approved", by: "agent", approval: "virtual", virtual: { width: 1280, height: 800, kind: "agent-browser" } });
    expect(sessionEventOf({ event: "approved", by: "agent", approval: "setting", by_setting: true })).toEqual({ event: "approved", by: "agent", approval: "setting", by_setting: true });
  });
});

describe("routes: the chat in use, and the policy read before an open", () => {
  test("state names a chat only when exactly one prompted chat runs; refresh reads the server now (max_age_ms) and says whether it did", async () => {
    const routes: Route[] = [];
    const state = tmp();
    const chats = createChatTracker();
    let running: string[] | null = null;
    const ages: number[] = [];
    let failRead = false;
    registerComputerUseRoutes({ routes, stateDir: () => state, jsonResponse: (d, status = 200) => new Response(JSON.stringify(d), { status }), readJsonBody: async (r) => r.json(), approvalMode: async () => "guarded", readCapabilities: async (maxAgeMs) => { ages.push(maxAgeMs); if (failRead) throw new Error("offline"); return { computer_use: { enabled: true, limits: { session_seconds: 600 } } }; }, applyEngine: async () => undefined, chats, runningSessions: async () => running, recordTrace: () => undefined });
    const hit = async (method: string, p: string, body?: unknown) => {
      const route = routes.find((r) => r.method === method && r.regex.test(p));
      if (!route) throw new Error("no route");
      const response = await route.handler({ request: new Request(`http://x${p}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url: new URL(`http://x${p}`), params: {} } as never);
      return (await response.json()) as Record<string, unknown>;
    };
    chats.mark("ses_a");
    // The engine's running sessions unknown: no chat, even though one was prompted.
    expect((await hit("GET", "/computer-use/state")).chat).toBeNull();
    running = ["ses_a"];
    expect((await hit("GET", "/computer-use/state")).chat).toBe("ses_a");
    // Switching chat: the new one is named.
    chats.mark("ses_b"); running = ["ses_b"];
    expect((await hit("GET", "/computer-use/state")).chat).toBe("ses_b");
    // Both running: no chat.
    running = ["ses_a", "ses_b"];
    expect((await hit("GET", "/computer-use/state")).chat).toBeNull();
    // Before an open the host asks with max_age_ms 0; the new bound is in force at once.
    const read = await hit("POST", "/computer-use/refresh", { max_age_ms: 0 });
    expect(read.read).toBe(true);
    expect(ages.at(-1)).toBe(2_000);
    expect((read.setting as { limits: { session_seconds: number } }).limits.session_seconds).toBe(600);
    expect(Object.keys(read.setting as Record<string, unknown>)).not.toContain("grant_epoch");
    expect((await hit("POST", "/computer-use/refresh", {})).read).toBe(true);
    expect(ages.at(-1)).toBe(60_000);
    failRead = true;
    expect((await hit("POST", "/computer-use/refresh", { max_age_ms: 0 })).read).toBe(false);
  });
});

describe("routes: the account's real-screen opt-in comes from the server's answer only", () => {
  test("refresh answers with the block just read (server yes/no), never a block written into the state folder; a failed read is not a yes", async () => {
    const routes: Route[] = [];
    const state = tmp();
    let block: Record<string, unknown> | null = { enabled: true, real_screen: true, real_screen_opt_in: false };
    let failRead = false;
    registerComputerUseRoutes({ routes, stateDir: () => state, jsonResponse: (d, status = 200) => new Response(JSON.stringify(d), { status }), readJsonBody: async (r) => r.json(), approvalMode: async () => "guarded", readCapabilities: async () => { if (failRead) throw new Error("offline"); return { computer_use: block }; }, applyEngine: async () => undefined, chats: createChatTracker(), runningSessions: async () => null, recordTrace: () => undefined });
    const hit = async (method: string, p: string, body?: unknown) => {
      const route = routes.find((r) => r.method === method && r.regex.test(p));
      if (!route) throw new Error("no route");
      const response = await route.handler({ request: new Request(`http://x${p}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url: new URL(`http://x${p}`), params: {} } as never);
      return (await response.json()) as Record<string, unknown> & { setting: Record<string, unknown> };
    };
    // The account never opted in: no, whatever the local switch.
    let read = await hit("POST", "/computer-use/refresh", { max_age_ms: 0 });
    expect(read.read).toBe(true);
    expect(read.setting).toMatchObject({ real_screen: false, real_screen_opt_in: false });
    // An older server (no real_screen_opt_in): no.
    block = { enabled: true, real_screen: true };
    read = await hit("POST", "/computer-use/refresh", { max_age_ms: 0 });
    expect(read.setting).toMatchObject({ real_screen: false, real_screen_opt_in: false });
    // The account opted in from the web console: yes.
    block = { enabled: true, real_screen: true, real_screen_opt_in: true };
    read = await hit("POST", "/computer-use/refresh", { max_age_ms: 0 });
    expect(read.setting).toMatchObject({ real_screen: true, real_screen_opt_in: true });
    // Turned off on the server: the next read says no.
    block = { enabled: true, real_screen: true, real_screen_opt_in: false };
    // Anything writing a yes into the state folder (the agent's shell can) changes nothing about the fresh answer.
    writeFileSync(path.join(computerUseDir(state), "server.json"), JSON.stringify({ block: { enabled: true, real_screen: true, real_screen_opt_in: true }, at: Date.now() }));
    read = await hit("POST", "/computer-use/refresh", { max_age_ms: 0 });
    expect(read.read).toBe(true);
    expect(read.setting).toMatchObject({ real_screen: false, real_screen_opt_in: false });
    // A read that fails is no yes (read false: Electron main and the host refuse the person's screen).
    writeFileSync(path.join(computerUseDir(state), "server.json"), JSON.stringify({ block: { enabled: true, real_screen: true, real_screen_opt_in: true }, at: Date.now() }));
    failRead = true;
    read = await hit("POST", "/computer-use/refresh", { max_age_ms: 0 });
    expect(read.read).toBe(false);
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
    expect((config.permission as Record<string, string>)["computer-use_*"]).toBe("allow");
    expect((config.permission as { bash: Record<string, string> }).bash["*computer real-screen*"]).toBe("deny");
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

  test("an engine too old for env-only servers: a project's local server is refused, the built-in starts with the filtered variables", async () => {
    const state = tmp();
    const dir = computerUseDir(state);
    const reports = path.join(state, "reports");
    const policyFile = writePolicyFile(path.join(state, "mcp-policy.json"), policyFixture);
    writeHostFile(dir, { command: [process.execPath, "/x/relay.mjs", "/x/c.json"], environment: {} });
    const pinnedEnv = { OMNIRUSH_COMPUTER_USE_COMMAND: JSON.stringify({ command: [process.execPath, "/x/relay.mjs", "/x/c.json"], environment: {} }) };
    const appValues = { OMNIRUSH_SERVER_TOKEN: "srv-123456789", OMNIRUSH_POLICY_TOKEN: "pol-123456789", OMNIRUSH_ACCESS_TOKEN: "acc-123456789", OPENCODE_SERVER_PASSWORD: "pw-123456789" };
    delete (globalThis as Record<symbol, unknown>)[MCP_ENV_ONLY_MARK];
    const { config } = await run({ ...pinnedEnv, ...appValues, OMNIRUSH_MCP_FILTER: "required", OMNIRUSH_MCP_POLICY_FILE: policyFile, OMNIRUSH_COMPUTER_USE_DIR: dir, OMNIRUSH_COMPUTER_USE: "1", OMNIRUSH_MCP_REPORT_DIR: reports }, {
      mcp: { memory: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-memory"], environment: { X: "{env:OMNIRUSH_ACCESS_TOKEN}" } } },
    });
    const mcp = config.mcp as Record<string, { command: string[]; environment: Record<string, string> }>;
    expect(Object.keys(mcp)).toEqual(["computer-use"]);
    const report = JSON.parse(readFileSync(path.join(reports, readdirName(reports)), "utf8")) as { decisions: Array<{ name: string; code: string; reason: string }> };
    expect(report.decisions.find((d) => d.name === "memory")).toMatchObject({ code: "engine_update", reason: MCP_REASONS.engine_update });
    // The engine merges its environment for it: every app value is emptied.
    const builtinEnv = mcp["computer-use"]!.environment;
    for (const [name, value] of Object.entries(builtinEnv)) {
      if (/^(?:OMNIRUSH_|OPENCODE_SERVER_)/i.test(name)) expect(`${name}=${value}`).toBe(`${name}=`);
    }
    for (const name of Object.keys(appValues)) expect(builtinEnv[name]).toBe("");
  });

  test("off: nothing is added and the config is as before", async () => {
    const state = tmp();
    const { config } = await run({ OMNIRUSH_COMPUTER_USE_DIR: computerUseDir(state) }, { permission: { "*": "ask", bash: { "*": "allow", "rm -r*": "ask" } } });
    // As before, plus only the real-screen denies (every mode, computer use on or off).
    expect(config).toEqual({ mcp: {}, permission: { "*": "ask", bash: { "*": "allow", "rm -r*": "ask", ...REAL_SCREEN_DENY_RULES.bash }, edit: { ...REAL_SCREEN_DENY_RULES.edit } } });
  });

  test("on in Auto: the shell rules stay a single allow (plus the real-screen denies)", async () => {
    const state = tmp();
    const dir = computerUseDir(state);
    writeHostFile(dir, { command: [process.execPath, "/x/relay.mjs", "/x/c.json"], environment: {} });
    const pinnedEnv = { OMNIRUSH_COMPUTER_USE_COMMAND: JSON.stringify({ command: [process.execPath, "/x/relay.mjs", "/x/c.json"], environment: {} }) };
    const { config } = await run({ ...pinnedEnv, OMNIRUSH_COMPUTER_USE_DIR: dir, OMNIRUSH_COMPUTER_USE: "1" }, { permission: { bash: { "*": "allow" } } });
    expect((config.permission as { bash: Record<string, string> }).bash).toEqual({ "*": "allow", ...REAL_SCREEN_DENY_RULES.bash });
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
