import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { CHROME_H, SCREEN, addressToUrl, allowedUrl, chordOf, chromeHtml, hitTest, keyEvents, startAgentBrowser, stepDelay, tabLayout } from "./computer-use-agent-browser.mjs";
import { glidePath } from "../../server/src/computer-use/shared/virtual-worker.mjs";

// A stand-in for Electron's BrowserWindow / session: each window paints one solid BGRA colour.
function fakeElectron() {
  const windows = [];
  const partitions = [];
  let colour = 0;
  class Contents extends EventEmitter {
    constructor(height) {
      super();
      this.height = height;
      this.url = "";
      this.commands = [];
      this.scripts = [];
      this.back = [];
      this.forward = [];
      this.debugger = Object.assign(new EventEmitter(), { attach: () => { this.attached = true; }, detach: () => { this.attached = false; }, sendCommand: async (method, params) => { this.commands.push([method, params]); return {}; } });
      this.navigationHistory = { canGoBack: () => this.back.length > 0, goBack: () => { this.forward.push(this.url); this.go(this.back.pop()); }, canGoForward: () => this.forward.length > 0, goForward: () => { this.back.push(this.url); this.go(this.forward.pop()); } };
      const shade = (colour += 1) * 20;
      this.image = { isEmpty: () => false, getSize: () => ({ width: SCREEN.width, height }), toBitmap: () => { const b = Buffer.alloc(SCREEN.width * height * 4); for (let i = 0; i < b.length; i += 4) { b[i] = shade; b[i + 1] = 1; b[i + 2] = 2; b[i + 3] = 255; } return b; }, resize: () => this.image };
      this.shade = shade;
    }
    go(url) { this.url = url; this.emit("did-start-loading"); this.emit("did-navigate", {}, url); this.emit("did-stop-loading"); this.emit("paint", {}, {}, this.image); }
    setFrameRate() {}
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    loadURL(url) { if (this.url && !url.startsWith("data:")) this.back.push(this.url); this.go(url); return Promise.resolve(); }
    executeJavaScript(code) { this.scripts.push(code); return Promise.resolve(); }
    invalidate() {}
    capturePage() { return Promise.resolve(this.image); }
    focus() {}
    reload() { this.go(this.url); }
  }
  class BrowserWindow {
    constructor(options) { this.options = options; this.webContents = new Contents(options.height); this.destroyed = false; windows.push(this); }
    loadURL(url) { return this.webContents.loadURL(url); }
    destroy() { this.destroyed = true; }
  }
  const ses = { cleared: 0, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, getUserAgent: () => "Mozilla/5.0 Chrome/150.0 Electron/43.2.0 OmniRush.ai/3.7.0 Safari/537.36", setUserAgent(value) { this.agent = value; }, clearStorageData: async () => { ses.cleared += 1; }, clearCache: async () => {} };
  const session = { fromPartition: (name, options) => { partitions.push({ name, options }); return ses; } };
  return { electron: { BrowserWindow, session }, windows, partitions, ses };
}

async function start(options = {}) {
  const fake = fakeElectron();
  const delays = [];
  const backend = await startAgentBrowser({ electron: fake.electron, glidePath, url: options.url ?? null, versions: { electron: "43.2.0", chrome: "150.0" }, wait: async (ms) => { delays.push(ms); } });
  const pages = () => fake.windows.filter((w) => w.options.height !== CHROME_H && !w.destroyed);
  const active = () => pages()[backend.state().active];
  return { fake, backend, delays, pages, active, act: (action) => backend.worker.call("act", { action }) };
}

test("agent browser: points route to the chrome (tabs, +, close, address, buttons) or the page with the chrome's height taken off", () => {
  const { tabs, plus } = tabLayout(2);
  assert.deepEqual(hitTest(tabs[0].x + 5, 10, 2), { area: "chrome", target: "tab", index: 0 });
  assert.deepEqual(hitTest(tabs[1].close.x + 5, 10, 2), { area: "chrome", target: "close", index: 1 });
  assert.deepEqual(hitTest(plus.x + 5, 10, 2), { area: "chrome", target: "new" });
  assert.deepEqual(hitTest(20, 50, 2), { area: "chrome", target: "back" });
  assert.deepEqual(hitTest(85, 50, 2), { area: "chrome", target: "reload" });
  assert.deepEqual(hitTest(600, 50, 2), { area: "chrome", target: "address" });
  assert.deepEqual(hitTest(400, CHROME_H, 2), { area: "page", x: 400, y: 0 });
  assert.deepEqual(hitTest(1279, 799, 2), { area: "page", x: 1279, y: 799 - CHROME_H });
  assert.equal(SCREEN.width, 1280);
  assert.equal(SCREEN.height, 800);
});

test("agent browser: only http(s) and about:blank; the address bar adds https:// or searches", () => {
  for (const url of ["https://a.test/x", "http://127.0.0.1:8080/", "about:blank"]) assert.equal(allowedUrl(url), true, url);
  for (const url of ["file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "devtools://x", "data:text/html,x"]) assert.equal(allowedUrl(url), false, url);
  assert.equal(addressToUrl("example.com/docs"), "https://example.com/docs");
  assert.equal(addressToUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(addressToUrl("https://x.test"), "https://x.test");
  assert.equal(addressToUrl("file:///etc/passwd"), null);
  assert.equal(addressToUrl("how to bake bread"), "https://duckduckgo.com/?q=how%20to%20bake%20bread");
});

test("agent browser: key events and browser chords", () => {
  assert.deepEqual(keyEvents("Enter").map((e) => [e.type, e.key, e.windowsVirtualKeyCode, e.text ?? null]), [["keyDown", "Enter", 13, "\r"], ["keyUp", "Enter", 13, null]]);
  assert.deepEqual(keyEvents("a", ["ctrl"])[0], { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] });
  assert.equal(keyEvents("a", ["shift"])[0].text, "A");
  assert.equal(keyEvents("F5")[0].windowsVirtualKeyCode, 116);
  assert.equal(keyEvents("Left", ["alt", "shift"])[0].modifiers, 9);
  assert.throws(() => keyEvents("Hyper"), /Unknown key/);
  assert.deepEqual(chordOf("t", ["ctrl"]), { chord: "new" });
  assert.deepEqual(chordOf("t", ["meta"]), { chord: "new" });
  assert.deepEqual(chordOf("w", ["meta"]), { chord: "close" });
  assert.deepEqual(chordOf("Tab", ["ctrl"]), { chord: "next" });
  assert.deepEqual(chordOf("Tab", ["ctrl", "shift"]), { chord: "previous" });
  assert.deepEqual(chordOf("l", ["ctrl"]), { chord: "address" });
  assert.deepEqual(chordOf("Left", ["alt"]), { chord: "back" });
  assert.deepEqual(chordOf("Right", ["alt"]), { chord: "forward" });
  assert.deepEqual(chordOf("F5"), { chord: "reload" });
  assert.deepEqual(chordOf("r", ["ctrl"]), { chord: "reload" });
  assert.deepEqual(chordOf("3", ["ctrl"]), { chord: "select", index: 2 });
  assert.equal(chordOf("a", ["ctrl"]), null);
  assert.equal(chordOf("Tab"), null);
  // Glide: about 150-250 ms whatever the distance.
  for (const [x0, y0, x1, y1] of [[0, 0, 40, 30], [640, 400, 100, 700], [0, 0, 1279, 799]]) {
    const steps = glidePath(x0, y0, x1, y1).length;
    const total = steps * stepDelay(steps);
    assert.ok(total >= 140 && total <= 260, `${steps} steps: ${total} ms`);
  }
  assert.match(chromeHtml({ tabs: [{ title: "<b>x</b>", url: "https://a.test/", loading: false }], active: 0, address: { focused: false, text: "", selected: false } }), /&lt;b&gt;x&lt;\/b&gt;.*https:\/\/a\.test\//s);
});

test("agent browser: a fresh, in-memory profile per session, offscreen windows never shown, the screen is chrome over the page", async () => {
  const one = await start({ url: "https://a.test/" });
  const two = await start();
  assert.match(one.fake.partitions[0].name, /^cu-agent-[0-9a-f-]{36}$/);
  assert.notEqual(one.fake.partitions[0].name, two.fake.partitions[0].name);
  assert.ok(one.fake.windows.every((w) => w.options.show === false && w.options.webPreferences.offscreen && w.options.webPreferences.partition === one.fake.partitions[0].name && w.options.webPreferences.sandbox === true));
  assert.doesNotMatch(one.fake.ses.agent, /Electron|OmniRush/);
  assert.equal(one.active().webContents.url, "https://a.test/");
  assert.equal(one.backend.state().address.focused, false);
  assert.equal(two.backend.state().address.focused, true);
  assert.deepEqual({ ok: one.backend.ok, kind: one.backend.kind, width: one.backend.width, height: one.backend.height, browser: one.backend.browser }, { ok: true, kind: "agent-browser", width: 1280, height: 800, browser: { name: "Chromium", kind: "chromium", version: "150.0", profile: "fresh" } });
  // Dialogs and file pickers never reach the person's screen.
  const setup = one.active().webContents.commands.map(([method]) => method);
  for (const method of ["Page.enable", "Page.setInterceptFileChooserDialog", "Page.addScriptToEvaluateOnNewDocument"]) assert.ok(setup.includes(method), method);
  const frame = await one.backend.worker.call("capture");
  assert.equal(frame.width, 1280); assert.equal(frame.height, 800); assert.equal(frame.data.length, 1280 * 800 * 4);
  const chromeShade = one.fake.windows[0].webContents.shade, pageShade = one.active().webContents.shade;
  // BGRA → RGBA: the blue byte moves to the third place.
  assert.deepEqual([...frame.data.slice(0, 4)], [2, 1, chromeShade, 255]);
  assert.deepEqual([...frame.data.slice((CHROME_H - 1) * 1280 * 4, (CHROME_H - 1) * 1280 * 4 + 4)], [2, 1, chromeShade, 255]);
  assert.deepEqual([...frame.data.slice(CHROME_H * 1280 * 4, CHROME_H * 1280 * 4 + 4)], [2, 1, pageShade, 255]);
  await one.backend.close();
  assert.ok(one.fake.windows.every((w) => w.destroyed));
  assert.equal(one.fake.ses.cleared, 1);
  await assert.rejects(one.backend.worker.call("capture"), /closed/);
  await two.backend.close();
});

test("agent browser: a page click glides the agent cursor first, then presses at the page point (no OS input)", async () => {
  const b = await start({ url: "https://a.test/" });
  const page = b.active().webContents;
  page.commands.length = 0;
  await b.act({ type: "click", x: 400, y: 300 });
  const mouse = page.commands.filter(([method]) => method === "Input.dispatchMouseEvent").map(([, p]) => p);
  const moves = mouse.filter((p) => p.type === "mouseMoved");
  assert.ok(moves.length >= 4, `${moves.length} moves`);
  assert.deepEqual([moves.at(-1).x, moves.at(-1).y], [400, 300 - CHROME_H]);
  assert.deepEqual(mouse.slice(-2).map((p) => [p.type, p.x, p.y, p.button, p.clickCount]), [["mousePressed", 400, 228, "left", 1], ["mouseReleased", 400, 228, "left", 1]]);
  assert.deepEqual(await b.backend.worker.call("pointer"), { x: 400, y: 300 });
  const total = b.delays.reduce((sum, ms) => sum + ms, 0);
  assert.ok(total >= 140 && total <= 260, `glide ${total} ms`);
  page.commands.length = 0;
  await b.act({ type: "double_click", x: 10, y: 100 });
  assert.deepEqual(page.commands.filter(([, p]) => p?.type === "mousePressed").map(([, p]) => p.clickCount), [1, 2]);
  page.commands.length = 0;
  await b.act({ type: "right_click", x: 10, y: 100 });
  assert.equal(page.commands.find(([, p]) => p?.type === "mousePressed")[1].button, "right");
  page.commands.length = 0;
  await b.act({ type: "scroll", x: 500, y: 500, delta: 3, axis: "vertical" });
  assert.deepEqual(page.commands.filter(([, p]) => p?.type === "mouseWheel").map(([, p]) => [p.x, p.y, p.deltaX, p.deltaY]), [[500, 500 - CHROME_H, 0, 300]]);
  page.commands.length = 0;
  await b.act({ type: "drag", path: [{ x: 100, y: 200 }, { x: 300, y: 260 }] });
  const drag = page.commands.filter(([method]) => method === "Input.dispatchMouseEvent").map(([, p]) => p);
  const pressedAt = drag.findIndex((p) => p.type === "mousePressed");
  assert.deepEqual([drag[pressedAt].x, drag[pressedAt].y], [100, 200 - CHROME_H]);
  assert.ok(drag.slice(pressedAt + 1, -1).every((p) => p.type === "mouseMoved" && p.buttons === 1));
  assert.deepEqual([drag.at(-1).type, drag.at(-1).x, drag.at(-1).y], ["mouseReleased", 300, 260 - CHROME_H]);
  await b.backend.close();
});

test("agent browser: typing inserts text (IME-safe), newlines press Enter, keys go to the page", async () => {
  const b = await start({ url: "https://a.test/" });
  const page = b.active().webContents;
  page.commands.length = 0;
  await b.act({ type: "type", text: "hé世👋" });
  // One key event per character, the character as its text (surrogate pairs kept whole).
  assert.deepEqual(page.commands.filter(([, p]) => p.type === "keyDown").map(([, p]) => p.text), ["h", "é", "世", "👋"]);
  assert.equal(page.commands.filter(([, p]) => p.type === "keyUp").length, 4);
  page.commands.length = 0;
  await b.act({ type: "type", text: "a\nb" });
  assert.deepEqual(page.commands.map(([, p]) => `${p.type}:${p.key}`), ["keyDown:a", "keyUp:a", "keyDown:Enter", "keyUp:Enter", "keyDown:b", "keyUp:b"]);
  // Copy and paste use the browser's own clipboard: the selection is read from the page, never the OS clipboard.
  const send = page.debugger.sendCommand;
  page.debugger.sendCommand = async (method, params) => (method === "Runtime.evaluate" ? (page.commands.push([method, params]), { result: { value: "7Q-3381" } }) : send(method, params));
  page.commands.length = 0;
  await b.act({ type: "key", key: "c", modifiers: ["ctrl"] });
  assert.deepEqual(page.commands.map(([method]) => method), ["Runtime.evaluate"]);
  assert.ok(!page.commands.some(([, p]) => p?.commands), "no OS clipboard command");
  page.commands.length = 0;
  await b.act({ type: "key", key: "v", modifiers: ["meta"] });
  assert.deepEqual(page.commands, [["Input.insertText", { text: "7Q-3381" }]], "paste inserts the private clipboard");
  await b.backend.close();
});

test("agent browser: tabs from the chrome and the chords; window.open opens a tab; the address bar navigates", async () => {
  const b = await start({ url: "https://a.test/" });
  await b.act({ type: "click", x: tabLayout(1).plus.x + 5, y: 12 });
  assert.equal(b.pages().length, 2);
  assert.equal(b.backend.state().active, 1);
  assert.equal(b.backend.state().address.focused, true);
  await b.act({ type: "type", text: "example.com" });
  assert.equal(b.backend.state().address.text, "example.com");
  await b.act({ type: "key", key: "Enter" });
  assert.equal(b.active().webContents.url, "https://example.com");
  assert.equal(b.backend.state().address.focused, false);
  await b.act({ type: "key", key: "Tab", modifiers: ["ctrl"] });
  assert.equal(b.backend.state().active, 0);
  await b.act({ type: "key", key: "Tab", modifiers: ["ctrl", "shift"] });
  assert.equal(b.backend.state().active, 1);
  await b.act({ type: "click", x: tabLayout(2).tabs[0].x + 10, y: 12 });
  assert.equal(b.backend.state().active, 0);
  // ctrl+l selects the address; typing replaces it; words search.
  await b.act({ type: "key", key: "l", modifiers: ["ctrl"] });
  assert.deepEqual(b.backend.state().address, { focused: true, text: "https://a.test/", selected: true });
  await b.act({ type: "type", text: "bread recipe" });
  await b.act({ type: "key", key: "Enter" });
  assert.equal(b.active().webContents.url, "https://duckduckgo.com/?q=bread%20recipe");
  await b.act({ type: "key", key: "Left", modifiers: ["alt"] });
  assert.equal(b.active().webContents.url, "https://a.test/");
  await b.act({ type: "key", key: "Right", modifiers: ["alt"] });
  assert.equal(b.active().webContents.url, "https://duckduckgo.com/?q=bread%20recipe");
  // window.open / target=_blank: a new tab; never a window and never a file: page.
  assert.deepEqual(b.active().webContents.openHandler({ url: "https://popup.test/" }), { action: "deny" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(b.pages().length, 3);
  assert.equal(b.active().webContents.url, "https://popup.test/");
  assert.deepEqual(b.active().webContents.openHandler({ url: "file:///etc/passwd" }), { action: "deny" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(b.pages().length, 3);
  const blocked = { prevented: false, preventDefault() { this.prevented = true; } };
  b.active().webContents.emit("will-navigate", blocked, "file:///etc/passwd");
  assert.equal(blocked.prevented, true);
  // ✕ on a tab and ctrl+w close tabs; closing the last one leaves a new empty tab.
  await b.act({ type: "click", x: tabLayout(3).tabs[2].close.x + 5, y: 12 });
  assert.equal(b.pages().length, 2);
  await b.act({ type: "key", key: "w", modifiers: ["ctrl"] });
  await b.act({ type: "key", key: "w", modifiers: ["meta"] });
  assert.equal(b.pages().length, 1);
  assert.equal(b.active().webContents.url, "about:blank");
  await b.act({ type: "key", key: "t", modifiers: ["ctrl"] });
  assert.equal(b.pages().length, 2);
  // The chrome strip is redrawn with the tabs and the address.
  assert.match(b.fake.windows[0].webContents.scripts.at(-1), /New tab/);
  await b.backend.close();
});

test("agent browser: every document gets the page guard (private clipboard binding, no print or dialogs), frames in other processes too", async () => {
  const { PAGE_GUARD_JS } = await import("./computer-use-agent-browser.mjs");
  const b = await start({ url: "https://a.test/" });
  const page = b.active().webContents;
  const setup = page.commands.map(([method, p]) => [method, p?.name ?? p?.source?.slice(0, 10) ?? null]);
  assert.ok(setup.some(([m, n]) => m === "Runtime.addBinding" && n === "__omnirushClip"));
  assert.ok(setup.some(([m]) => m === "Page.addScriptToEvaluateOnNewDocument") && page.commands.find(([m]) => m === "Page.addScriptToEvaluateOnNewDocument")[1].source === PAGE_GUARD_JS);
  assert.ok(page.commands.some(([m, p]) => m === "Target.setAutoAttach" && p.autoAttach && p.flatten && p.waitForDebuggerOnStart));
  assert.ok(page.commands.some(([m, p]) => m === "Input.setInterceptDrags" && p.enabled));
  // The page's own Copy button (execCommand / navigator.clipboard) reaches the binding: then paste inserts it.
  page.debugger.emit("message", {}, "Runtime.bindingCalled", { name: "__omnirushClip", payload: "from the page" });
  page.commands.length = 0;
  await b.act({ type: "key", key: "v", modifiers: ["ctrl"] });
  assert.deepEqual(page.commands, [["Input.insertText", { text: "from the page" }]]);
  // A frame in another process: guarded and only then resumed.
  page.commands.length = 0;
  page.debugger.emit("message", {}, "Target.attachedToTarget", { sessionId: "S1", targetInfo: { type: "iframe" } });
  await new Promise((r) => setTimeout(r, 20));
  const methods = page.commands.map(([m]) => m);
  assert.deepEqual(methods.slice(-1), ["Runtime.runIfWaitingForDebugger"]);
  assert.ok(methods.indexOf("Page.addScriptToEvaluateOnNewDocument") < methods.indexOf("Runtime.runIfWaitingForDebugger"));
  // The guard itself: copy/cut/clipboard writes go to the binding, reads are refused, print is a no-op.
  for (const needle of ["execCommand", "writeText", "readText", "window.print = () => {}", "__omnirushClip"]) assert.ok(PAGE_GUARD_JS.includes(needle), needle);
  await b.backend.close();
});
