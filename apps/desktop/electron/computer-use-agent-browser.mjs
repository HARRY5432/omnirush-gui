// Computer use, the agent's own browser (macOS, Windows, and Linux without
// Xvfb): a backend of the shared virtual host (virtual-host.mjs) with the
// worker interface call("capture" | "pointer" | "act" | "release").
//
// Each tab is an offscreen-rendered BrowserWindow that is never shown, on a
// session partition of its own (a fresh in-memory profile per session,
// cleared on close). Input goes to the tab over the DevTools protocol
// (webContents.debugger), never as OS input, so the person's mouse and
// keyboard are never touched. The "screen" is a 1280x800 image: a browser
// chrome strip (tabs, address bar; a small offscreen page) over the active
// tab, so a point in the model image is the same pixel here.
//
// Why a browser of its own: Codex drives macOS apps in the background with its
// own cursor (private window-server event routing, the person's pointer never
// moves) and takes over the foreground desktop on Windows. We keep the
// person's cursor and desktop untouched on both, so the agent gets this
// isolated browser there instead.
//
// Electron is passed in (`electron`), so the routing and drawing logic runs
// in plain node tests too.

import { randomUUID } from "node:crypto";

export const SCREEN = Object.freeze({ width: 1280, height: 800 });
export const TAB_H = 34;
export const CHROME_H = 72;
export const PAGE_H = SCREEN.height - CHROME_H;
const TABS_X = 8;
const NEW_TAB_W = 32;
const BUTTONS = Object.freeze({ back: [8, 38], forward: [40, 70], reload: [72, 102] });
const ADDRESS = Object.freeze({ x: 110, right: SCREEN.width - 10 });
const BLANK = "about:blank";
const SEARCH = "https://duckduckgo.com/?q=";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** `promise`, or a rejection after `ms` (setup steps never hang the session). */
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);
const fail = (code, message) => Object.assign(new Error(message), { code });

// ------------------------------------------------------------ pure logic

/** Each tab's box in the tab strip, its close box (when wide enough), and the "+" box. */
export function tabLayout(count) {
  const width = Math.max(28, Math.min(220, Math.floor((SCREEN.width - TABS_X - NEW_TAB_W - 12) / Math.max(1, count))));
  const tabs = Array.from({ length: count }, (_, i) => {
    const x = TABS_X + i * width;
    return { x, width: width - 2, close: width >= 60 ? { x: x + width - 26, width: 18 } : null };
  });
  return { tabs, plus: { x: TABS_X + count * width + 4, width: NEW_TAB_W - 4 } };
}

/** What a point hits: the chrome (a tab, its close box, "+", back, forward, reload, the address bar) or the page (y without the chrome). */
export function hitTest(x, y, count) {
  if (y >= CHROME_H) return { area: "page", x, y: y - CHROME_H };
  if (y < TAB_H) {
    const { tabs, plus } = tabLayout(count);
    const inside = (box) => x >= box.x && x < box.x + box.width;
    const index = tabs.findIndex(inside);
    if (index >= 0) return tabs[index].close && inside(tabs[index].close) ? { area: "chrome", target: "close", index } : { area: "chrome", target: "tab", index };
    if (inside(plus)) return { area: "chrome", target: "new" };
    return { area: "chrome", target: "none" };
  }
  for (const [target, [from, to]] of Object.entries(BUTTONS)) if (x >= from && x <= to) return { area: "chrome", target };
  if (x >= ADDRESS.x && x <= ADDRESS.right) return { area: "chrome", target: "address" };
  return { area: "chrome", target: "none" };
}

/** Pages the agent's browser may show: http(s) and about:blank (no files, no internal pages). */
export function allowedUrl(value) {
  if (value === BLANK) return true;
  try { const u = new URL(value); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

/** What typing in the address bar opens: an address as is (https:// added), else a search. */
export function addressToUrl(text) {
  const value = String(text).trim();
  if (!value) return null;
  if (value === BLANK || /^https?:\/\//i.test(value)) return allowedUrl(value) ? value : null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  if (!/\s/.test(value) && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value)) return `http://${value}`;
  if (!/\s/.test(value) && /^[^/]+\.[a-z0-9-]{2,}(:\d+)?(\/.*)?$/i.test(value)) return `https://${value}`;
  return `${SEARCH}${encodeURIComponent(value)}`;
}

const NAMED_KEYS = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, Tab: { key: "Tab", code: "Tab", vk: 9 }, Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 }, Delete: { key: "Delete", code: "Delete", vk: 46 }, Insert: { key: "Insert", code: "Insert", vk: 45 },
  Space: { key: " ", code: "Space", vk: 32, text: " " }, Left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, Up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  Right: { key: "ArrowRight", code: "ArrowRight", vk: 39 }, Down: { key: "ArrowDown", code: "ArrowDown", vk: 40 }, Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 }, PageUp: { key: "PageUp", code: "PageUp", vk: 33 }, PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
};
const PUNCTUATION = { ";": 186, "=": 187, ",": 188, "-": 189, ".": 190, "/": 191, "`": 192, "[": 219, "\\": 220, "]": 221, "'": 222 };
// Copy, cut and paste are not here: they use the browser's own clipboard (clipboardOf), never the OS one.
const EDITING = { a: "selectAll", z: "undo", y: "redo" };
const MOD_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/** The DevTools key events of one key (contract names: Enter, Tab, F1..F24, single characters) with modifiers. */
export function keyEvents(name, modifiers = []) {
  const mods = new Set(modifiers);
  const bits = modifiers.reduce((sum, m) => sum | (MOD_BITS[m] ?? 0), 0);
  let info = NAMED_KEYS[name];
  const fn = /^F([1-9]|1\d|2[0-4])$/.exec(name);
  if (!info && fn) info = { key: name, code: name, vk: 111 + Number(fn[1]) };
  if (!info && [...name].length === 1) {
    const lower = name.toLowerCase();
    const letter = /^[a-z]$/.test(lower), digit = /^[0-9]$/.test(name);
    const key = letter && mods.has("shift") ? lower.toUpperCase() : name;
    info = { key, code: letter ? `Key${lower.toUpperCase()}` : digit ? `Digit${name}` : "", vk: letter ? lower.toUpperCase().charCodeAt(0) : digit ? name.charCodeAt(0) : PUNCTUATION[name] ?? 0, text: key };
  }
  if (!info) throw fail("invalid_request", `Unknown key ${name}.`);
  const command = (mods.has("ctrl") || mods.has("meta")) && !mods.has("alt") ? EDITING[name.toLowerCase()] : undefined;
  const commands = command ? [command === "undo" && mods.has("shift") ? "redo" : command] : undefined;
  const text = info.text && !mods.has("ctrl") && !mods.has("meta") && !mods.has("alt") ? info.text : undefined;
  const base = { key: info.key, code: info.code, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk, modifiers: bits };
  return [
    { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}), ...(commands ? { commands } : {}) },
    { type: "keyUp", ...base },
  ];
}

/** Browser chords the agent's browser handles itself (as a browser would), or null for the page. */
export function chordOf(name, modifiers = []) {
  const m = new Set(modifiers);
  const primary = (m.has("ctrl") || m.has("meta")) && !m.has("alt");
  const key = name.length === 1 ? name.toLowerCase() : name;
  if (primary && key === "t" && !m.has("shift")) return { chord: "new" };
  if (primary && key === "w") return { chord: "close" };
  if (primary && key === "l") return { chord: "address" };
  if (primary && key === "r") return { chord: "reload" };
  if (m.has("ctrl") && key === "Tab") return { chord: m.has("shift") ? "previous" : "next" };
  if (m.has("ctrl") && !m.has("shift") && key === "PageDown") return { chord: "next" };
  if (m.has("ctrl") && !m.has("shift") && key === "PageUp") return { chord: "previous" };
  if (primary && /^[1-9]$/.test(key)) return { chord: "select", index: Number(key) - 1 };
  if (m.has("alt") && !primary && key === "Left") return { chord: "back" };
  if (m.has("alt") && !primary && key === "Right") return { chord: "forward" };
  if (m.has("meta") && key === "[") return { chord: "back" };
  if (m.has("meta") && key === "]") return { chord: "forward" };
  if (key === "F5" && !m.size) return { chord: "reload" };
  if (key === "F6" && !m.size) return { chord: "address" };
  return null;
}

/** Copy, cut or paste (ctrl or cmd + c / x / v), or null. */
export function clipboardOf(name, modifiers = []) {
  const m = new Set(modifiers);
  if (!(m.has("ctrl") || m.has("meta")) || m.has("alt")) return null;
  return { c: "copy", x: "cut", v: "paste" }[String(name).toLowerCase()] ?? null;
}

/** The selected text in the page: inside a focused text field, else the document selection. */
export const SELECTION_JS = "(() => { const a = document.activeElement; if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && typeof a.selectionStart === 'number') return a.value.slice(a.selectionStart, a.selectionEnd); return String(getSelection() ?? ''); })()";

/** Glide timing: a short pause per step so the whole move takes about 150-250 ms. */
export function stepDelay(steps) {
  return steps <= 1 ? 0 : Math.max(5, Math.round(Math.min(250, Math.max(150, steps * 9)) / steps));
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);

/** The chrome strip's markup for a state { tabs: [{ title, url, loading }], active, address: { focused, text, selected } }. */
export function chromeHtml(state) {
  const { tabs, plus } = tabLayout(state.tabs.length);
  const active = state.tabs[state.active];
  const tabMarkup = state.tabs.map((tab, i) => {
    const box = tabs[i];
    const title = tab.title || (tab.url && tab.url !== BLANK ? tab.url : "New tab");
    return `<div class="tab${i === state.active ? " on" : ""}" style="left:${box.x}px;width:${box.width}px"><span class="t">${tab.loading ? "&#8635; " : ""}${escapeHtml(title)}</span>${box.close ? `<span class="x" style="left:${box.close.x - box.x}px">&#10005;</span>` : ""}</div>`;
  }).join("");
  const focused = state.address.focused;
  const shown = focused ? state.address.text : active?.url === BLANK ? "" : active?.url ?? "";
  const address = `<div class="bar${focused ? " focus" : ""}" style="left:${ADDRESS.x}px;width:${ADDRESS.right - ADDRESS.x}px"><span class="${focused && state.address.selected ? "sel" : ""}">${escapeHtml(shown) || (focused ? "" : "<i>Search or type a URL</i>")}</span>${focused && !state.address.selected ? "<b class=\"caret\"></b>" : ""}</div>`;
  const buttons = Object.entries(BUTTONS).map(([name, [from, to]]) => `<div class="btn" style="left:${from}px;width:${to - from}px">${{ back: "&#8592;", forward: "&#8594;", reload: "&#8635;" }[name]}</div>`).join("");
  return `${tabMarkup}<div class="plus" style="left:${plus.x}px;width:${plus.width}px">+</div><div class="tool">${buttons}${address}</div>`;
}

const CHROME_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${SCREEN.width}px;height:${CHROME_H}px;overflow:hidden;background:#dee1e6;font:13px system-ui,-apple-system,"Segoe UI",sans-serif;color:#202124}
.tab,.plus,.btn,.bar{position:absolute;box-sizing:border-box}
.tab{top:4px;height:${TAB_H - 4}px;border-radius:8px 8px 0 0;padding:7px 28px 0 12px;white-space:nowrap;overflow:hidden}
.tab.on{background:#fff}.t{display:block;overflow:hidden;text-overflow:ellipsis}
.x{position:absolute;top:7px;width:18px;text-align:center;font-size:11px;color:#5f6368}
.plus{top:6px;height:24px;font-size:20px;line-height:22px;text-align:center;color:#3c4043}
.tool{position:absolute;left:0;top:${TAB_H}px;width:100%;height:${CHROME_H - TAB_H}px;background:#fff;border-bottom:1px solid #dadce0}
.btn{top:5px;height:28px;line-height:28px;text-align:center;font-size:16px;color:#5f6368}
.bar{top:5px;height:28px;border-radius:14px;background:#f1f3f4;padding:5px 14px;white-space:nowrap;overflow:hidden}
.bar.focus{background:#fff;box-shadow:inset 0 0 0 2px #1a73e8}.bar i{color:#80868b;font-style:normal}
.sel{background:#c2dbff}.caret{display:inline-block;width:1px;height:16px;background:#202124;vertical-align:-3px}
</style></head><body></body></html>`;

/** BGRA (Electron bitmaps) into RGBA rows of `out`, from row `top`. */
function blit(out, bgra, width, rows, top) {
  for (let i = 0, o = top * width * 4; i < width * rows * 4; i += 4, o += 4) {
    out[o] = bgra[i + 2]; out[o + 1] = bgra[i + 1]; out[o + 2] = bgra[i]; out[o + 3] = 255;
  }
}

// ------------------------------------------------------------ the backend

/**
 * Starts the agent's browser. `electron`: { BrowserWindow, session }; `glidePath(x0, y0, x1, y1)`: the shared
 * worker's glide (virtual-worker.mjs). Returns the virtual host's backend.
 */
export async function startAgentBrowser({ electron, glidePath, url = null, versions = process.versions, wait = sleep }) {
  const { BrowserWindow, session: sessions } = electron;
  const partition = `cu-agent-${randomUUID()}`;
  const ses = sessions.fromPartition(partition, { cache: false });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event, item) => { item.cancel(); });
  try { ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|OmniRush[^/\s]*|omnirush[^/\s]*)\/\S+/g, "")); } catch { /* the default stays */ }

  const tabs = [];
  let active = 0;
  let closed = false;
  const address = { focused: false, text: "", selected: false };
  const pointer = { x: Math.round(SCREEN.width / 2), y: Math.round(SCREEN.height / 2) };
  let held = null; // the button held down in the page (drag), released by release()
  let clip = ""; // this browser's own clipboard

  const offscreen = (height) => new BrowserWindow({
    show: false, width: SCREEN.width, height, useContentSize: true, frame: false, skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: { useSharedTexture: false, deviceScaleFactor: 1 }, partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false, devTools: false },
  });
  const latest = (wc, view) => { wc.setFrameRate?.(30); wc.on("paint", (_event, _dirty, image) => { view.image = image; }); };
  const pixels = async (view, height) => {
    let image = view.image ?? null;
    if (!image || image.isEmpty?.()) image = await view.window.webContents.capturePage().catch(() => null);
    if (!image || image.isEmpty?.()) return null;
    const size = image.getSize();
    if (size.width !== SCREEN.width || size.height !== height) image = image.resize({ width: SCREEN.width, height, quality: "good" });
    return image.toBitmap();
  };

  // The chrome strip: a small offscreen page re-drawn on every change.
  const chrome = { window: offscreen(CHROME_H), image: null };
  latest(chrome.window.webContents, chrome);
  chrome.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  chrome.window.webContents.on("will-navigate", (event) => event.preventDefault());
  await chrome.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(CHROME_PAGE)}`);
  const view = () => ({ tabs: tabs.map((t) => ({ title: t.title, url: t.url, loading: t.loading })), active, address });
  let drawing = Promise.resolve();
  const draw = () => {
    if (closed) return drawing;
    const html = chromeHtml(view());
    drawing = drawing.then(() => chrome.window.webContents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(html)}; void 0`)).then(() => chrome.window.webContents.invalidate?.()).catch(() => undefined);
    return drawing;
  };

  const cdp = (tab, method, params = {}) => tab.window.webContents.debugger.sendCommand(method, params);

  async function openTab(target, { activate = true } = {}) {
    const window = offscreen(PAGE_H);
    const wc = window.webContents;
    const tab = { id: randomUUID(), window, image: null, title: "", url: target ?? BLANK, loading: false };
    latest(wc, tab);
    wc.setWindowOpenHandler(({ url: next }) => { if (allowedUrl(next)) void openTab(next); return { action: "deny" }; });
    const guard = (event, next) => { if (!allowedUrl(next)) event.preventDefault(); };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);
    wc.on("page-title-updated", (_event, title) => { tab.title = title; void draw(); });
    wc.on("did-navigate", (_event, next) => { tab.url = next; void draw(); });
    wc.on("did-navigate-in-page", (_event, next, mainFrame) => { if (mainFrame !== false) { tab.url = next; void draw(); } });
    wc.on("did-start-loading", () => { tab.loading = true; void draw(); });
    wc.on("did-stop-loading", () => { tab.loading = false; void draw(); });
    wc.on("render-process-gone", () => { tab.title = "This page crashed"; void draw(); });
    // A committed document first: DevTools commands on a window that never loaded anything do not answer.
    await withTimeout(window.loadURL(BLANK), 5000).catch(() => undefined);
    wc.debugger.attach("1.3");
    wc.debugger.on("message", (_event, method, params) => {
      // No native dialog or file picker ever reaches the person's screen.
      if (method === "Page.javascriptDialogOpening") void cdp(tab, "Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined);
    });
    await withTimeout(cdp(tab, "Page.enable"), 3000).catch(() => undefined);
    await withTimeout(cdp(tab, "Page.setInterceptFileChooserDialog", { enabled: true }), 3000).catch(() => undefined);
    await withTimeout(cdp(tab, "Page.addScriptToEvaluateOnNewDocument", { source: "window.alert=()=>{};window.confirm=()=>true;window.prompt=()=>null;" }), 3000).catch(() => undefined);
    await withTimeout(cdp(tab, "Emulation.setFocusEmulationEnabled", { enabled: true }), 3000).catch(() => undefined);
    tabs.push(tab);
    if (activate) { active = tabs.length - 1; address.focused = target === null; address.text = ""; address.selected = false; }
    await draw();
    await navigate(tab, target ?? BLANK);
    return tab;
  }

  /** Starts a load and returns once it started (the host's settle loop waits for the page). */
  async function navigate(tab, target) {
    const wc = tab.window.webContents;
    const started = new Promise((resolve) => { wc.once("did-start-loading", resolve); setTimeout(resolve, 1500); });
    tab.url = target;
    wc.loadURL(target).catch(() => undefined);
    await started;
  }

  async function closeTab(index) {
    const [tab] = tabs.splice(index, 1);
    if (!tab) return;
    try { tab.window.webContents.debugger.detach(); } catch { /* gone */ }
    tab.window.destroy();
    if (!tabs.length) { active = 0; await openTab(null); return; }
    if (index < active) active -= 1;
    active = Math.min(active, tabs.length - 1);
    await draw();
  }

  const current = () => tabs[active];
  const focusAddress = () => { address.focused = true; address.text = current()?.url === BLANK ? "" : current()?.url ?? ""; address.selected = true; return draw(); };
  const blurAddress = () => { if (!address.focused) return undefined; address.focused = false; address.selected = false; return draw(); };

  async function runChord(chord) {
    const tab = current();
    const wc = tab?.window.webContents;
    const history = wc?.navigationHistory;
    if (chord.chord === "new") return openTab(null);
    if (chord.chord === "close") return closeTab(active);
    if (chord.chord === "address") return focusAddress();
    if (chord.chord === "next" || chord.chord === "previous") { active = (active + (chord.chord === "next" ? 1 : tabs.length - 1)) % tabs.length; await blurAddress(); return draw(); }
    if (chord.chord === "select") { active = Math.min(chord.index, tabs.length - 1); await blurAddress(); return draw(); }
    const started = wc ? new Promise((resolve) => { wc.once("did-start-loading", resolve); setTimeout(resolve, 1500); }) : null;
    if (chord.chord === "back" && history?.canGoBack()) { history.goBack(); return started; }
    if (chord.chord === "forward" && history?.canGoForward()) { history.goForward(); return started; }
    if (chord.chord === "reload" && wc) { wc.reload(); return started; }
    return undefined;
  }

  async function clickChrome(hit) {
    if (hit.target === "tab") { active = hit.index; await blurAddress(); return draw(); }
    if (hit.target === "close") return closeTab(hit.index);
    if (hit.target === "new") return openTab(null);
    if (hit.target === "address") return focusAddress();
    await blurAddress();
    if (hit.target === "back" || hit.target === "forward" || hit.target === "reload") return runChord({ chord: hit.target });
    return undefined;
  }

  const mouse = (type, at, extra = {}) => {
    const tab = current();
    if (!tab) return Promise.resolve();
    return cdp(tab, "Input.dispatchMouseEvent", { type, x: at.x, y: at.y, modifiers: 0, pointerType: "mouse", ...extra });
  };

  /** Moves the agent's cursor to (x, y) like a person: several small moves, ease-out, about 200 ms. */
  async function glide(x, y, extra = {}) {
    const path = glidePath(pointer.x, pointer.y, x, y);
    const delay = stepDelay(path.length);
    for (const point of path) {
      pointer.x = point.x; pointer.y = point.y;
      const hit = hitTest(point.x, point.y, tabs.length);
      if (hit.area === "page") await mouse("mouseMoved", hit, extra).catch(() => undefined);
      if (delay) await wait(delay);
    }
  }

  async function press(x, y, button, clickCount) {
    const hit = hitTest(x, y, tabs.length);
    if (hit.area === "chrome") return clickChrome(hit);
    await blurAddress();
    current()?.window.webContents.focus?.();
    for (let n = 1; n <= clickCount; n += 1) {
      await mouse("mousePressed", hit, { button, buttons: button === "right" ? 2 : 1, clickCount: n });
      await mouse("mouseReleased", hit, { button, buttons: 0, clickCount: n });
    }
    return undefined;
  }

  async function typeAddress(text) {
    address.text = address.selected ? text : address.text + text;
    address.selected = false;
    return draw();
  }

  async function addressKey(name, modifiers) {
    if (name === "Enter") {
      const target = addressToUrl(address.text);
      if (!target) return draw();
      address.focused = false; address.selected = false;
      await draw();
      return navigate(current(), target);
    }
    if (name === "Escape") { address.focused = false; address.selected = false; return draw(); }
    if (name === "Backspace" || name === "Delete") { address.text = address.selected ? "" : address.text.slice(0, -1); address.selected = false; return draw(); }
    if ((modifiers.includes("ctrl") || modifiers.includes("meta")) && name.toLowerCase() === "a") { address.selected = true; return draw(); }
    if (!modifiers.some((m) => m !== "shift") && [...name].length === 1) return typeAddress(modifiers.includes("shift") ? name.toUpperCase() : name);
    if (name === "Space" && !modifiers.length) return typeAddress(" ");
    return undefined;
  }

  async function key(name, modifiers = []) {
    const chord = chordOf(name, modifiers);
    if (chord) return runChord(chord);
    // Copy, cut and paste use this browser's own clipboard: nothing goes to or comes from the person's clipboard.
    const edit = clipboardOf(name, modifiers);
    if (edit && address.focused) {
      if (edit === "paste") return typeAddress(clip);
      if (address.selected) { clip = address.text; if (edit === "cut") { address.text = ""; address.selected = false; await draw(); } }
      return undefined;
    }
    if (address.focused) return addressKey(name, modifiers);
    const tab = current();
    if (!tab) return undefined;
    if (edit === "paste") { if (clip) await cdp(tab, "Input.insertText", { text: clip }); return undefined; }
    if (edit) {
      const answer = await cdp(tab, "Runtime.evaluate", { expression: SELECTION_JS, returnByValue: true }).catch(() => null);
      const text = typeof answer?.result?.value === "string" ? answer.result.value : "";
      if (text) clip = text.slice(0, 1_000_000);
      if (edit === "cut" && text) await cdp(tab, "Input.insertText", { text: "" });
      return undefined;
    }
    for (const event of keyEvents(name, modifiers)) await cdp(tab, "Input.dispatchKeyEvent", event);
    return undefined;
  }

  async function type(text) {
    const lines = String(text).split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (i > 0) await key("Enter");
      if (!lines[i]) continue;
      if (address.focused) await typeAddress(lines[i]);
      else if (current()) await cdp(current(), "Input.insertText", { text: lines[i] });
    }
  }

  async function act(action) {
    if (closed) throw fail("session_unavailable", "The agent's browser has closed.");
    const t = action.type;
    if (t === "wait") return wait(action.ms ?? 0);
    if (t === "type") return type(action.text);
    if (t === "key") return key(action.key, action.modifiers ?? []);
    if (t === "move") return glide(action.x, action.y);
    if (t === "click" || t === "double_click" || t === "right_click") {
      await glide(action.x, action.y);
      return press(action.x, action.y, t === "right_click" ? "right" : "left", t === "double_click" ? 2 : 1);
    }
    if (t === "scroll") {
      await glide(action.x, action.y);
      const hit = hitTest(action.x, action.y, tabs.length);
      if (hit.area !== "page") return undefined;
      const px = action.delta * 100;
      return mouse("mouseWheel", hit, action.axis === "horizontal" ? { deltaX: px, deltaY: 0 } : { deltaX: 0, deltaY: px });
    }
    if (t === "drag") {
      const [first, ...rest] = action.path;
      await glide(first.x, first.y);
      const start = hitTest(first.x, first.y, tabs.length);
      if (start.area !== "page") return undefined;
      held = "left";
      await mouse("mousePressed", start, { button: "left", buttons: 1, clickCount: 1 });
      for (const point of rest) await glide(point.x, Math.max(CHROME_H, point.y), { button: "left", buttons: 1 });
      const end = hitTest(pointer.x, Math.max(CHROME_H, pointer.y), tabs.length);
      await mouse("mouseReleased", end, { button: "left", buttons: 0, clickCount: 1 });
      held = null;
      return undefined;
    }
    throw fail("invalid_request", `Unknown action ${t}.`);
  }

  async function capture() {
    if (closed) throw fail("session_unavailable", "The agent's browser has closed.");
    const out = new Uint8Array(SCREEN.width * SCREEN.height * 4).fill(255);
    await drawing;
    const top = await pixels(chrome, CHROME_H);
    if (top) blit(out, top, SCREEN.width, CHROME_H, 0);
    const tab = current();
    const page = tab ? await pixels(tab, PAGE_H) : null;
    if (page) blit(out, page, SCREEN.width, PAGE_H, CHROME_H);
    return { width: SCREEN.width, height: SCREEN.height, data: out };
  }

  async function release() {
    if (!held) return {};
    const hit = hitTest(pointer.x, Math.max(CHROME_H, pointer.y), tabs.length);
    held = null;
    await mouse("mouseReleased", hit, { button: "left", buttons: 0, clickCount: 1 }).catch(() => undefined);
    return {};
  }

  async function close() {
    if (closed) return;
    await release().catch(() => undefined);
    closed = true;
    for (const tab of tabs.splice(0)) { try { tab.window.webContents.debugger.detach(); } catch { /* gone */ } tab.window.destroy(); }
    chrome.window.destroy();
    await ses.clearStorageData().catch(() => undefined);
    await ses.clearCache().catch(() => undefined);
  }

  const worker = {
    async call(method, params = {}) {
      if (method === "capture") return capture();
      if (method === "pointer") return { x: pointer.x, y: pointer.y };
      if (method === "act") { await act(params.action); return {}; }
      if (method === "release") return release();
      throw fail("invalid_request", `Unknown method ${method}.`);
    },
    close,
  };

  try {
    await openTab(url && allowedUrl(url) ? url : BLANK);
    address.focused = !url; address.selected = false;
    await draw();
  } catch (error) {
    await close().catch(() => undefined);
    return { ok: false, code: "virtual_unavailable", message: `The agent's browser did not start: ${error.message}` };
  }
  const chromium = versions.chrome ?? null;
  return {
    ok: true, kind: "agent-browser", display: "agent-browser", width: SCREEN.width, height: SCREEN.height, wm: null,
    packages: { electron: versions.electron ?? null, chromium },
    browser: { name: "Chromium", kind: "chromium", version: chromium, profile: "fresh" },
    worker, close,
    /** For tests and the live view: the tabs and the address bar now. */
    state: () => ({ ...view(), pointer: { ...pointer } }),
  };
}
