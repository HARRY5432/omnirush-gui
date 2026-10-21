// Computer use, the virtual display's worker (Linux, X11 via koffi): the whole
// screen of an Xvfb display started for the agent, never the person's screen.
// It captures the root window and sends XTest input anywhere on it; the
// pointer it moves is the display's own (the agent's cursor), so the person's
// mouse and keyboard are never touched. No window scoping, no person to
// interrupt, so no input watch either.
//
// The same file ships in omnirush-cli (src/computer-use/) and omnirush-gui
// (apps/server/src/computer-use/shared/); PARITY.sha256 lists it in both.
//
// Child process with an IPC channel (advanced serialization), like
// native-worker.mjs: {id, method, params} -> {id, result} | {id, error}.
// koffi is resolved from OMNIRUSH_KOFFI (its entry's absolute path), else "koffi".

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const send = (value) => process.send?.(value);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Points from (x0, y0) to (x1, y1) for a human-like glide: ease-out, about one step per 8 ms. */
export function glidePath(x0, y0, x1, y1) {
  const distance = Math.hypot(x1 - x0, y1 - y0);
  if (distance < 2) return [{ x: x1, y: y1 }];
  const steps = Math.max(4, Math.min(28, Math.round(distance / 28)));
  const out = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps, e = 1 - (1 - t) ** 3;
    out.push({ x: Math.round(x0 + (x1 - x0) * e), y: Math.round(y0 + (y1 - y0) * e) });
  }
  out[out.length - 1] = { x: x1, y: y1 };
  return out;
}

function open() {
  if (!process.env.DISPLAY) fail("desktop_unavailable", "The virtual display is not set.");
  const koffi = require(process.env.OMNIRUSH_KOFFI || "koffi");
  const x = koffi.load("libX11.so.6"), xt = koffi.load("libXtst.so.6");
  const display = x.func("void *XOpenDisplay(str name)")(null);
  if (!display) fail("desktop_unavailable", "Could not connect to the virtual display.");
  const close = x.func("int XCloseDisplay(void *display)");
  const root = x.func("ulong XDefaultRootWindow(void *display)")(display);
  const sync = x.func("int XSync(void *display, int discard)");
  const free = x.func("int XFree(void *data)");
  const attributes = koffi.struct("CUV_XWindowAttributes", {
    x: "int", y: "int", width: "int", height: "int", border_width: "int", depth: "int", visual: "void *", root: "ulong", class: "int", bit_gravity: "int", win_gravity: "int", backing_store: "int", backing_planes: "ulong", backing_pixel: "ulong", save_under: "int", colormap: "ulong", map_installed: "int", map_state: "int", all_event_masks: "long", your_event_mask: "long", do_not_propagate_mask: "long", override_redirect: "int", screen: "void *",
  });
  const getAttributes = x.func("int XGetWindowAttributes(void *display, ulong window, _Out_ CUV_XWindowAttributes *attributes)");
  const imageType = koffi.struct("CUV_XImage", { width: "int", height: "int", xoffset: "int", format: "int", data: "void *", byte_order: "int", bitmap_unit: "int", bitmap_bit_order: "int", bitmap_pad: "int", depth: "int", bytes_per_line: "int", bits_per_pixel: "int", red_mask: "ulong", green_mask: "ulong", blue_mask: "ulong", obdata: "void *", functions: koffi.struct({ create_image: "void *", destroy_image: "void *", get_pixel: "void *", put_pixel: "void *", sub_image: "void *", add_pixel: "void *" }) });
  const getImage = x.func("CUV_XImage *XGetImage(void *display, ulong drawable, int x, int y, uint width, uint height, ulong planes, int format)");
  const destroyImage = x.func("int XDestroyImage(CUV_XImage *image)");
  const rawKey = xt.func("int XTestFakeKeyEvent(void *display, uint key, int down, ulong delay)");
  const rawButton = xt.func("int XTestFakeButtonEvent(void *display, uint button, int down, ulong delay)");
  const rawMotion = xt.func("int XTestFakeMotionEvent(void *display, int screen, int x, int y, ulong delay)");
  const keysym = x.func("ulong XStringToKeysym(str name)");
  const keycode = x.func("uint8_t XKeysymToKeycode(void *display, ulong symbol)");
  const symbolAt = x.func("ulong XKeycodeToKeysym(void *display, uint8_t code, int index)");
  const displayKeycodes = x.func("int XDisplayKeycodes(void *display, _Out_ int *min, _Out_ int *max)");
  const getMapping = x.func("void *XGetKeyboardMapping(void *display, uint8_t first, int count, _Out_ int *per)");
  const changeMapping = x.func("int XChangeKeyboardMapping(void *display, int first, int per, ulong *symbols, int count)");
  const queryPointer = x.func("int XQueryPointer(void *display, ulong window, _Out_ ulong *root, _Out_ ulong *child, _Out_ int *root_x, _Out_ int *root_y, _Out_ int *win_x, _Out_ int *win_y, _Out_ uint *mask)");
  const downKeys = new Set();
  const downButtons = new Set();
  let spare = null;
  const size = () => { const a = {}; if (!getAttributes(display, root, a)) fail("desktop_unavailable", "The virtual display is gone."); return { width: a.width, height: a.height }; };
  const pointer = () => { const r = [0], c = [0], rx = [0], ry = [0], wx = [0], wy = [0], m = [0]; queryPointer(display, root, r, c, rx, ry, wx, wy, m); return { x: rx[0], y: ry[0] }; };
  const held = () => send({ event: "held", keys: [...downKeys], buttons: [...downButtons] });
  const release = () => {
    for (const code of downKeys) rawKey(display, code, 0, 0);
    downKeys.clear();
    for (const button of downButtons) rawButton(display, button, 0, 0);
    downButtons.clear();
    sync(display, 0);
    held();
  };
  const press = (code, down) => {
    if (down) downKeys.add(code); else downKeys.delete(code);
    rawKey(display, code, down ? 1 : 0, 0);
    sync(display, 0);
  };
  const button = (b, down) => {
    if (down) downButtons.add(b); else downButtons.delete(b);
    rawButton(display, b, down ? 1 : 0, 0);
    sync(display, 0);
  };
  const codeOf = (symbol) => keycode(display, typeof symbol === "number" ? symbol : keysym(symbol));
  // A keycode with no symbols, borrowed to type a character the layout does not have (as xdotool does).
  const spareCode = () => {
    if (spare !== null) return spare;
    const min = [0], max = [0]; displayKeycodes(display, min, max);
    const per = [0], ptr = getMapping(display, min[0], max[0] - min[0] + 1, per);
    if (!ptr) return (spare = 0);
    try {
      const syms = koffi.decode(ptr, "ulong", (max[0] - min[0] + 1) * per[0]);
      for (let code = max[0]; code >= min[0]; code -= 1) {
        const row = Array.from(syms.slice((code - min[0]) * per[0], (code - min[0] + 1) * per[0]), Number);
        if (row.every((s) => s === 0)) return (spare = code);
      }
    } finally { free(ptr); }
    return (spare = 0);
  };
  const remap = (code, symbol) => { changeMapping(display, code, 1, [symbol], 1); sync(display, 0); };
  // One character: its own key (Shift when it sits on level 2), else the spare keycode remapped to it,
  // so any Unicode text arrives as the character itself (no IME composition involved).
  async function typeSymbol(symbol) {
    const code = codeOf(symbol);
    const level0 = code ? Number(symbolAt(display, code, 0)) : 0, level1 = code ? Number(symbolAt(display, code, 1)) : 0;
    if (code && (level0 === symbol || level1 === symbol)) {
      const shifted = level1 === symbol && level0 !== symbol;
      const shift = codeOf("Shift_L");
      if (shifted) press(shift, true);
      press(code, true); press(code, false);
      if (shifted) press(shift, false);
      return;
    }
    const borrowed = spareCode();
    if (!borrowed) fail("unsupported_action", "This character cannot be typed in the virtual display.");
    remap(borrowed, symbol);
    await wait(12);
    try { press(borrowed, true); press(borrowed, false); await wait(8); } finally { remap(borrowed, 0); }
  }
  const NAMES = { Enter: "Return", Tab: "Tab", Escape: "Escape", Backspace: "BackSpace", Delete: "Delete", Insert: "Insert", Space: "space", Left: "Left", Up: "Up", Right: "Right", Down: "Down", Home: "Home", End: "End", PageUp: "Prior", PageDown: "Next", CapsLock: "Caps_Lock", ContextMenu: "Menu", PrintScreen: "Print" };
  const MODS = { ctrl: "Control_L", shift: "Shift_L", alt: "Alt_L", meta: "Super_L" };
  const symbolOfKey = (key) => (NAMES[key] ? Number(keysym(NAMES[key])) : /^F\d+$/.test(key) ? Number(keysym(key)) : key.codePointAt(0));
  async function glideTo(tx, ty) {
    const from = pointer();
    for (const p of glidePath(from.x, from.y, Math.round(tx), Math.round(ty))) { rawMotion(display, -1, p.x, p.y, 0); sync(display, 0); await wait(8); }
  }
  function capture() {
    const { width, height } = size();
    const ptr = getImage(display, root, 0, 0, width, height, ~0n, 2);
    if (!ptr) fail("capture_unavailable", "The virtual display could not be captured.");
    try {
      const v = koffi.decode(ptr, imageType);
      const bytes = v.bits_per_pixel / 8;
      if (![3, 4].includes(bytes)) fail("capture_unavailable", "This virtual display format is unavailable.");
      const src = Buffer.from(koffi.decode(v.data, "uint8_t", v.bytes_per_line * v.height));
      const masks = [v.red_mask, v.green_mask, v.blue_mask].map((mask) => { const m = Number(mask) >>> 0; const shift = Math.log2((m & -m) >>> 0); return { m, shift, max: m >>> shift }; });
      const out = Buffer.alloc(width * height * 4);
      const fast = bytes === 4 && v.byte_order === 0 && masks[0].m === 0xff0000 && masks[1].m === 0xff00 && masks[2].m === 0xff;
      for (let y = 0; y < height; y++) {
        const row = y * v.bytes_per_line;
        for (let c = 0; c < width; c++) {
          const d = (y * width + c) * 4;
          if (fast) { const o = row + c * 4; out[d] = src[o + 2]; out[d + 1] = src[o + 1]; out[d + 2] = src[o]; }
          else {
            const px = v.byte_order === 0 ? src.readUIntLE(row + c * bytes, bytes) : src.readUIntBE(row + c * bytes, bytes);
            for (let k = 0; k < 3; k++) out[d + k] = Math.round(((px & masks[k].m) >>> masks[k].shift) * 255 / masks[k].max);
          }
          out[d + 3] = 255;
        }
      }
      return { width, height, data: out };
    } finally { destroyImage(ptr); }
  }
  async function act(action) {
    const mods = (action.modifiers ?? []).map((m) => codeOf(MODS[m])).filter(Boolean);
    const holdMods = () => { for (const code of mods) press(code, true); };
    const releaseMods = () => { for (const code of [...mods].reverse()) press(code, false); };
    try {
      if (action.type === "type") {
        for (const char of action.text) {
          const cp = char.codePointAt(0);
          const symbol = char === "\n" ? Number(keysym("Return")) : char === "\t" ? Number(keysym("Tab")) : cp <= 0xff ? cp : 0x01000000 + cp;
          await typeSymbol(symbol);
          await wait(6);
        }
      } else if (action.type === "key") {
        const symbol = symbolOfKey(action.key);
        const code = symbol ? codeOf(symbol) : 0;
        if (!code) fail("unsupported_action", "This key is unavailable in the virtual display's keyboard layout.");
        const shifted = !(action.modifiers ?? []).includes("shift") && Number(symbolAt(display, code, 1)) === symbol && Number(symbolAt(display, code, 0)) !== symbol;
        const shift = codeOf("Shift_L");
        holdMods(); if (shifted) press(shift, true);
        press(code, true); await wait(10); press(code, false);
        if (shifted) press(shift, false); releaseMods();
      } else if (action.type === "move") {
        await glideTo(action.x, action.y);
      } else if (["click", "double_click", "right_click"].includes(action.type)) {
        await glideTo(action.x, action.y);
        await wait(40);
        const b = action.type === "right_click" ? 3 : 1;
        holdMods();
        for (let i = 0; i < (action.type === "double_click" ? 2 : 1); i++) {
          button(b, true); await wait(30); button(b, false);
          if (i === 0 && action.type === "double_click") await wait(70);
        }
        releaseMods();
      } else if (action.type === "scroll") {
        await glideTo(action.x, action.y);
        await wait(30);
        const b = action.axis === "horizontal" ? (action.delta > 0 ? 7 : 6) : (action.delta > 0 ? 5 : 4);
        holdMods();
        for (let i = 0; i < Math.abs(action.delta); i++) { button(b, true); await wait(8); button(b, false); await wait(25); }
        releaseMods();
      } else if (action.type === "drag") {
        await glideTo(action.path[0].x, action.path[0].y);
        await wait(40);
        holdMods();
        button(1, true); held();
        let last = action.path[0];
        for (const p of action.path.slice(1)) {
          for (const q of glidePath(last.x, last.y, p.x, p.y)) { rawMotion(display, -1, q.x, q.y, 0); sync(display, 0); await wait(10); }
          last = p;
        }
        await wait(40);
        button(1, false);
        releaseMods();
      } else if (action.type === "wait") {
        await wait(Math.max(0, Math.min(5000, action.ms ?? 500)));
      } else fail("unsupported_action", "Unknown action.");
    } finally { release(); }
  }
  /** Key-up and button-up for input another process may have left down (a crashed host). */
  function up({ keys = [], buttons = [] } = {}) {
    for (const name of ["Control_L", "Control_R", "Shift_L", "Shift_R", "Alt_L", "Alt_R", "Super_L", "Super_R"]) { const code = codeOf(name); if (code) rawKey(display, code, 0, 0); }
    for (const code of keys.filter((k) => Number.isInteger(k) && k > 7 && k < 256)) rawKey(display, code, 0, 0);
    for (const b of new Set([1, 2, 3, ...buttons.filter((n) => Number.isInteger(n) && n >= 1 && n <= 9)])) rawButton(display, b, 0, 0);
    sync(display, 0);
  }
  return { size, capture, act, pointer, release, up, close() { release(); close(display); } };
}

// Worker mode only when run as the process's script (importing it, as tests do, runs nothing).
const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain && process.send) {
  let backend = null;
  try {
    backend = open();
    send({ event: "ready", supported: true, size: backend.size() });
  } catch (error) {
    send({ event: "ready", supported: false, code: error.code ?? "native_unavailable", error: error.message });
  }
  process.on("message", async ({ id, method, params }) => {
    try {
      if (method === "shutdown") { backend?.close(); backend = null; send({ id, result: {} }); process.disconnect?.(); return; }
      if (!backend) fail("native_unavailable", "The virtual display is unavailable.");
      let result;
      if (method === "size") result = backend.size();
      else if (method === "capture") result = backend.capture();
      else if (method === "pointer") result = backend.pointer();
      else if (method === "act") { await backend.act(params.action); result = {}; }
      else if (method === "release") { backend.release(); result = {}; }
      else if (method === "up") { backend.up(params); result = {}; }
      else fail("unknown_method", "Unknown operation.");
      send({ id, result });
    } catch (error) {
      send({ id, error: { code: error.code ?? "native_error", message: error.message } });
    }
  });
  process.on("disconnect", () => { try { backend?.close(); } catch { /* gone */ } process.exit(0); });
}
