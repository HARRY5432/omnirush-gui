// Computer use in the desktop app (contract v2): the host runs in this main
// process, behind the server switch (the local server's /computer-use/state:
// GET /collect/capabilities `computer_use`, or OMNIRUSH_COMPUTER_USE=0/1).
//
// - Windows and Linux X11: the shared portable host + native worker
//   (apps/server/src/computer-use/shared/, the same files as the CLI's).
// - macOS: the signed Swift helper (computer-use-host.mjs), same interface.
//
// The engine reaches the host only as the built-in MCP server `computer-use`
// (the local server adds it from host.json; the id is reserved). Consent is
// never the engine's: every open-session ask, and the per-action asks of the
// chat's permission mode, are answered in the main window (desktop IPC from
// its main frame, input checked for synthetic events), never by the agent.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app } from "electron";
import { createComputerUseHost } from "./computer-use-host.mjs";
import { createComputerPreview } from "./computer-use-preview.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const STATUS_CHANNEL = "omnirush:computer-use:status";
// A per-launch secret, held in this process only (the local server runs in this process and reads it here):
// the host and event routes take it, so a client token read from disk cannot replace the host or forge events.
const HOST_SECRET = randomBytes(32).toString("hex");
globalThis[Symbol.for("omnirush.computer-use.host-secret")] = HOST_SECRET;
const secretHeaders = { "x-omnirush-computer-use-secret": HOST_SECRET };
// The profile folder the local server expects the host in (computer-use/desktop.ts expectedHostCommand).
const profileDir = () => process.env.OMNIRUSH_DESKTOP_USER_DATA_DIR?.trim() || app.getPath("userData");
const SYNTHETIC_MESSAGE = "Use your own mouse or keyboard to approve.";
// Answers need a physical press in this app's window. OMNIRUSH_COMPUTER_USE_TEST_ANSWERS=1 (rigs only: the
// app's own environment, which the agent cannot set for a running app) accepts remote-debugging clicks.
const testAnswers = process.env.OMNIRUSH_COMPUTER_USE_TEST_ANSWERS === "1";
async function personAnswered() {
  if (!host) return false;
  if (await host.syntheticInput()) return false;
  return testAnswers || host.physicalInput(5000, { foregroundPid: process.pid });
}

let deps = null;
let server = null; // the last /computer-use/state answer
let host = null;
let hostPromise = null;
let listener = null;
let preview = null;
let shared = null;
let pollTimer = null;
let refreshTimer = null;
let failedAt = 0; // a host that did not start is tried again after a minute
const pending = new Map(); // request_id → { request, resolve }

function shippedModule(name) {
  // Packaged: app.asar/server/dist; dev: apps/server/dist (OMNIRUSH_DEV_MODE prefers it).
  const candidates = [
    path.resolve(__dirname, "..", "server", "dist", "computer-use", "shared", name),
    path.resolve(__dirname, "..", "..", "server", "dist", "computer-use", "shared", name),
    path.resolve(__dirname, "..", "..", "server", "src", "computer-use", "shared", name),
  ];
  if (process.env.OMNIRUSH_DEV_MODE === "1") candidates.unshift(candidates.splice(1, 1)[0]);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Computer use is missing from this build. Reinstall OmniRush.ai.");
  return pathToFileURL(found).href;
}

async function sharedModules() {
  if (!shared) {
    const [hostModule, mediaModule, policyModule, contractModule, imageModule] = await Promise.all(["portable-host.mjs", "media.mjs", "policy.mjs", "contract.mjs", "image.mjs"].map((name) => import(shippedModule(name))));
    shared = { hostModule, mediaModule, policyModule, contractModule, imageModule, ancestors: policyModule.readAncestors() };
  }
  return shared;
}

async function serverFetch(pathname, init = {}) {
  const info = await deps?.serverInfo?.();
  const token = info?.clientToken ?? info?.ownerToken;
  if (!info?.baseUrl || !token) throw new Error("The local OmniRush.ai server is not ready.");
  // loopback-fetch: the locally managed OmniRush.ai server.
  const response = await fetch(`${info.baseUrl}${pathname}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`computer use route ${pathname}: ${response.status}`);
  return response.json();
}

function supported() {
  return process.platform === "win32" || process.platform === "linux" || process.platform === "darwin";
}

function statusNow() {
  const sessions = host ? host.state() : [];
  return {
    enabled: server?.enabled === true,
    supported: Boolean(host?.availability?.supported ?? supported()),
    message: server?.enabled ? (host && !host.availability?.supported ? host.availability?.error ?? "Computer use is unavailable on this desktop." : null) : server?.setting?.message ?? (server ? "Computer use is turned off." : null),
    mode: server?.mode ?? "normal",
    sessions,
    requests: [...pending.values()].map((entry) => entry.request),
  };
}

function pushStatus() {
  const window = deps?.getWindow?.();
  if (window && !window.isDestroyed()) window.webContents.send(STATUS_CHANNEL, statusNow());
  if (host) preview?.update(host.state());
}

async function iconOf(file) {
  try {
    if (!file || !existsSync(file)) return null;
    const image = await app.getFileIcon(file, { size: "normal" });
    return image.isEmpty() ? null : image.toDataURL();
  } catch {
    return null;
  }
}

function ask(request) {
  return new Promise((resolve) => {
    pending.set(request.request_id, { request, resolve });
    void host?.watchInput?.();
    // Bring the main window up: the question is answered there.
    const window = deps?.getWindow?.();
    if (window && !window.isDestroyed() && !window.isFocused()) window.flashFrame?.(true);
    pushStatus();
  });
}

function settled(requestId) {
  pending.delete(requestId);
  pushStatus();
}

const approve = {
  async open(request) {
    const icon = await iconOf(request.app.bundle_or_exe);
    const answer = await ask({ kind: "open", ...request, icon, chat: server?.chat ?? null });
    settled(request.request_id);
    return answer;
  },
  async act(request) {
    const { policyModule } = await sharedModules();
    const reasons = request.reasons.map((r) => ({ ...r, text: `${policyModule.ASK_REASONS[r.code] ?? r.code}${r.detail ? ` (${r.detail})` : ""}` }));
    const answer = await ask({ kind: "act", ...request, reasons, icon: await iconOf(request.app.bundle_or_exe), chat: server?.chat ?? null });
    settled(request.request_id);
    return { allow: answer.decision === "allow" };
  },
};

function hostSettings() {
  const setting = server?.setting ?? {};
  return { enabled: server?.enabled === true, real_screen: setting.real_screen !== false, limits: setting.limits ?? null, deny_apps: setting.deny_apps ?? [], mode: server?.mode ?? "normal", message: setting.message ?? null };
}

async function hostContext() {
  const metrics = (() => { try { return app.getAppMetrics().map((m) => m.pid); } catch { return []; } })();
  // The chat now (the one that just called), not the last poll's.
  const fresh = await serverFetch("/computer-use/state").catch(() => null);
  if (fresh) server = fresh;
  return { ancestors: shared?.ancestors ?? [], self_pids: [process.pid, ...metrics], chat: server?.chat ?? null };
}

async function reportEvent(event) {
  const session = host?.state().find((s) => s.id === event.session_id);
  await serverFetch("/computer-use/event", { method: "POST", headers: secretHeaders, body: JSON.stringify({ event, ...(session?.chat ? { chat: session.chat } : {}) }) }).catch(() => {});
}

async function startHost() {
  if (hostPromise) return hostPromise;
  hostPromise = (async () => {
    const { hostModule, mediaModule, policyModule, contractModule, imageModule } = await sharedModules();
    const spool = server?.spool ? mediaModule.createMediaSpool(server.spool) : null;
    const callbacks = {
      spool, settings: hostSettings, context: hostContext, approve,
      onEvent: (event) => { void reportEvent(event); },
      onState: () => { pushStatus(); scheduleRefresh(); },
      onFrame: (frame) => preview?.image(frame.data_url),
    };
    let created;
    if (process.platform === "darwin") {
      const executable = resolveComputerUseExecutable();
      if (!executable) throw new Error("The Computer Use helper is unavailable. Rebuild or reinstall OmniRush.ai.");
      created = await createComputerUseHost({ executable, ...callbacks, shared: { portable: hostModule, policy: policyModule, contract: contractModule, image: imageModule } });
    } else {
      const nativeFactory = () => hostModule.createNativeWorker({ nodePath: process.execPath, nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, koffiPath: require.resolve("koffi") });
      created = await hostModule.createPortableHost({ native: nativeFactory(), nativeFactory, ...callbacks });
      preview = createComputerPreview();
      preview.bind(created);
    }
    host = created;
    listener = await created.listen(path.join(profileDir(), "computer-use"));
    const relay = app.isPackaged ? path.join(process.resourcesPath, "computer-use", "relay.mjs") : path.join(__dirname, "computer-use-relay.mjs");
    const command = [process.execPath, relay, listener.discoveryPath];
    const environment = { ELECTRON_RUN_AS_NODE: "1" };
    await serverFetch("/computer-use/host", { method: "POST", headers: secretHeaders, body: JSON.stringify({ command, environment }) });
    pushStatus();
    return created;
  })().catch((error) => { hostPromise = null; host = null; throw error; });
  return hostPromise;
}

async function stopHost(by = "server") {
  const current = host;
  await serverFetch("/computer-use/host", { method: "POST", headers: secretHeaders, body: JSON.stringify({ host: null }) }).catch(() => {});
  if (!current) return;
  await current.stopAll(by).catch(() => {});
  for (const entry of pending.values()) entry.resolve({ decision: "deny" });
  pending.clear();
  await listener?.close().catch(() => {});
  await current.close().catch(() => {});
  preview?.close(); preview = null;
  host = null; hostPromise = null; listener = null;
  pushStatus();
}

async function apply(next) {
  server = next;
  if (server?.enabled && supported() && !hostPromise && Date.now() - failedAt < 60_000) { pushStatus(); return; }
  if (server?.enabled && supported()) await startHost().catch((error) => { failedAt = Date.now(); deps?.log?.("computer use host did not start", error); });
  else if (host) await stopHost("server");
  pushStatus();
}

// While a session is open the switch is read again every 60 s: off closes it within a minute.
function scheduleRefresh() {
  const open = host?.state().some((s) => s.phase !== "ended") ?? false;
  if (open && !refreshTimer) {
    refreshTimer = setInterval(() => {
      void serverFetch("/computer-use/refresh", { method: "POST", body: "{}" }).then(apply).catch(() => {});
    }, 60_000);
    refreshTimer.unref?.();
  } else if (!open && refreshTimer) {
    clearInterval(refreshTimer); refreshTimer = null;
  }
}

/** Starts following the switch (main.mjs, once the local server runs). */
export function initComputerUse(options) {
  deps = options;
  const poll = () => void serverFetch("/computer-use/state").then(apply).catch(() => {});
  poll();
  // The state route is local: the chat in use and the switch are read every few seconds.
  pollTimer = setInterval(poll, 5_000);
  pollTimer.unref?.();
}

app.on("before-quit", () => { if (pollTimer) clearInterval(pollTimer); void stopHost("agent"); });

async function getComputerUseState() {
  return statusNow();
}

/** An answer from the main window. Synthetic input (another program clicking Allow) is refused. */
async function computerUseAnswer(answer) {
  const entry = pending.get(answer?.request_id);
  if (!entry) throw new Error("This request has ended.");
  const allowing = answer.decision !== "deny";
  if (allowing && !(await personAnswered())) throw new Error(SYNTHETIC_MESSAGE);
  const decision = entry.request.kind === "open" ? (["chat", "once", "deny"].includes(answer.decision) ? answer.decision : "deny") : (answer.decision === "allow" ? "allow" : "deny");
  entry.resolve({ decision, ...(typeof answer.window_id === "string" ? { window_id: answer.window_id } : {}) });
}

async function computerUseControl(value) {
  if (!host) throw new Error("Computer use is not running.");
  if (value?.action === "continue" && !(await personAnswered())) throw new Error(SYNTHETIC_MESSAGE);
  await host.control({ session_id: value?.session_id, action: value?.action });
  pushStatus();
}

function getComputerUseMcpEnvironment() { return { ELECTRON_RUN_AS_NODE: "1" }; }

async function getComputerUseMcpCommand() {
  if (!server?.enabled) throw new Error(server?.setting?.message ?? "Computer use is turned off.");
  await startHost();
  const relay = app.isPackaged ? path.join(process.resourcesPath, "computer-use", "relay.mjs") : path.join(__dirname, "computer-use-relay.mjs");
  return [process.execPath, relay, listener.discoveryPath];
}

// ---------------------------------------------------------------------------
// macOS helper: locating the bundled app, permission checks (spawn --check for
// a fresh TCC read), running-app listing for @App mentions, permission setup.
// ---------------------------------------------------------------------------

const COMPUTER_USE_HELPER_APP_NAME = "OmniRush.ai Computer Use.app";
const COMPUTER_USE_HELPER_EXECUTABLE = "ComputerUse";

function computerUseHelperAppPath() {
  const explicitApp = process.env.OMNIRUSH_COMPUTER_USE_APP?.trim();
  const candidates = [
    explicitApp,
    process.resourcesPath ? path.join(process.resourcesPath, "helpers", COMPUTER_USE_HELPER_APP_NAME) : null,
    path.resolve(__dirname, "..", "resources", "helpers", COMPUTER_USE_HELPER_APP_NAME),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveComputerUseExecutable() {
  const explicit = process.env.OMNIRUSH_COMPUTER_USE_BINARY?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const appPath = computerUseHelperAppPath();
  if (appPath) {
    const bin = path.join(appPath, "Contents", "MacOS", COMPUTER_USE_HELPER_EXECUTABLE);
    if (existsSync(bin)) return bin;
  }
  if (!app.isPackaged) {
    const swiftPkg = path.resolve(__dirname, "../../..", "packages/computer-use/native");
    for (const c of [".build/release/ComputerUse", ".build/arm64-apple-macosx/release/ComputerUse", ".build/debug/ComputerUse", ".build/arm64-apple-macosx/debug/ComputerUse"].map((rel) => path.join(swiftPkg, rel))) {
      if (existsSync(c)) return c;
    }
  }
  return null;
}

async function checkComputerUsePermissions() {
  if (process.platform !== "darwin") {
    const available = host?.availability ?? { supported: false, error: server?.enabled ? "Computer use is starting." : "Computer use is turned off." };
    return { ok: available.supported, accessibility: available.supported, screenRecording: available.supported, supported: available.supported, protocolVersion: "omnirush.computer-use/2", platform: process.platform, modes: ["observe", "control"], backgroundControl: false, ...(available.error ? { error: available.error } : {}) };
  }
  const bin = resolveComputerUseExecutable();
  if (!bin) return { ok: false, accessibility: false, screenRecording: false, error: "Helper binary not found. Run pnpm dev to build it." };
  return spawnJson(bin, ["--check"], (parsed) => ({
    ok: parsed?.ok === true,
    accessibility: parsed?.accessibility === true,
    screenRecording: parsed?.screenRecording === true,
    supported: parsed?.supported === true,
    protocolVersion: parsed?.protocolVersion,
  }), { ok: false, accessibility: false, screenRecording: false, error: "Permission check returned invalid output." });
}

function spawnJson(bin, args, map, fallback) {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve(fallback));
    child.on("close", () => { try { resolve(map(JSON.parse(stdout.trim()))); } catch { resolve(fallback); } });
  });
}

async function listRunningApps() {
  if (process.platform !== "darwin") {
    if (!host) return { ok: false, apps: [] };
    const connection = host.connect();
    try {
      const reply = await connection.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "computer_discover", arguments: {} } });
      const state = JSON.parse(reply?.result?.content?.[0]?.text ?? "{}");
      return { ok: state.ok === true, apps: [...new Set((state.apps ?? []).filter((a) => a.windows?.length).map((a) => a.name))] };
    } finally { await connection.close(); }
  }
  const bin = resolveComputerUseExecutable();
  if (!bin) return { ok: false, apps: [] };
  return spawnJson(bin, ["--list-apps"], (parsed) => ({ ok: parsed?.ok === true, apps: Array.isArray(parsed?.apps) ? parsed.apps.filter((name) => typeof name === "string" && name.trim()) : [] }), { ok: false, apps: [] });
}

let setupProcess = null;

async function openComputerUseSetupApp() {
  if (process.platform !== "darwin") return;
  const bin = resolveComputerUseExecutable();
  if (!bin) throw new Error("The Computer Use helper is unavailable. Rebuild or reinstall OmniRush.ai.");
  // Keep the responsible application consistent with --check and the MCP child.
  if (setupProcess && setupProcess.exitCode === null && !setupProcess.killed) { setupProcess.kill("SIGUSR1"); return; }
  const child = spawn(bin, ["setup"], { stdio: "ignore" });
  setupProcess = child;
  child.once("exit", () => { if (setupProcess === child) setupProcess = null; });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => { if (setupProcess === child) setupProcess = null; reject(error); });
  });
  child.unref();
}

export {
  getComputerUseState,
  computerUseAnswer,
  computerUseControl,
  getComputerUseMcpEnvironment,
  checkComputerUsePermissions,
  getComputerUseMcpCommand,
  listRunningApps,
  openComputerUseSetupApp,
};
