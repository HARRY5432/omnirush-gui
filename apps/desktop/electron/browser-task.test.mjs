import assert from "node:assert/strict";
import test from "node:test";

import { browserActInput, createBrowserTaskHost } from "./browser-task.mjs";
import { actApproval, ASK_REASONS } from "../../server/src/computer-use/shared/policy.mjs";

const PAGE_URL = "https://shop.example.com/cart";

function fakeTab(elements, { title = "Example shop" } = {}) {
  let url = PAGE_URL;
  const calls = { inserted: [], keys: [], clicks: 0 };
  const webContents = {
    getURL: () => url,
    getTitle: () => title,
    isDestroyed: () => false,
    stop() {},
    capturePage: async () => ({ resize: () => ({ toPNG: () => Buffer.from("png") }) }),
    insertText: async (text) => { calls.inserted.push(text); },
    sendInputEvent: (event) => { calls.keys.push(event); },
    debugger: { isAttached: () => false, attach() {}, detach() {}, sendCommand: async () => { calls.clicks += 1; } },
    executeJavaScriptInIsolatedWorld: async (_world, [{ code }]) => {
      if (code.startsWith("(function observePage")) {
        return { title, text: "", elements, viewport: { width: 800, height: 600 }, hasPasswordField: false };
      }
      return { x: 10, y: 10 };
    },
  };
  return { tab: { tabId: "t1", view: { webContents }, webMcpRevision: 0 }, calls, setUrl: (next) => { url = next; } };
}

function hostFor({ mode = "normal", visible = false, rules = true, allowedUrl = () => true, elements = [], title } = {}) {
  const { tab, calls, setUrl } = fakeTab(elements, { title });
  const asked = [];
  const navigated = [];
  const host = createBrowserTaskHost({
    getTab: (id) => (id === tab.tabId ? tab : null),
    tabsFor: () => [tab],
    ownerOf: () => "ses_1",
    activeFor: () => tab.tabId,
    isVisible: () => visible,
    openTab: async () => tab,
    navigate: async (_tab, url) => { navigated.push(url); setUrl(url); },
    allowed: async (url) => allowedUrl(url),
    enabled: () => true,
    confirm: async (request) => { asked.push(request); return true; },
    changed: () => {},
    siteTools: async () => ({ ok: true, tools: [] }),
    runSiteTool: async () => ({ ok: true }),
    mode: () => mode,
    ...(rules ? {
      actApproval: (input) => {
        const decision = actApproval(input);
        return { ask: decision.ask, reasons: decision.reasons.map((reason) => ({ ...reason, text: ASK_REASONS[reason.code] })) };
      },
    } : {}),
  });
  const call = (operation, args = {}) => host.request({ sessionId: "ses_1", operation, args: { tabId: tab.tabId, ...args } });
  async function act(action) {
    const observed = await call("observe");
    assert.equal(observed.ok, true, JSON.stringify(observed));
    return call("act", { observationId: observed.observationId, action });
  }
  return { call, act, asked, navigated, calls };
}

const BUTTONS = [
  { ref: "e1", tag: "button", role: null, name: "Next page", disabled: false, sensitive: false, bounds: { x: 0, y: 0, width: 20, height: 20 } },
  { ref: "e2", tag: "button", role: null, name: "Place order", disabled: false, sensitive: false, bounds: { x: 0, y: 0, width: 20, height: 20 } },
  { ref: "e3", tag: "input", role: null, name: "Search", disabled: false, sensitive: false, bounds: { x: 0, y: 0, width: 20, height: 20 } },
];

test("Normal: reading, ordinary clicks and typing run without asks while the tab is off-screen", async () => {
  const { act, asked, calls } = hostFor({ mode: "normal", visible: false, elements: BUTTONS });
  const click = await act({ type: "click", ref: "e1" });
  assert.equal(click.ok, true, JSON.stringify(click));
  const fill = await act({ type: "fill", ref: "e3", text: "blue shoes" });
  assert.equal(fill.ok, true, JSON.stringify(fill));
  const key = await act({ type: "key", key: "Tab" });
  assert.equal(key.ok, true, JSON.stringify(key));
  assert.equal(asked.length, 0);
  assert.equal(calls.clicks, 2);
  assert.deepEqual(calls.inserted, ["blue shoes"]);
});

test("Normal: a buy button asks, and needs the tab on screen to ask", async () => {
  const hidden = hostFor({ mode: "normal", visible: false, elements: BUTTONS });
  const result = await hidden.act({ type: "click", ref: "e2" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "needs_attention");
  assert.equal(result.dispatched, false);

  const shown = hostFor({ mode: "normal", visible: true, elements: BUTTONS });
  const allowed = await shown.act({ type: "click", ref: "e2" });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(shown.asked.length, 1);
  assert.match(shown.asked[0].detail, /pays, buys or orders/);
});

test("Normal: credential-looking text asks", async () => {
  const { act, asked } = hostFor({ mode: "normal", visible: true, elements: BUTTONS });
  const result = await act({ type: "fill", ref: "e3", text: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(asked.length, 1);
  assert.match(asked[0].detail, /password or key/);
});

test("Normal: Enter on a checkout page asks (no text at the key target)", async () => {
  const { act, asked } = hostFor({ mode: "normal", visible: true, elements: BUTTONS, title: "Checkout - Example shop" });
  const result = await act({ type: "key", key: "Enter" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(asked.length, 1);
});

test("Normal and Auto: no per-site ask for navigation, even off-screen", async () => {
  for (const mode of ["normal", "auto"]) {
    const { call, asked, navigated } = hostFor({ mode, visible: false });
    const result = await call("navigate", { url: "https://other.example.org/page" });
    assert.equal(result.ok, true, `${mode}: ${JSON.stringify(result)}`);
    assert.deepEqual(navigated, ["https://other.example.org/page"]);
    assert.equal(asked.length, 0);
  }
});

test("Auto: even a buy button runs without asking", async () => {
  const { act, asked } = hostFor({ mode: "auto", visible: false, elements: BUTTONS });
  const result = await act({ type: "click", ref: "e2" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(asked.length, 0);
});

test("Careful: site reading, navigation and every act ask", async () => {
  const { call, act, asked } = hostFor({ mode: "careful", visible: true, elements: BUTTONS });
  const click = await act({ type: "click", ref: "e1" });
  assert.equal(click.ok, true, JSON.stringify(click));
  assert.deepEqual(asked.map((item) => item.title), ["Allow website access?", "Allow browser action?"]);
  const nav = await call("navigate", { url: "https://other.example.org/page" });
  assert.equal(nav.ok, true, JSON.stringify(nav));
  assert.equal(asked.at(-1).title, "Allow website navigation?");
});

test("Careful: off-screen reading still needs the tab on screen", async () => {
  const { call, asked } = hostFor({ mode: "careful", visible: false, elements: BUTTONS });
  const result = await call("observe");
  assert.equal(result.ok, false);
  assert.equal(result.code, "needs_attention");
  assert.equal(asked.length, 0);
});

test("Blocked sites stay blocked in every mode", async () => {
  for (const mode of ["normal", "auto"]) {
    const { call } = hostFor({ mode, allowedUrl: (url) => !url.includes("blocked.example") });
    const result = await call("navigate", { url: "https://blocked.example/x" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "website_blocked");
  }
});

test("Without the shared rules every act asks", async () => {
  const { act, asked } = hostFor({ mode: "normal", visible: true, rules: false, elements: BUTTONS });
  const result = await act({ type: "click", ref: "e1" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(asked.filter((item) => item.title === "Allow browser action?").length, 1);
});

test("an unknown mode counts as Normal", async () => {
  const { act, asked } = hostFor({ mode: "something", visible: false, elements: BUTTONS });
  const result = await act({ type: "click", ref: "e1" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(asked.length, 0);
});

test("browser acts map onto the computer use act shape", () => {
  const observed = { title: "Checkout", elements: BUTTONS };
  assert.deepEqual(browserActInput("normal", { type: "fill", ref: "e3", text: "x" }, observed), {
    mode: "normal", action: { type: "type", text: "x" }, target: { text: "Search", secure: false }, window: { title: "Checkout" },
  });
  assert.deepEqual(browserActInput("normal", { type: "key", key: "Space" }, observed).action, { type: "key", key: "space" });
  assert.deepEqual(browserActInput("normal", { type: "click", x: 1, y: 2 }, observed).target, {});
});
