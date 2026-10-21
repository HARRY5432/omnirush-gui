// Computer use, the agent's own display (contract v2, app_id "virtual:<name>"):
// a screen that belongs to the agent alone, with its own cursor and a fresh
// browser profile, driven like a person would (glide to the target, click,
// type, scroll, drag, keys, tabs and windows). Nothing the agent does here
// reaches the person's screen, mouse or keyboard, so nothing here asks: the
// person watches (live frames with the agent's cursor drawn in) and can Stop.
//
// Backends (`startBackend(name, options)` → { ok, kind, display, width,
// height, wm, packages, browser, worker, close } | failure):
//   xvfb     Linux: Xvfb + openbox + a browser on a private profile
//            (startXvfbBackend below, virtual-worker.mjs for capture/input);
//   other    the desktop app's agent-only browser (macOS, Windows, Linux
//            without Xvfb), same worker interface: call("capture"|"pointer"|
//            "act"|"release").
//
// The same file ships in omnirush-cli (src/computer-use/) and omnirush-gui
// (apps/server/src/computer-use/shared/); PARITY.sha256 lists it in both.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { actResult, failure, mapPoint, mcpResult, normalizeLimits, observeResult, osName, validateAction } from "./contract.mjs";
import { compareGrids, decodePng, drawCursor, encodeJpeg, encodePng, fitLongSide, luminanceGrid } from "./image.mjs";
import { sha256 } from "./media.mjs";
import { createNativeWorker } from "./portable-host.mjs";

/** The agent display's size: the model image's own size, so a point in the image is the same pixel on the display. */
export const VIRTUAL_SIZE = Object.freeze({ width: 1280, height: 800 });
export const VIRTUAL_WORKER_PATH = fileURLToPath(new URL("./virtual-worker.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// ------------------------------------------------------------ Linux helpers

/** Where a program is on PATH, or null. */
export function which(name, env = process.env) {
  for (const dir of String(env?.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

/** A free X display number from `from` (no /tmp/.X11-unix/X<n> socket, no lock file). */
export function freeDisplay(from = 90, to = 199) {
  let used = new Set();
  try { used = new Set(readdirSync("/tmp/.X11-unix").map((n) => Number(n.replace(/^X/, "")))); } catch { /* none */ }
  for (let n = from; n <= to; n++) if (!used.has(n) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  return null;
}

function versionOf(cmd, args, env) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 3_000, env });
    const m = /(\d+\.\d+(?:\.\d+)*)/.exec(`${r.stdout || ""}${r.stderr || ""}`);
    return m ? m[1] : null;
  } catch { return null; }
}

/** Xvfb's and openbox's versions, for the computer.session record. */
export function virtualPackages(env = process.env) {
  return { xvfb: versionOf("Xvfb", ["-version"], env), openbox: versionOf("openbox", ["--version"], env) };
}

const BROWSERS = [
  ["chromium", "chromium"], ["chromium-browser", "chromium"], ["google-chrome", "chromium"], ["google-chrome-stable", "chromium"],
  ["microsoft-edge", "chromium"], ["microsoft-edge-stable", "chromium"], ["brave-browser", "chromium"], ["firefox", "firefox"], ["firefox-esr", "firefox"],
];

/** The browser the agent's display opens: OMNIRUSH_CU_BROWSER (a path), else the first one on PATH. */
export function findBrowser(env = process.env) {
  const given = String(env?.OMNIRUSH_CU_BROWSER || "").trim();
  if (given && existsSync(given)) return { path: given, kind: /firefox/i.test(path.basename(given)) ? "firefox" : "chromium", name: path.basename(given) };
  for (const [name, kind] of BROWSERS) { const found = which(name, env); if (found) return { path: found, kind, name }; }
  return null;
}

/** The arguments for a fresh, private browser window filling the display (profile: a new empty folder). */
export function browserArgs(browser, { profile, url = "about:blank", width = VIRTUAL_SIZE.width, height = VIRTUAL_SIZE.height, root = false } = {}) {
  if (browser.kind === "firefox") return ["-profile", profile, "-no-remote", "-new-instance", "-width", String(width), "-height", String(height), url];
  return [
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--password-store=basic", "--use-mock-keychain",
    "--disable-features=Translate,PasswordManagerOnboarding,AutofillServerCommunication,MediaRouter", "--disable-session-crashed-bubble", "--hide-crash-restore-bubble",
    "--disable-gpu", "--disable-dev-shm-usage", "--window-position=0,0", `--window-size=${width},${height}`, "--start-maximized", "--test-type",
    ...(root ? ["--no-sandbox"] : []), "--new-window", url,
  ];
}

/**
 * Linux backend: a new Xvfb display (+ openbox), the virtual worker on it, and, unless `browser` is false, a
 * browser on a brand-new profile opened on `url`. Nothing is shared with the person's own browser or display.
 */
export async function startXvfbBackend({ name = "main", env = process.env, nodePath = process.execPath, nodeEnv = {}, koffiPath = null, url = null, browser = true, size = VIRTUAL_SIZE, deps = {} } = {}) {
  if ((deps.platform ?? process.platform) !== "linux") return failure("virtual_unavailable", "This display needs Linux with Xvfb.");
  if (!which("Xvfb", env)) return failure("virtual_unavailable", "Xvfb is not installed (Debian/Ubuntu: sudo apt install xvfb openbox).");
  const number = freeDisplay(90);
  if (number === null) return failure("virtual_unavailable", "No free X display number.");
  const disp = `:${number}`;
  const children = [];
  const kill = (child) => { if (!child?.pid) return; try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill(); } catch { /* gone */ } } };
  const xvfb = spawn("Xvfb", [disp, "-screen", "0", `${size.width}x${size.height}x24`, "-nolisten", "tcp"], { stdio: "ignore", env, detached: true });
  xvfb.on("error", () => undefined);
  children.push(xvfb);
  for (let i = 0; i < 60 && !existsSync(`/tmp/.X11-unix/X${number}`); i++) await sleep(100);
  if (!existsSync(`/tmp/.X11-unix/X${number}`)) { kill(xvfb); return failure("virtual_unavailable", "Xvfb did not start."); }
  const displayEnv = { ...env, DISPLAY: disp, XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "" };
  let wm = null;
  if (which("openbox", env)) {
    const child = spawn("openbox", ["--sm-disable"], { stdio: "ignore", env: displayEnv, detached: true });
    child.on("error", () => undefined);
    children.push(child); wm = "openbox";
  }
  const worker = deps.worker ? deps.worker(disp) : createNativeWorker({ workerPath: VIRTUAL_WORKER_PATH, nodePath, nodeEnv: { ...nodeEnv, DISPLAY: disp, XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "" }, koffiPath });
  const ready = await worker.ready;
  let profile = null, opened = null;
  // The host exiting (a crash included) takes its display, window manager and browser with it.
  const onExit = () => { for (const child of children) kill(child); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ } } };
  process.once("exit", onExit);
  const close = async () => {
    process.removeListener("exit", onExit);
    await worker.close?.().catch(() => undefined);
    for (const child of [...children].reverse()) kill(child);
    if (profile) { await sleep(300); try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ } }
  };
  if (!ready.supported) { await close(); return failure(ready.code ?? "virtual_unavailable", ready.error ?? "The display's worker did not start."); }
  const found = browser ? findBrowser(env) : null;
  if (found) {
    profile = mkdtempSync(path.join(os.tmpdir(), "omnirush-cu-browser-"));
    const launch = (noSandbox) => {
      const child = spawn(found.path, browserArgs(found, { profile, url: url ?? "about:blank", width: size.width, height: size.height, root: noSandbox }), { stdio: "ignore", env: displayEnv, detached: true });
      child.on("error", () => undefined);
      children.push(child);
      return child;
    };
    // Chromium's sandbox first. Where it cannot start (root, or Ubuntu 23.10+ without the browser's AppArmor
    // profile: no unprivileged user namespaces) the browser exits at once: then without it, as Playwright does,
    // and the session record says so.
    const root = typeof process.getuid === "function" && process.getuid() === 0;
    let sandbox = found.kind === "chromium" && !root;
    let child = launch(!sandbox);
    if (sandbox) {
      const exited = await Promise.race([new Promise((resolve) => child.once("exit", () => resolve(true))), sleep(2500).then(() => false)]);
      if (exited) { sandbox = false; child = launch(true); }
    }
    opened = { name: found.name, kind: found.kind, version: versionOf(found.path, ["--version"], env), profile: "fresh", ...(found.kind === "chromium" ? { sandbox } : {}) };
  }
  const packages = deps.packages ?? virtualPackages(env);
  return { ok: true, kind: "xvfb", name, display: disp, width: ready.size?.width ?? size.width, height: ready.size?.height ?? size.height, wm, packages, browser: opened, worker, close };
}

// ------------------------------------------------------------------- host

function describeAction(a) {
  if (!a) return "";
  if (a.type === "type") return `type ${JSON.stringify(a.text.length > 40 ? `${a.text.slice(0, 40)}…` : a.text)}`;
  if (a.type === "key") return `key ${[...(a.modifiers ?? []), a.key].join("+")}`;
  if (a.type === "drag") return `drag ${a.path.length} points`;
  if (a.type === "scroll") return `scroll ${a.delta} at ${a.x},${a.y}`;
  if (a.type === "wait") return `wait ${a.ms} ms`;
  return `${a.type.replace("_", " ")} at ${a.x},${a.y}`;
}

/** How long an action's effects may take to show (page loads, menus, typing echo), in ms: the host waits until the screen is still. */
export const SETTLE_MS = Object.freeze({ click: 3000, double_click: 3000, right_click: 1500, key: 3000, type: 1500, scroll: 1200, drag: 1500, move: 500, wait: 0 });

/** An RGBA frame from a worker answer: raw pixels, or a PNG (older workers). */
export function rawFrame(answer) {
  if (record(answer) && Number.isInteger(answer.width) && Number.isInteger(answer.height) && answer.data && answer.data.length === answer.width * answer.height * 4) {
    return { width: answer.width, height: answer.height, data: answer.data instanceof Uint8Array ? answer.data : new Uint8Array(answer.data) };
  }
  if (record(answer) && answer.image) return decodePng(Buffer.from(answer.image));
  return null;
}

/**
 * The host of the agent's displays. Options:
 * - startBackend(name, { url, browser }) → backend (above) or a failure
 * - settings(): { enabled, virtual_display, limits } now
 * - context(): { chat } now (or a promise)
 * - spool: the media spool, or null
 * - onEvent(event) (`computer.session`), onState(states), onFrame(frame), onCursor({ session_id, from, to, action })
 * Returns { owns(id), open(args), call(name, args), state(), control(), stopAll(by), close(), hint }.
 */
export function createVirtualHost({ startBackend, settings = () => ({}), context = () => ({}), spool = null, onEvent = () => {}, onState = () => {}, onFrame = () => {}, onCursor = () => {}, platform = process.platform }) {
  const sessions = new Map();
  const shots = new Map();
  const osLabel = osName(platform);
  const limits = () => normalizeLimits(settings()?.limits);
  const emit = (s, event, by, extra = {}) => { try { onEvent({ event, by, session_id: s.id, app_id: s.app_id, app_name: s.app_name, bundle_or_exe: s.bundle, mode: s.mode, screen: s.screen, os: osLabel, virtual: s.virtualInfo, ...extra }); } catch { /* trace is best effort */ } };
  const windowOf = (s) => ({ id: "0", app_id: s.app_id, app_name: s.app_name, bundle_or_exe: s.bundle, title: s.title, origin: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: s.screen.width, height: s.screen.height } });
  const publicState = () => [...sessions.values()].map((s) => ({
    id: s.id, phase: s.phase, mode: s.mode, purpose: s.purpose, status: "",
    app: { app_id: s.app_id, app_name: s.app_name, bundle_or_exe: s.bundle, pid: null }, window: { id: "0", title: s.title }, windows: [],
    approval: "virtual", actions: s.actions, actions_left: Math.max(0, limits().actions_per_session - s.actions), seconds_left: Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 1000)),
    can_continue: false, log: s.log.slice(-30), frame: s.lastFrame ?? null, chat: s.chat ?? null, hidden: s.hidden === true,
    window_bounds: { x: 0, y: 0, width: s.screen.width, height: s.screen.height }, display: "virtual", virtual: { kind: s.kind, display: s.display, browser: s.browser?.name ?? null }, cursor: s.cursor ?? null,
  }));
  const update = () => { try { onState(publicState()); } catch { /* UI is best effort */ } };

  const ticker = setInterval(() => { for (const s of [...sessions.values()]) if (Date.now() >= s.expiresAt) void stop(s, "expired", "limit"); }, 1000);
  ticker.unref?.();

  async function stop(s, event, by, extra) {
    if (!sessions.has(s.id) || s.phase === "ended") return;
    s.phase = "ended";
    sessions.delete(s.id);
    await s.worker.call("release").catch(() => undefined);
    emit(s, event, by, extra);
    await s.close().catch(() => undefined);
    update();
  }

  const capture = async (s) => {
    const frame = rawFrame(await s.worker.call("capture", {}, 15_000));
    if (!frame) throw Object.assign(new Error("The screenshot could not be read."), { code: "capture_failed" });
    return frame;
  };
  const gridOf = (raw) => luminanceGrid(fitLongSide(raw, limits().model_long_side));

  /** Waits until the display stops changing (two still frames in a row), at most `maxMs`. */
  async function settle(s, maxMs) {
    if (maxMs <= 0) return;
    let grid = gridOf(await capture(s));
    const until = Date.now() + maxMs;
    let still = 0;
    while (Date.now() < until && still < 2) {
      await sleep(110);
      const next = gridOf(await capture(s));
      still = compareGrids(grid, next).changed === 0 ? still + 1 : 0;
      grid = next;
    }
  }

  /** Waits (at most `maxMs`) until the display shows more than one flat colour: a window is up. */
  async function waitForWindow(s, maxMs) {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      const { values } = gridOf(await capture(s));
      let lo = Infinity, hi = -Infinity;
      for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi - lo > 8) return true;
      await sleep(200);
    }
    return false;
  }

  /** A frame for the model: the agent's cursor drawn in, then the model copy (and the archive copies). */
  async function frame(s) {
    const l = limits();
    const raw = await capture(s);
    const grid = gridOf(raw);
    const cursor = await s.worker.call("pointer").catch(() => null);
    if (cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) drawCursor(raw, cursor.x, cursor.y, { scale: Math.max(1, Math.round(raw.width / 1600)) });
    const model = fitLongSide(raw, l.model_long_side);
    const bytes = encodeJpeg(model, { quality: 80 });
    const sha = sha256(bytes);
    const larger = Math.max(raw.width, raw.height) > Math.max(model.width, model.height);
    const fullPng = larger ? encodePng(fitLongSide(raw, l.full_long_side), { level: 3 }) : null;
    try { spool?.put({ bytes, mime: "image/jpeg", width: model.width, height: model.height, ...(fullPng ? { full: { bytes: fullPng, width: raw.width, height: raw.height } } : {}), thumb: encodeJpeg(fitLongSide(model, 320), { quality: 70 }), ocr: "none", masked: 0 }); } catch { /* best effort */ }
    const id = randomUUID();
    const ratio = model.width / raw.width;
    s.cursor = cursor ? { x: Math.round(cursor.x * ratio), y: Math.round(cursor.y * ratio) } : null;
    s.lastFrame = { sha, width: model.width, height: model.height, mime: "image/jpeg", data_url: `data:image/jpeg;base64,${bytes.toString("base64")}`, at: new Date().toISOString(), cursor: s.cursor };
    try { onFrame({ session_id: s.id, ...s.lastFrame }); } catch { /* live view is best effort */ }
    return { id, at: Date.now(), bytes, sha, grid, cursor, model: { width: model.width, height: model.height }, ref: { id, width: model.width, height: model.height, sha256: sha, mime: "image/jpeg", ...(fullPng ? { full: { width: raw.width, height: raw.height, sha256: sha256(fullPng) } } : {}), ocr: "none", masked: 0 } };
  }

  function countShot(s) {
    const key = s.chat ?? "";
    const n = (shots.get(key) ?? 0) + 1;
    shots.set(key, n);
    return n <= limits().screenshots_per_chat;
  }

  async function open(args) {
    const config = settings() ?? {};
    if (config.enabled === false) return failure("disabled", config.message || "Computer use is turned off.");
    if (config.virtual_display === false) return failure("virtual_unavailable", "The agent's own display is turned off for this account.");
    if ([...sessions.values()].some((s) => s.phase !== "ended")) return failure("session_busy", "Your display is already open: use its session_id, or close it first.");
    const name = args.app_id.slice("virtual:".length) || "main";
    if (!/^[a-z0-9_-]{1,32}$/i.test(name)) return failure("invalid_request", "A display name is 1-32 letters, digits, - or _.");
    const ctx = (await context()) ?? {};
    let backend;
    try { backend = await startBackend(name, { url: args.url ?? null, browser: args.browser !== false }); } catch (error) { return failure(error.code ?? "virtual_unavailable", error.message); }
    if (!backend?.ok) return backend ?? failure("virtual_unavailable", "The agent's display did not start.");
    const l = limits();
    const label = backend.kind === "xvfb" ? `agent display ${backend.display}` : "agent browser";
    const s = {
      id: randomUUID(), app_id: args.app_id, app_name: label, bundle: backend.kind === "xvfb" ? "Xvfb" : "agent-browser", kind: backend.kind, display: backend.display, browser: backend.browser ?? null,
      title: backend.browser ? `${backend.browser.name} (fresh profile) on ${label}` : label, mode: args.mode, purpose: args.purpose, phase: "working", chat: ctx.chat ?? null,
      worker: backend.worker, close: backend.close, screen: { id: String(backend.display), width: backend.width, height: backend.height, scale: 1 },
      virtualInfo: { width: backend.width, height: backend.height, wm: backend.wm ?? null, packages: Object.entries(backend.packages ?? {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`), ...(backend.browser ? { browser: `${backend.browser.name}${backend.browser.version ? ` ${backend.browser.version}` : ""}`, ...(backend.browser.sandbox === false ? { browser_sandbox: false } : {}) } : {}), ...(backend.kind !== "xvfb" ? { kind: backend.kind } : {}) },
      actions: 0, requests: new Set(), observation: null, log: [], expiresAt: Date.now() + l.session_seconds * 1000, lastAct: 0, cursor: null,
    };
    sessions.set(s.id, s);
    emit(s, "opened", "agent");
    emit(s, "approved", "agent");
    // The fresh browser comes up: the first observation shows it, not an empty screen.
    if (backend.browser) { await waitForWindow(s, 15_000).catch(() => null); await settle(s, 4000).catch(() => null); }
    update();
    return {
      ok: true, session_id: s.id, state: "active", mode: s.mode, approval: "virtual", display: s.display, screen: s.screen, os: osLabel,
      expires_in_seconds: l.session_seconds, actions_left: l.actions_per_session,
      ...(backend.browser ? { browser: { name: backend.browser.name, profile: "fresh" } } : {}),
      note: backend.kind === "xvfb"
        ? `This display (DISPLAY=${s.display}) is yours alone: its own cursor${backend.browser ? ` and a ${backend.browser.name} window on a fresh profile` : ""}. Nothing here needs approval. Use ctrl+t / ctrl+tab / ctrl+w for tabs and ctrl+l for the address bar; start other apps yourself with DISPLAY=${s.display} <app> &, then observe.`
        : "This browser is yours alone: its own cursor and a fresh profile. Nothing here needs approval. Use ctrl+t / ctrl+tab / ctrl+w for tabs and ctrl+l for the address bar, then observe.",
    };
  }

  async function call(name, args) {
    const s = sessions.get(args.session_id);
    const l = limits();
    if (!s) return mcpResult(failure("session_unavailable", "This session has ended. Open a new one."));
    if (name === "computer_close_session") { await stop(s, "closed", "agent"); return mcpResult({ ok: true, session_id: s.id, state: "closed" }); }
    if (name === "computer_session_status") return mcpResult({ ok: true, session_id: s.id, state: s.phase === "working" ? "active" : s.phase, mode: s.mode, approval: "virtual", actions_left: Math.max(0, l.actions_per_session - s.actions), seconds_left: Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 1000)), window: windowOf(s), os: osLabel });
    if (s.phase !== "working") return mcpResult(failure("session_unavailable", "This session has ended. Open a new one."));
    if (Date.now() >= s.expiresAt) { await stop(s, "expired", "limit"); return mcpResult(failure("session_unavailable", "This session reached its time limit.")); }
    if (name === "computer_observe") {
      if (!countShot(s)) return mcpResult(failure("screenshot_limit", "This chat reached its screenshot limit."));
      const obs = await frame(s);
      s.observation = obs;
      update();
      return mcpResult(observeResult({ session_id: s.id, observation: obs.ref, window: windowOf(s), screen: s.screen, scale: s.screen.width / obs.model.width, monitor_id: s.screen.id, cursor: obs.cursor, os: osLabel, expires_in_ms: l.observation_ttl_seconds * 1000, actions_left: Math.max(0, l.actions_per_session - s.actions), seconds_left: Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 1000)) }), args.include_image ? { data: obs.bytes, mime: "image/jpeg" } : null);
    }
    // computer_act: no question in any mode; the action runs as soon as the checks pass.
    const started = Date.now();
    const base = { session_id: s.id, request_id: args.request_id, intent: args.intent, started_at: new Date(started).toISOString(), os: osLabel, approval: { asked: false, by: "virtual" } };
    const finish = (fields, image) => {
      const ended = Date.now();
      const result = actResult({ ...base, ...fields, ended_at: new Date(ended).toISOString(), duration_ms: ended - started });
      s.log.push({ at: base.started_at, action: describeAction(fields.action ?? args.action), intent: args.intent, ok: result.ok, code: result.code ?? null });
      if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
      update();
      return mcpResult(result, image);
    };
    if (s.mode !== "control") return finish({ ok: false, code: "scope_denied", message: "This session is read-only (mode observe)." });
    if (s.requests.has(args.request_id)) return finish({ ok: false, code: "duplicate_request", message: "Use a new request_id. Observe instead of repeating input." });
    s.requests.add(args.request_id);
    if (s.actions >= l.actions_per_session) { await stop(s, "stopped", "limit", { reason: "action_limit" }); return finish({ ok: false, code: "action_limit", message: `Start a new session after ${l.actions_per_session} actions.` }); }
    const observed = s.observation; s.observation = null;
    if (!observed || observed.id !== args.observation_id || Date.now() - observed.at > l.observation_ttl_seconds * 1000) return finish({ ok: false, code: "stale_observation", message: "Observe again before acting.", next: "computer_observe" });
    const valid = validateAction(args.action, observed.model);
    if (!valid.ok) return finish({ ok: false, code: valid.code, message: valid.message, frame_before: { sha256: observed.sha } });
    const action = valid.action;
    const gap = 1000 / l.actions_per_second - (Date.now() - s.lastAct);
    if (gap > 0) await sleep(gap);
    const bounds = windowOf(s).bounds;
    const common = { action, frame_before: { sha256: observed.sha }, window: windowOf(s), screen: s.screen, monitor_id: s.screen.id, scale: bounds.width / observed.model.width };
    if (action.type !== "wait") {
      // Tolerant: a caret, a spinner or the cursor do not count; a new page or dialog does.
      const mask = observed.cursor ? [{ x: (observed.cursor.x * observed.model.width) / s.screen.width - 2, y: (observed.cursor.y * observed.model.height) / s.screen.height - 2, width: 60, height: 40 }] : [];
      if (compareGrids(observed.grid, gridOf(await capture(s)), { mask }).stale) return finish({ ...common, ok: false, code: "stale_observation", message: "The screen changed since the observation. Observe again.", next: "computer_observe" });
    }
    const mapped = action.type === "drag" ? action.path.map((p) => mapPoint(p, observed.model, bounds)) : action.x !== undefined ? [mapPoint(action, observed.model, bounds)] : [];
    const point = mapped.length === 1 ? { model: mapped[0].model, screen: mapped[0].screen } : undefined;
    const pathOut = action.type === "drag" ? mapped.map((m) => ({ model: m.model, screen: m.screen })) : undefined;
    const screenAction = action.type === "drag" ? { ...action, path: mapped.map((m) => m.screen) } : mapped.length ? { ...action, x: mapped[0].screen.x, y: mapped[0].screen.y } : action;
    const cursorBefore = await s.worker.call("pointer").catch(() => null);
    if (mapped.length) {
      const toModel = (p) => ({ x: Math.round((p.x * observed.model.width) / s.screen.width), y: Math.round((p.y * observed.model.height) / s.screen.height) });
      try { onCursor({ session_id: s.id, from: cursorBefore ? toModel(cursorBefore) : null, to: mapped.at(-1).model, path: mapped.map((m) => m.model), action: action.type, width: observed.model.width, height: observed.model.height }); } catch { /* live view */ }
    }
    s.actions += 1; s.lastAct = Date.now();
    try {
      if (action.type === "wait") await sleep(action.ms);
      else await s.worker.call("act", { action: screenAction }, 30_000);
    } catch (error) {
      return finish({ ...common, point, path: pathOut, cursor_before: cursorBefore, ok: false, code: error.code ?? "input_failed", message: error.message, may_have_acted: action.type !== "wait", next: "computer_observe" });
    }
    const cursorAfter = await s.worker.call("pointer").catch(() => null);
    const done = { ...common, point, path: pathOut, cursor_before: cursorBefore, cursor_after: cursorAfter, ok: true, may_have_acted: action.type !== "wait" };
    // Page loads, menus and typing echo: the next frame shows the result, not a half-drawn screen.
    const settleMs = SETTLE_MS[action.type] ?? 1000;
    if (settleMs > 0) { await sleep(120); await settle(s, settleMs).catch(() => null); }
    if (!args.observe_after) return finish({ ...done, next: "computer_observe" });
    if (s.phase !== "working" || !countShot(s)) return finish({ ...done, next: "computer_observe" });
    const after = await frame(s);
    s.observation = after;
    return finish({ ...done, frame_after: { sha256: after.sha }, observation: after.ref, next: "computer_act" }, { data: after.bytes, mime: "image/jpeg" });
  }

  return {
    owns: (id) => typeof id === "string" && sessions.has(id),
    open,
    call,
    state: publicState,
    /** Stop / Hide / Show from the person (Continue and Take over do not apply: the person's screen is not involved). */
    async control({ session_id, action }) {
      const s = sessions.get(session_id);
      if (!s) throw new Error("This computer use session has ended.");
      if (action === "stop") return stop(s, "stopped", "person");
      if (action === "hide" || action === "show") { s.hidden = action === "hide"; update(); return undefined; }
      throw new Error("This action is unavailable on the agent's own display.");
    },
    async stopAll(by = "server", event = "stopped") { for (const s of [...sessions.values()]) await stop(s, event, by); },
    async close() { clearInterval(ticker); for (const s of [...sessions.values()]) await stop(s, "closed", "limit"); },
    hint: "app_id \"virtual:main\" opens your own display: its own cursor and a fresh browser profile, separate from the person's screen. Nothing there needs approval.",
  };
}
