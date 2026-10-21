// Computer use, portable host (Windows + Linux X11): the `computer-use` MCP
// server of contract v2, run in the app's own process (the desktop's
// Electron main, the CLI's node). Native work happens in native-worker.mjs.
//
// The same file ships in omnirush-cli (src/computer-use/) and omnirush-gui
// (apps/server/src/computer-use/shared/); PARITY.sha256 lists it in both.
//
// No questions (owner decision 2026-10-21): a session on the person's screen
// opens only when the person turned the real screen on (a setting, off by
// default; policy.mjs sessionRules) and then acts without asking. What stays:
// the deny list, hit-testing of every point, the person-input pause, the
// stuck-input release, Stop and the server switch. `virtual` (virtual-host.mjs)
// serves app_id "virtual:<name>", the agent's own display, on the same
// connection.

import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  actResult,
  CONTRACT_VERSION,
  failure,
  INSTRUCTIONS,
  mapPoint,
  mcpResult,
  normalizeLimits,
  observeResult,
  osName,
  SERVER_NAME,
  toolDefinitions,
  TOOLS,
  validateAction,
  validateCall,
} from "./contract.mjs";
import { compareGrids, encodeJpeg, encodePng, fitLongSide, luminanceGrid, paintBoxes } from "./image.mjs";
import { sha256 } from "./media.mjs";
import { deniedApp, REAL_SCREEN_NOT_OPTED_IN_MESSAGE, serverRealScreen, sessionRules } from "./policy.mjs";

const RPC = new Set(["initialize", "ping", "tools/list", "tools/call", "notifications/initialized", "notifications/cancelled"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// For timeouts raced against an answer: never keeps a short-lived process alive.
const timeout = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
const now = () => new Date().toISOString();
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Starts the native worker. `nodePath` runs it (the app's own binary with
 * `nodeEnv`, e.g. ELECTRON_RUN_AS_NODE=1); `koffiPath` is koffi's entry.
 * Held keys/buttons are released by a one-shot `--release` worker if it exits.
 */
export function createNativeWorker({ workerPath = fileURLToPath(new URL("./native-worker.mjs", import.meta.url)), nodePath = process.execPath, nodeEnv = {}, koffiPath, timeoutMs = 10_000 } = {}) {
  const env = { ...process.env, ...nodeEnv, ...(koffiPath ? { OMNIRUSH_KOFFI: koffiPath } : {}) };
  const worker = spawn(nodePath, [workerPath], { env, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, serialization: "advanced" });
  const pending = new Map();
  const listeners = new Set();
  let nextId = 0, closed = false, held = { keys: [], buttons: [] };
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const readyTimer = setTimeout(() => readyResolve({ supported: false, code: "native_unavailable", error: "Desktop access did not start. Restart the app." }), timeoutMs);
  worker.on("message", (value) => {
    if (!record(value)) return;
    if (value.event === "ready") { clearTimeout(readyTimer); readyResolve(value); return; }
    if (value.event === "held") { held = { keys: value.keys ?? [], buttons: value.buttons ?? [] }; return; }
    if (value.event) { for (const listener of listeners) listener(value); return; }
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id); clearTimeout(request.timer);
    if (record(value.error)) request.reject(Object.assign(new Error(String(value.error.message)), { code: value.error.code }));
    else request.resolve(value.result);
  });
  const fail = (error) => {
    if (closed) return;
    clearTimeout(readyTimer); readyResolve({ supported: false, code: "native_unavailable", error: error.message });
    closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    if (held.keys.length || held.buttons.length) {
      // The worker died with input held: release it from a fresh one.
      const releaser = spawn(nodePath, [workerPath, "--release", JSON.stringify(held)], { env, stdio: "ignore", windowsHide: true });
      releaser.on("error", () => {});
      held = { keys: [], buttons: [] };
    }
    for (const listener of listeners) listener({ event: "unavailable" });
  };
  worker.on("error", fail);
  worker.on("exit", () => fail(new Error("Desktop access stopped. Restart the app.")));
  return {
    ready,
    pid: worker.pid,
    get held() { return held; },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    call(method, params = {}, ms = timeoutMs) {
      if (closed) return Promise.reject(Object.assign(new Error("Desktop access has stopped."), { code: "native_unavailable" }));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error("Desktop operation timed out."), { code: "timeout" })); }, ms);
        pending.set(id, { resolve, reject, timer });
        worker.send({ id, method, params });
      });
    },
    kill() { worker.kill(); },
    async close() { if (closed) return; await this.call("shutdown").catch(() => {}); closed = true; if (worker.exitCode === null) worker.kill(); },
  };
}

function windowRef(w) {
  return { id: String(w.id), app_id: w.appId, app_name: w.appName, bundle_or_exe: w.executable, pid: w.pid, title: w.title, origin: { x: w.bounds.x, y: w.bounds.y }, bounds: { ...w.bounds } };
}

function appIdentity(w) {
  return { pid: w.pid, name: w.appName, exe: w.executable, app_id: w.appId, title: w.title };
}

function describeAction(a) {
  if (!a) return "";
  if (a.type === "type") return `type ${JSON.stringify(a.text.length > 40 ? `${a.text.slice(0, 40)}…` : a.text)}`;
  if (a.type === "key") return `key ${[...(a.modifiers ?? []), a.key].join("+")}`;
  if (a.type === "drag") return `drag ${a.path.length} points`;
  if (a.type === "scroll") return `scroll ${a.delta} at ${a.x},${a.y}`;
  if (a.type === "wait") return `wait ${a.ms} ms`;
  return `${a.type.replace("_", " ")} at ${a.x},${a.y}`;
}

/**
 * The host. Options:
 * - native: a createNativeWorker() (or the same interface)
 * - spool: a media spool (media.mjs createMediaSpool) frames go to, or null
 * - settings(): { enabled, real_screen, real_screen_opt_in, real_screen_on, virtual_display, limits, deny_apps } now
 *   (real_screen and real_screen_opt_in: the server allows the person's screen for this account, both true;
 *   real_screen_on: this device's own setting is on)
 * - refresh(): read the server's switch and limits now (before each open and each discover of the person's
 *   screen); true only when the server answered. Without it, or when it is false or throws, the person's
 *   screen is refused (the agent's own display is not affected)
 * - context(): { ancestors, self_pids, tty_pids, chat } now, or a promise of it (chat: per-chat counts)
 * - virtual: a createVirtualHost() for app_id "virtual:<name>", or null
 * - onEvent(event): `computer.session` events; onState(states); onFrame(frame)
 */
export async function createPortableHost({ native: firstNative, nativeFactory = null, spool = null, settings, context = () => ({}), refresh = null, virtual = null, onEvent = () => {}, onState = () => {}, onFrame = () => {}, platform = process.platform }) {
  let native = firstNative;
  let availability = await native.ready;
  let nativeDown = false;
  const restarts = [];
  let restartedNote = false;
  const os = osName(platform);
  const sessions = new Map();
  const shots = new Map();
  const virtualOwners = new Map(); // virtual session id → the connection that opened it
  let lease = null;
  let closed = false;

  const limits = () => normalizeLimits(settings()?.limits);
  const emit = (s, event, by, extra = {}) => {
    try {
      onEvent({ event, by, session_id: s.id, app_id: s.window.appId, app_name: s.window.appName, bundle_or_exe: s.window.executable, mode: s.mode, ...(s.approval ? { approval: s.approval } : {}), ...(s.screen ? { screen: s.screen } : {}), os, ...extra });
    } catch { /* the trace is best effort */ }
  };
  const publicState = () => [...sessions.values()].map((s) => ({
    id: s.id, phase: s.phase, mode: s.mode, purpose: s.purpose, status: s.status ?? "",
    app: { app_id: s.window.appId, app_name: s.window.appName, bundle_or_exe: s.window.executable, pid: s.window.pid },
    window: { id: String(s.window.id), title: s.window.title }, windows: (s.windows ?? []).map((w) => ({ id: String(w.id), title: w.title })),
    approval: s.approval ?? null, actions: s.actions, actions_left: Math.max(0, limits().actions_per_session - s.actions),
    seconds_left: Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 1000)), can_continue: s.phase === "paused", log: s.log.slice(-30),
    frame: s.lastFrame ?? null, chat: s.chat ?? null, hidden: s.hidden === true, window_bounds: { ...s.window.bounds },
  }));
  const update = () => { try { onState(publicState()); } catch { /* UI is best effort */ } };

  async function stop(s, event, by, extra) {
    if (!sessions.has(s.id)) return;
    sessions.delete(s.id);
    s.phase = "ended"; s.observation = null;
    if (lease === s.id) lease = null;
    await native.call("stop").catch(() => {});
    emit(s, event, by, extra);
    update();
  }
  function pause(s, by, status) {
    if (s.phase !== "working") return;
    s.phase = "paused"; s.observation = null; s.status = status;
    void native.call("stop").catch(() => {});
    emit(s, "paused", by);
    update();
  }
  const attach = (worker) => worker.onEvent((value) => {
    if (worker !== native) return;
    if (value.event === "person-input") for (const s of sessions.values()) if (s.phase === "working" && s.mode === "control") pause(s, "person", "Your input paused computer use. Choose Continue when you are ready.");
    if (value.event === "unavailable") {
      nativeDown = true;
      for (const s of [...sessions.values()]) void stop(s, "stopped", "limit", { reason: "native_unavailable" });
    }
  });
  attach(native);
  /**
   * After the native worker died (its held input already released by createNativeWorker), a new one
   * is started on the next call, at most 3 times in 10 minutes. Whether the host can work now.
   */
  async function ensureNative() {
    if (!nativeDown || !nativeFactory || closed) return !nativeDown;
    const now = Date.now();
    while (restarts.length && now - restarts[0] > 600_000) restarts.shift();
    if (restarts.length >= 3) return false;
    restarts.push(now);
    try {
      const next = nativeFactory();
      const ready = await next.ready;
      native = next; availability = ready; nativeDown = !ready.supported; restartedNote = ready.supported;
      attach(next);
    } catch {
      return false;
    }
    return !nativeDown;
  }
  const ticker = setInterval(() => {
    const l = limits();
    // The server no longer allows the person's screen for this account (its latest answer): those sessions end.
    if (sessions.size && !serverRealScreen(settings() ?? {})) { void stopRealScreen("server"); return; }
    for (const s of [...sessions.values()]) {
      if (Date.now() >= s.expiresAt && s.phase !== "approval") void stop(s, "expired", "limit");
      else if (s.phase === "working" && Date.now() - s.lastOperation > l.idle_pause_seconds * 1000) pause(s, "limit", "Paused after a while without work. Choose Continue when ready.");
    }
  }, 1000);
  ticker.unref?.();

  // Windows: the agent's ancestor processes (its terminal or IDE) read natively when the app passed none.
  let nativeAncestors = null;
  async function ancestorsOf(ctx) {
    if (Array.isArray(ctx.ancestors) && ctx.ancestors.length) return ctx.ancestors;
    if (platform !== "win32") return ctx.ancestors ?? [];
    if (!nativeAncestors) nativeAncestors = await native.call("ancestors", { pid: process.pid }).catch(() => null);
    return nativeAncestors ?? [];
  }

  async function screenOf(w) {
    const screens = await native.call("screens").catch(() => []);
    const cx = w.bounds.x + w.bounds.width / 2, cy = w.bounds.y + w.bounds.height / 2;
    const screen = screens.find((s) => cx >= s.x && cx < s.x + s.width && cy >= s.y && cy < s.y + s.height) ?? screens.find((s) => s.primary) ?? screens[0];
    return screen ? { id: String(screen.id), width: screen.width, height: screen.height, scale: w.scale ?? screen.scale ?? 1 } : null;
  }

  async function capture(w) {
    const l = limits();
    let frame = await native.call("capture", { window: w }, 15_000);
    let grid = luminanceGrid(fitLongSide(frame, l.model_long_side));
    // Wait (briefly) for the window to settle: until two frames match (a blinking caret may never let it; then the last frame).
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await sleep(attempt === 0 ? 60 : 90);
      const next = await native.call("capture", { window: w }, 15_000);
      const nextGrid = luminanceGrid(fitLongSide(next, l.model_long_side));
      const same = compareGrids(grid, nextGrid).changed === 0;
      frame = next; grid = nextGrid;
      if (same) break;
    }
    return frame;
  }

  async function observation(s, w, { store = true } = {}) {
    const l = limits();
    const raw = await capture(w);
    const masked = paintBoxes(raw, raw.secure ?? []);
    const model = fitLongSide(raw, l.model_long_side);
    const tiny = model.width * model.height <= 160 * 160;
    const bytes = tiny ? encodePng(model) : encodeJpeg(model, { quality: 80 });
    const mime = tiny ? "image/png" : "image/jpeg";
    const sha = sha256(bytes);
    let full = null;
    if (Math.max(raw.width, raw.height) > Math.max(model.width, model.height)) {
      const big = fitLongSide(raw, l.full_long_side);
      const png = encodePng(big, { level: 3 });
      full = { bytes: png, width: big.width, height: big.height, sha256: sha256(png) };
    }
    const ocr = raw.ocr === "client" ? "client" : "none";
    if (store && spool) {
      try { spool.put({ bytes, mime, width: model.width, height: model.height, full, thumb: encodeJpeg(fitLongSide(model, 320), { quality: 70 }), ocr, masked }); } catch { /* the archive copy is best effort */ }
    }
    const ratio = model.width / raw.width;
    const scaled = (r) => ({ x: r.x * ratio, y: r.y * ratio, width: r.width * ratio, height: r.height * ratio });
    const caret = raw.caret ? scaled(raw.caret) : null;
    // What the host can read on screen (macOS: AX / text recognition), for the per-act rules only: never sent to the model.
    const texts = Array.isArray(raw.texts) ? raw.texts.filter((t) => t && typeof t.text === "string" && [t.x, t.y, t.width, t.height].every(Number.isFinite)).slice(0, 2000).map((t) => ({ ...scaled(t), text: t.text.slice(0, 200) })) : null;
    const secureFields = (Array.isArray(raw.secure_fields) ? raw.secure_fields : raw.secure ?? []).filter((r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite)).map(scaled);
    const id = randomUUID();
    const value = {
      id, at: Date.now(), window: w, sha, mime, bytes,
      model: { width: model.width, height: model.height }, grid: luminanceGrid(model), caret, texts, secureFields,
      ref: { id, width: model.width, height: model.height, sha256: sha, mime, ...(full ? { full: { width: full.width, height: full.height, sha256: full.sha256 } } : {}), ocr, masked },
    };
    s.lastFrame = { sha, width: model.width, height: model.height, mime, data_url: `data:${mime};base64,${bytes.toString("base64")}`, at: now() };
    try { onFrame({ session_id: s.id, ...s.lastFrame }); } catch { /* live view is best effort */ }
    return value;
  }

  function countShot(s) {
    const key = s.chat ?? "";
    const n = (shots.get(key) ?? 0) + 1;
    shots.set(key, n);
    return n <= limits().screenshots_per_chat;
  }

  async function observeTool(s, includeImage) {
    if (s.phase !== "working") return mcpResult(failure("paused_by_person", s.status || "Paused. Wait for the person to choose Continue.", { next: "computer_session_status" }));
    if (!countShot(s)) return mcpResult(failure("screenshot_limit", "This chat reached its screenshot limit. Finish the task another way."));
    const w = await native.call("window", { id: s.window.id });
    if (w.identity !== s.window.identity) { await stop(s, "closed", "limit", { reason: "window_unavailable" }); return mcpResult(failure("window_unavailable", "The session's app closed or restarted. Start a new session.")); }
    let obs = s.resumeObservation && Date.now() - s.resumeObservation.at < limits().observation_ttl_seconds * 1000 && s.resumeObservation.window.identity === w.identity ? s.resumeObservation : null;
    s.resumeObservation = null;
    if (!obs) obs = await observation(s, w);
    const state = await native.call("state");
    if (s.phase !== "working" || !state.available) return mcpResult(failure("paused_by_person", "Paused. Wait for the person to choose Continue."));
    s.window = w; s.lastOperation = Date.now(); s.observation = { ...obs, generation: s.generation };
    update();
    const l = limits();
    return mcpResult(observeResult({ session_id: s.id, observation: obs.ref, window: windowRef(w), screen: s.screen, scale: w.bounds.width / obs.model.width, dpi: w.dpi, monitor_id: w.monitor, cursor: await native.call("cursor").catch(() => null), os, expires_in_ms: l.observation_ttl_seconds * 1000, actions_left: Math.max(0, l.actions_per_session - s.actions), seconds_left: Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 1000)) }), includeImage ? { data: obs.bytes, mime: obs.mime } : null);
  }

  async function actTool(s, args) {
    const l = limits();
    const started = Date.now();
    const base = { session_id: s.id, request_id: args.request_id, intent: args.intent, started_at: new Date(started).toISOString(), os };
    const finish = (fields, image) => {
      const ended = Date.now();
      const result = actResult({ ...base, ...fields, ended_at: new Date(ended).toISOString(), duration_ms: ended - started });
      s.log.push({ at: base.started_at, action: describeAction(fields.action ?? args.action), intent: args.intent, ok: result.ok, code: result.code ?? null });
      if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
      update();
      return mcpResult(result, image);
    };
    if (s.mode !== "control") return finish({ ok: false, code: "scope_denied", message: "This session is read-only (mode observe)." });
    if (s.phase !== "working") return finish({ ok: false, code: "paused_by_person", message: s.status || "Paused. Wait for the person to choose Continue.", next: "computer_session_status" });
    if (s.requests.has(args.request_id)) return finish({ ok: false, code: "duplicate_request", message: "Use a new request_id. Observe instead of repeating input." });
    s.requests.add(args.request_id);
    if (s.actions >= l.actions_per_session) { await stop(s, "stopped", "limit", { reason: "action_limit" }); return finish({ ok: false, code: "action_limit", message: `Start a new session after ${l.actions_per_session} actions.` }); }
    const observed = s.observation; s.observation = null;
    if (!observed || observed.id !== args.observation_id || Date.now() - observed.at > l.observation_ttl_seconds * 1000) return finish({ ok: false, code: "stale_observation", message: "Observe the window again before acting.", next: "computer_observe" });
    const valid = validateAction(args.action, observed.model);
    if (!valid.ok) return finish({ ok: false, code: valid.code, message: valid.message, frame_before: { sha256: observed.sha } });
    const action = valid.action;
    // At most actions_per_second.
    const gap = 1000 / l.actions_per_second - (Date.now() - s.lastAct);
    if (gap > 0) await sleep(gap);
    const current = await native.call("window", { id: s.window.id });
    const common = { action, frame_before: { sha256: observed.sha }, window: windowRef(current), screen: s.screen, dpi: current.dpi, monitor_id: current.monitor, scale: current.bounds.width / observed.model.width };
    if (current.identity !== observed.window.identity || JSON.stringify(current.bounds) !== JSON.stringify(observed.window.bounds)) return finish({ ...common, ok: false, code: "window_changed", message: "The window moved or changed. Observe again.", next: "computer_observe" });
    // Native coordinates; every point must hit the session's window (never another app's).
    const mapped = action.type === "drag" ? action.path.map((p) => mapPoint(p, observed.model, current.bounds)) : action.x !== undefined ? [mapPoint(action, observed.model, current.bounds)] : [];
    const hitAll = async (w) => !mapped.length || (await native.call("hit", { window: w, points: mapped.map((m) => m.screen) })).inside.every(Boolean);
    if (!(await hitAll(current))) return finish({ ...common, ok: false, code: "window_occluded", message: "Another window covers this point, or it is outside the session's window. Observe again." });
    // Tolerant stale check (caret masked): the action targets what the model saw.
    if (action.type !== "wait") {
      const fresh = await native.call("capture", { window: current }, 15_000);
      // The observation's grid was taken after masking: mask the fresh frame the same way.
      paintBoxes(fresh, fresh.secure ?? []);
      const grid = luminanceGrid(fitLongSide(fresh, l.model_long_side));
      const compare = compareGrids(observed.grid, grid, { mask: observed.caret ? [observed.caret] : [] });
      if (compare.stale) return finish({ ...common, ok: false, code: "stale_observation", message: "The window changed since the observation. Observe again.", next: "computer_observe" });
    }
    // No question: the person turned the real screen on, which is the consent (sessionRules).
    const approval = { asked: false, by: "setting" };
    const cursorBefore = await native.call("cursor").catch(() => null);
    // The engine gave up on this call: no input with nobody waiting for it.
    if (s.connection.cancelled) return finish({ ...common, approval, ok: false, code: "cancelled", message: "The request was cancelled.", may_have_acted: false });
    const point = mapped.length === 1 ? { model: mapped[0].model, screen: mapped[0].screen } : undefined;
    const path = action.type === "drag" ? mapped.map((m) => ({ model: m.model, screen: m.screen })) : undefined;
    const screenAction = action.type === "drag" ? { ...action, path: mapped.map((m) => m.screen) } : mapped.length ? { ...action, x: mapped[0].screen.x, y: mapped[0].screen.y } : action;
    s.actions += 1; s.lastAct = Date.now();
    try {
      if (action.type === "wait") await sleep(action.ms);
      else await native.call("act", { window: current, generation: s.generation, action: screenAction, deadline: s.expiresAt }, 30_000);
    } catch (error) {
      const code = error.code === "paused_by_person" ? "paused_by_person" : error.code ?? "input_interrupted";
      if (code === "paused_by_person") pause(s, "person", "Your input paused computer use. Choose Continue when you are ready.");
      return finish({ ...common, approval, point, path, cursor_before: cursorBefore, ok: false, code, message: error.message, may_have_acted: action.type !== "wait", next: "computer_session_status" });
    }
    s.lastOperation = Date.now();
    const cursorAfter = await native.call("cursor").catch(() => null);
    const done = { ...common, approval, point, path, cursor_before: cursorBefore, cursor_after: cursorAfter, ok: true, may_have_acted: action.type !== "wait" };
    if (!args.observe_after) return finish({ ...done, next: "computer_observe" });
    await sleep(action.type === "wait" ? 0 : 150);
    if (s.phase !== "working" || !countShot(s)) return finish({ ...done, next: "computer_observe" });
    try {
      const w = await native.call("window", { id: s.window.id });
      const after = await observation(s, w);
      s.window = w; s.observation = { ...after, generation: s.generation };
      return finish({ ...done, frame_after: { sha256: after.sha }, observation: after.ref, window: windowRef(w), next: "computer_act" }, { data: after.bytes, mime: after.mime });
    } catch (error) {
      return finish({ ...done, next: "computer_observe", message: `The action was done, but the window could not be observed: ${error.message}` });
    }
  }

  async function discover() {
    const ctx = (await context()) ?? {};
    const config = settings() ?? {};
    const windows = await native.call("list");
    const ancestors = await ancestorsOf(ctx);
    const apps = new Map();
    for (const w of windows) {
      const denied = deniedApp(appIdentity(w), { ancestors, self_pids: [...(ctx.self_pids ?? []), process.pid, native.pid].filter(Boolean), tty_pids: ctx.tty_pids, deny_apps: config.deny_apps });
      const key = `${w.appId}\0${w.pid}`;
      if (!apps.has(key)) apps.set(key, { app_id: w.appId, name: w.appName, pid: w.pid, ...(denied ? { available: false, reason: denied.reason } : {}), windows: [] });
      if (!denied) apps.get(key).windows.push({ id: String(w.id), title: w.title });
    }
    const screens = await native.call("screens").catch(() => []);
    const virtualOk = Boolean(virtual) && config.virtual_display !== false;
    return mcpResult({ ok: true, os, contract: CONTRACT_VERSION, screens: screens.map((s) => ({ id: String(s.id), width: s.width, height: s.height, scale: s.scale, primary: Boolean(s.primary) })), apps: [...apps.values()], modes: ["observe", "control"], real_screen: true, virtual_display: virtualOk, ...(virtualOk ? { virtual_hint: virtual.hint } : {}) });
  }

  /** The server's switch read just now: true only when it answered (no refresh, a false or a throw: not read). */
  async function freshRead() {
    if (typeof refresh !== "function") return false;
    return Promise.resolve().then(refresh).then((ok) => ok === true, () => false);
  }

  async function openSession(connection, args, verified) {
    // The server's switch and limits as of now (`call` read them), so a stricter value (off) applies at once.
    const config = settings() ?? {};
    const ctx = (await context()) ?? {};
    if (!config.enabled) return mcpResult(failure("disabled", config.message || "Computer use is turned off."));
    const rules = sessionRules({ display: "real", server: config, optIn: config.real_screen_on === true, verified });
    if (!rules.open) return mcpResult(failure(rules.code, rules.message));
    if (lease) return mcpResult(failure("session_busy", "Another computer use session is open. Close it first."));
    const windows = (await native.call("list")).filter((w) => w.appId === args.app_id && (args.pid === undefined || w.pid === args.pid));
    if (!windows.length) return mcpResult(failure("app_unavailable", "That app has no visible window. Open it yourself, then call computer_discover again."));
    const denied = deniedApp(appIdentity(windows[0]), { ancestors: await ancestorsOf(ctx), self_pids: [...(ctx.self_pids ?? []), process.pid, native.pid].filter(Boolean), tty_pids: ctx.tty_pids, deny_apps: config.deny_apps });
    if (denied) return mcpResult(failure(denied.code, denied.reason));
    const preferred = args.window_id !== undefined ? windows.find((w) => String(w.id) === args.window_id) : windows[0];
    if (!preferred) return mcpResult(failure("window_unavailable", "That window is not open. Call computer_discover again."));
    if (connection.cancelled) return mcpResult(failure("cancelled", "The request was cancelled."));
    const l = limits();
    const s = {
      id: randomUUID(), connection, window: preferred, windows, mode: args.mode, purpose: args.purpose, phase: "working", status: "",
      approval: "setting", chat: connection.internal === false ? null : ctx.chat ?? null, actions: 0, requests: new Set(), observation: null, resumeObservation: null, log: [],
      lastOperation: Date.now(), lastAct: 0, generation: 0, expiresAt: Date.now() + l.session_seconds * 1000, screen: await screenOf(preferred),
    };
    try {
      const current = await native.call("window", { id: preferred.id });
      if (current.identity !== preferred.identity) throw Object.assign(new Error("The app restarted. Start a new session."), { code: "window_unavailable" });
      if (s.mode === "control") await native.call("focus", { window: current });
      const started = await native.call("start");
      s.generation = started?.generation ?? 0;
      s.window = current; s.screen = await screenOf(current);
    } catch (error) {
      return mcpResult(failure(error.code ?? "window_unavailable", error.message));
    }
    lease = s.id; sessions.set(s.id, s);
    s.approved = { window_id: String(s.window.id), app_id: s.window.appId };
    emit(s, "opened", "agent", restartedNote ? { reason: "worker_restarted" } : {});
    restartedNote = false;
    // The person's real-screen setting is the approval: no question was asked.
    emit(s, "approved", "agent", { by_setting: true });
    update();
    return mcpResult({ ok: true, session_id: s.id, state: "active", mode: s.mode, approval: s.approval, window: windowRef(s.window), screen: s.screen, os, expires_in_seconds: l.session_seconds, actions_left: l.actions_per_session });
  }

  async function call(connection, name, rawArgs) {
    if (!TOOLS.includes(name)) return mcpResult(failure("unknown_tool", "Unknown computer use tool."));
    const valid = validateCall(name, rawArgs);
    if (!valid.ok) return mcpResult(failure(valid.code, valid.message));
    const args = valid.args;
    // The agent's own display: no native access to the person's screen is involved.
    if (virtual && name === "computer_open_session" && args.app_id.startsWith("virtual:")) {
      // The server's switch as of now, as for the person's screen.
      if (typeof refresh === "function") await Promise.resolve().then(refresh).catch(() => false);
      if (!(settings() ?? {}).enabled) return mcpResult(failure("disabled", settings()?.message || "Computer use is turned off."));
      const opened = await virtual.open(args);
      if (opened.ok) virtualOwners.set(opened.session_id, connection);
      return mcpResult(opened);
    }
    if (virtual && args.session_id && virtual.owns(args.session_id)) {
      if (virtualOwners.get(args.session_id) !== connection) return mcpResult(failure("session_unavailable", "This session has ended. Open a new one."));
      return virtual.call(name, args);
    }
    // The person's screen is off (the default): refused (and its windows not listed) before any desktop access.
    // It needs the server's yes for this account read just now (a cached answer, or none, is not enough).
    let verified = false;
    if (name === "computer_open_session" || name === "computer_discover") verified = await freshRead();
    if (name === "computer_open_session") {
      const config = settings() ?? {};
      const rules = sessionRules({ display: "real", server: config, optIn: config.real_screen_on === true, verified });
      if (!rules.open) return mcpResult(failure(rules.code, rules.message));
    }
    if (name === "computer_discover") {
      const config = settings() ?? {};
      const rules = sessionRules({ display: "real", server: config, optIn: config.real_screen_on === true, verified });
      if (rules.open && nativeDown) await ensureNative();
      const why = !rules.open ? rules.message : !availability.supported || nativeDown ? availability.error ?? "Desktop access is unavailable." : null;
      if (why) return mcpResult({ ok: true, os, contract: CONTRACT_VERSION, real_screen: false, real_screen_unavailable: why, screens: [], apps: [], modes: ["observe", "control"], virtual_display: Boolean(virtual) && config.virtual_display !== false, ...(virtual ? { virtual_hint: virtual.hint } : {}) });
    }
    if (nativeDown && !(await ensureNative())) return mcpResult(failure("native_unavailable", "Desktop access stopped. Try again in a few minutes, or restart the app."));
    if (!availability.supported) return mcpResult(failure(availability.code ?? "desktop_unavailable", availability.error ?? "Computer use is unavailable on this desktop."));
    if (name === "computer_discover") return discover();
    if (name === "computer_open_session") return openSession(connection, args, verified);
    const s = sessions.get(args.session_id);
    if (!s || s.connection !== connection) return mcpResult(failure("session_unavailable", "This session has ended. Open a new one."));
    // The server's latest answer no longer allows the person's screen: the session ends before anything else.
    if (!serverRealScreen(settings() ?? {}) && name !== "computer_close_session") {
      await stop(s, "stopped", "server");
      return mcpResult(failure("real_screen_unavailable", REAL_SCREEN_NOT_OPTED_IN_MESSAGE));
    }
    if (name === "computer_close_session") { await stop(s, "closed", "agent"); return mcpResult({ ok: true, session_id: s.id, state: "closed" }); }
    if (name === "computer_session_status") {
      const l = limits();
      return mcpResult({ ok: true, session_id: s.id, state: s.phase === "working" ? "active" : s.phase, mode: s.mode, approval: s.approval, message: s.status || undefined, actions_left: Math.max(0, l.actions_per_session - s.actions), seconds_left: Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 1000)), window: windowRef(s.window), os });
    }
    if (name === "computer_observe") return observeTool(s, args.include_image);
    return actTool(s, args);
  }

  /** One MCP client (an engine connection): JSON-RPC in, JSON-RPC out. */
  /**
   * One MCP connection. `internal` false: a connection from outside the app's own engine (the copied CLI
   * connection), whose calls belong to no chat of this app.
   */
  function connect({ internal = true } = {}) {
    const connection = { id: randomUUID(), busy: false, closed: false, internal: internal !== false };
    return {
      id: connection.id,
      async handle(message) {
        if (!record(message) || message.jsonrpc !== "2.0" || !RPC.has(message.method)) return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32601, message: "Method not available." } };
        if (message.method === "notifications/initialized") return null;
        if (message.method === "notifications/cancelled") {
          // The engine gave up on the call in flight (its timeout, or the person stopped the turn): a question
          // it is waiting on ends unanswered, so nothing opens or acts after it.
          const id = message.params?.requestId;
          if (id !== undefined && id !== null && id === connection.inflight) {
            connection.cancelled = true;
          }
          return null;
        }
        let result;
        try {
          if (message.method === "initialize") result = { protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: CONTRACT_VERSION }, instructions: INSTRUCTIONS };
          else if (message.method === "ping") result = {};
          else if (message.method === "tools/list") result = { tools: toolDefinitions({ limits: limits() }) };
          else {
            const name = message.params?.name, args = message.params?.arguments ?? {};
            const light = name === "computer_session_status" || name === "computer_close_session";
            if (connection.busy && !light) result = mcpResult(failure("busy", "Wait for the previous computer use call to finish."));
            else {
              if (!light) { connection.busy = true; connection.inflight = message.id ?? null; connection.cancelled = false; }
              try { result = await call(connection, name, args); } finally { if (!light) { connection.busy = false; connection.inflight = null; } }
            }
          }
        } catch (error) {
          result = mcpResult(failure(error.code ?? "desktop_error", error.message ?? "Computer use failed."));
        }
        return message.id === undefined ? null : { jsonrpc: "2.0", id: message.id, result };
      },
      async close() {
        connection.closed = true;
        for (const s of [...sessions.values()]) if (s.connection === connection) await stop(s, "closed", "agent", { reason: "disconnected" });
        for (const [id, owner] of [...virtualOwners]) if (owner === connection) { virtualOwners.delete(id); if (virtual?.owns(id)) await virtual.control({ session_id: id, action: "stop" }).catch(() => {}); }
      },
    };
  }

  /** Desktop transport: a loopback socket with a token, found through `<dir>/engine-connection.json` (the bundled relay reads it; the copied CLI connection reads `<dir>/cli-connection.json`). */
  async function listen(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Two tokens: the app's own engine relay reads engine-connection.json; the copied CLI connection reads
    // cli-connection.json, and its connections are external (no chat). (A CLI connection copied
    // before these names pointed at connection.json, which is no longer written: it fails to connect.)
    const discoveryPath = path.join(dir, "engine-connection.json");
    const externalDiscoveryPath = path.join(dir, "cli-connection.json");
    const token = randomBytes(32).toString("hex");
    const externalToken = randomBytes(32).toString("hex");
    const sockets = new Set();
    const server = createServer((socket) => {
      if (closed || sockets.size >= 16) { socket.destroy(); return; }
      sockets.add(socket);
      let connection = null;
      let incoming = "", authenticated = false;
      const authTimer = setTimeout(() => socket.destroy(), 5000);
      socket.setEncoding("utf8");
      socket.once("close", () => { clearTimeout(authTimer); sockets.delete(socket); void connection?.close(); });
      socket.on("error", () => socket.destroy());
      socket.on("data", (chunk) => {
        incoming += chunk;
        if (incoming.length > 1_048_576) { socket.destroy(); return; }
        let end;
        while ((end = incoming.indexOf("\n")) >= 0) {
          const line = incoming.slice(0, end); incoming = incoming.slice(end + 1);
          let message; try { message = JSON.parse(line); } catch { socket.destroy(); return; }
          if (!authenticated) {
            const candidate = typeof message?.token === "string" ? Buffer.from(message.token) : Buffer.alloc(0);
            const matches = (expected) => candidate.length === expected.length && timingSafeEqual(candidate, Buffer.from(expected));
            const internal = matches(token);
            if (!internal && !matches(externalToken)) { socket.destroy(); return; }
            connection = connect({ internal });
            authenticated = true; clearTimeout(authTimer); continue;
          }
          void connection.handle(message).then((reply) => { if (reply && !socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`); });
        }
      });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(undefined)); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Computer use could not open its local connection.");
    for (const [file, value] of [[discoveryPath, token], [externalDiscoveryPath, externalToken]]) {
      const temp = `${file}.${randomUUID()}`;
      await writeFile(temp, JSON.stringify({ version: 1, host: "127.0.0.1", port: address.port, token: value }), { mode: 0o600, flag: "wx" });
      await rename(temp, file);
    }
    return { discoveryPath, externalDiscoveryPath, close: async () => { for (const socket of sockets) socket.destroy(); server.close(); await unlink(discoveryPath).catch(() => {}); await unlink(externalDiscoveryPath).catch(() => {}); } };
  }

  /** Controls from the person (host channel only): stop | takeover | continue | hide | show. */
  async function control({ session_id, action }) {
    if (virtual?.owns(session_id)) return virtual.control({ session_id, action });
    const s = sessions.get(session_id);
    if (!s) throw new Error("This computer use session has ended.");
    if (action === "stop") return stop(s, "stopped", "person");
    if (action === "takeover") return pause(s, "person", "You took over. Choose Continue when you are ready.");
    if (action === "hide" || action === "show") { s.hidden = action === "hide"; update(); return undefined; }
    if (action !== "continue" || s.phase !== "paused") throw new Error("This action is unavailable.");
    const current = await native.call("window", { id: s.window.id });
    if (current.identity !== s.window.identity) { await stop(s, "closed", "limit", { reason: "window_unavailable" }); throw new Error("The app closed or restarted. Start a new session."); }
    if (s.mode === "control") await native.call("focus", { window: current });
    const started = await native.call("start");
    s.generation = started?.generation ?? s.generation;
    s.window = current; s.phase = "working"; s.status = ""; s.lastOperation = Date.now();
    emit(s, "continued", "person");
    // One observation now, so what the person changed is in the next result.
    try { s.resumeObservation = await observation(s, current); } catch { s.resumeObservation = null; }
    update();
    return undefined;
  }

  /** Ends every session (server switch off, app quitting). */
  async function stopAll(by = "server", event = "stopped") {
    for (const s of [...sessions.values()]) await stop(s, event, by);
    await virtual?.stopAll(by, event);
  }

  /** Ends the sessions on the person's screen only (the agent's own display keeps running). */
  async function stopRealScreen(by = "server", event = "stopped") {
    for (const s of [...sessions.values()]) await stop(s, event, by);
  }

  /** Whether the latest press (key or button) within `withinMs` was synthetic (injected by a program). */
  /**
   * Whether a physical key or button press (not injected by a program, not a remote-debugging
   * click that makes no OS input) came within `withinMs`: the person's own answer.
   */
  async function physicalInput(withinMs = 1500, { foregroundPid = null, rect = null, keys = ["Enter", "Space"] } = {}) {
    const value = await native.call("input-source").catch(() => null);
    if (!value || !value.at || value.synthetic || Date.now() - value.at >= withinMs) return false;
    // In the answering app's window (when the worker knows which app was in front).
    if (foregroundPid && Number.isInteger(value.foreground_pid) && value.foreground_pid !== foregroundPid) return false;
    // A pointer press must land on the pressed button (screen pixels); a key press must be one that presses a button.
    if (value.kind === "pointer" && rect) {
      if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return false;
      return value.x >= rect.x - 4 && value.x <= rect.x + rect.width + 4 && value.y >= rect.y - 4 && value.y <= rect.y + rect.height + 4;
    }
    if (value.kind === "key") return keys.includes(value.key);
    return !rect;
  }

  async function syntheticInput(withinMs = 5000) {
    const value = await native.call("input-source").catch(() => null);
    return Boolean(value && value.synthetic && Date.now() - value.at < withinMs);
  }

  /** Starts input watching for a pending approval (Windows hooks run only while needed). */
  async function watchInput() { await native.call("watch").catch(() => {}); }

  async function close() {
    if (closed) return;
    closed = true; clearInterval(ticker);
    await stopAll("agent", "closed");
    await virtual?.close();
    await native.close();
  }

  update();
  const allState = () => [...publicState(), ...(virtual ? virtual.state() : [])];
  return { get availability() { return availability; }, os, connect, listen, control, stopAll, stopRealScreen, syntheticInput, physicalInput, watchInput, state: allState, close };
}
