// Computer use, native worker (Windows SendInput/GDI, Linux X11/XTest/XInput2
// via koffi): a child process the portable host talks to over Node IPC. No
// shell, no network. The parent never runs native code itself, so a crash
// here cannot take the app down; held keys/buttons are reported ("held"
// events) and the parent releases them with `--release` if this exits.
//
// The same file ships in omnirush-cli (src/computer-use/) and omnirush-gui
// (apps/server/src/computer-use/shared/); PARITY.sha256 lists it in both.
// koffi is resolved from OMNIRUSH_KOFFI (an absolute path to its entry, set by
// the parent) or next to this file.
//
// Coordinates are native pixels (Windows: per-monitor DPI aware; X11: root).
// Captures are raw RGBA { width, height, data } at native size.

import { readFileSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const koffi = require(process.env.OMNIRUSH_KOFFI || "koffi");

const post = (value) => process.send?.(value);
let generation = 0;
let backend;
let held = { keys: [], buttons: [] };
const lastInput = { synthetic: false, at: 0, kind: "" };
const changed = () => { generation += 1; post({ event: "person-input", generation }); };
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function setHeld(keys, buttons) {
  const next = { keys: [...keys], buttons: [...buttons] };
  if (JSON.stringify(next) === JSON.stringify(held)) return;
  held = next;
  post({ event: "held", ...held });
}

// Chords that act on the whole desktop (task switching, lock, VT switch) are refused.
function blockedChord(key, modifiers) {
  const m = new Set(modifiers);
  if (m.has("ctrl") && m.has("alt")) return true;
  if (m.has("alt") && (key === "Tab" || key === "Escape")) return true;
  if (m.has("meta") && (key === "l" || key === "Tab" || key === "d" || key === "r")) return true;
  if (m.has("ctrl") && key === "Escape") return true;
  return false;
}

// ------------------------------------------------------------------ Windows

function windows() {
  const u = koffi.load("user32.dll"), k = koffi.load("kernel32.dll"), dwm = koffi.load("dwmapi.dll"), gdi = koffi.load("gdi32.dll");
  const f = (lib, declaration) => lib.func(declaration);
  const rect = koffi.struct("CU2_RECT", { left: "int32_t", top: "int32_t", right: "int32_t", bottom: "int32_t" });
  const point = koffi.struct("CU2_POINT", { x: "int32_t", y: "int32_t" });
  const filetime = koffi.struct("CU2_FILETIME", { low: "uint32_t", high: "uint32_t" });
  const mouse = koffi.struct("CU2_MOUSEINPUT", { dx: "int32_t", dy: "int32_t", mouseData: "uint32_t", dwFlags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t" });
  const keyboard = koffi.struct("CU2_KEYBDINPUT", { wVk: "uint16_t", wScan: "uint16_t", dwFlags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t" });
  const hardware = koffi.struct("CU2_HARDWAREINPUT", { uMsg: "uint32_t", wParamL: "uint16_t", wParamH: "uint16_t" });
  const input = koffi.struct("CU2_INPUT", { type: "uint32_t", value: koffi.union("CU2_INPUT_VALUE", { mi: mouse, ki: keyboard, hi: hardware }) });
  const hookKey = koffi.struct("CU2_KBDLLHOOKSTRUCT", { vkCode: "uint32_t", scanCode: "uint32_t", flags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t" });
  const hookMouse = koffi.struct("CU2_MSLLHOOKSTRUCT", { pt: point, mouseData: "uint32_t", flags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t" });
  koffi.struct("CU2_MSG", { hwnd: "uintptr_t", message: "uint32_t", wParam: "uintptr_t", lParam: "intptr_t", time: "uint32_t", pt: point, lPrivate: "uint32_t" });
  koffi.struct("CU2_GUITHREADINFO", { cbSize: "uint32_t", flags: "uint32_t", hwndActive: "uintptr_t", hwndFocus: "uintptr_t", hwndCapture: "uintptr_t", hwndMenuOwner: "uintptr_t", hwndMoveSize: "uintptr_t", hwndCaret: "uintptr_t", rcCaret: rect });
  koffi.struct("CU2_MONITORINFO", { cbSize: "uint32_t", rcMonitor: rect, rcWork: rect, dwFlags: "uint32_t" });
  koffi.struct("CU2_BITMAPINFOHEADER", { biSize: "uint32_t", biWidth: "int32_t", biHeight: "int32_t", biPlanes: "uint16_t", biBitCount: "uint16_t", biCompression: "uint32_t", biSizeImage: "uint32_t", biXPelsPerMeter: "int32_t", biYPelsPerMeter: "int32_t", biClrUsed: "uint32_t", biClrImportant: "uint32_t" });
  const enumProto = koffi.proto("int __stdcall CU2_ENUMPROC(uintptr_t hwnd, intptr_t parameter)");
  const monitorProto = koffi.proto("int __stdcall CU2_MONITORPROC(uintptr_t monitor, uintptr_t hdc, CU2_RECT *rect, intptr_t parameter)");
  // Low-level hook LPARAM points to event data: keep it a pointer so koffi can decode it.
  const hookProto = koffi.proto("intptr_t __stdcall CU2_HOOKPROC(int code, uintptr_t wParam, void *lParam)");
  const enumWindows = f(u, "int __stdcall EnumWindows(CU2_ENUMPROC *callback, intptr_t parameter)");
  const enumChildren = f(u, "int __stdcall EnumChildWindows(uintptr_t parent, CU2_ENUMPROC *callback, intptr_t parameter)");
  const enumMonitors = f(u, "int __stdcall EnumDisplayMonitors(uintptr_t hdc, void *clip, CU2_MONITORPROC *callback, intptr_t parameter)");
  const monitorInfo = f(u, "int __stdcall GetMonitorInfoW(uintptr_t monitor, _Inout_ CU2_MONITORINFO *info)");
  const monitorOf = f(u, "uintptr_t __stdcall MonitorFromWindow(uintptr_t hwnd, uint32_t flags)");
  const dpiOfWindow = f(u, "uint32_t __stdcall GetDpiForWindow(uintptr_t hwnd)");
  const visible = f(u, "int __stdcall IsWindowVisible(uintptr_t hwnd)");
  const isWindow = f(u, "int __stdcall IsWindow(uintptr_t hwnd)");
  const iconic = f(u, "int __stdcall IsIconic(uintptr_t hwnd)");
  const pidOf = f(u, "uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)");
  const titleOf = f(u, "int __stdcall GetWindowTextW(uintptr_t hwnd, _Out_ uint16_t *text, int count)");
  const classOf = f(u, "int __stdcall GetClassNameW(uintptr_t hwnd, _Out_ uint16_t *text, int count)");
  const styleOf = f(u, "int32_t __stdcall GetWindowLongW(uintptr_t hwnd, int index)");
  const windowRect = f(u, "int __stdcall GetWindowRect(uintptr_t hwnd, _Out_ CU2_RECT *rect)");
  const boundsOf = f(dwm, "int32_t __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32_t attribute, _Out_ CU2_RECT *rect, uint32_t size)");
  const foreground = f(u, "uintptr_t __stdcall GetForegroundWindow()");
  const ancestor = f(u, "uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint32_t flag)");
  const fromPoint = f(u, "uintptr_t __stdcall WindowFromPoint(CU2_POINT point)");
  const cursorPos = f(u, "int __stdcall GetCursorPos(_Out_ CU2_POINT *point)");
  const clientToScreen = f(u, "int __stdcall ClientToScreen(uintptr_t hwnd, _Inout_ CU2_POINT *point)");
  const guiInfo = f(u, "int __stdcall GetGUIThreadInfo(uint32_t thread, _Inout_ CU2_GUITHREADINFO *info)");
  const focusWindow = f(u, "int __stdcall SetForegroundWindow(uintptr_t hwnd)");
  const send = f(u, "uint32_t __stdcall SendInput(uint32_t count, CU2_INPUT *inputs, int size)");
  const metrics = f(u, "int __stdcall GetSystemMetrics(int index)");
  const openProcess = f(k, "uintptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const processName = f(k, "int __stdcall QueryFullProcessImageNameW(uintptr_t process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)");
  const times = f(k, "int __stdcall GetProcessTimes(uintptr_t process, _Out_ CU2_FILETIME *created, _Out_ CU2_FILETIME *exited, _Out_ CU2_FILETIME *kernel, _Out_ CU2_FILETIME *user)");
  const closeHandle = f(k, "int __stdcall CloseHandle(uintptr_t handle)");
  const openDesktop = f(u, "uintptr_t __stdcall OpenInputDesktop(uint32_t flags, int inherit, uint32_t access)");
  const closeDesktop = f(u, "int __stdcall CloseDesktop(uintptr_t desktop)");
  const userInfo = f(u, "int __stdcall GetUserObjectInformationW(uintptr_t object, int index, _Out_ uint16_t *value, uint32_t size, _Out_ uint32_t *needed)");
  const getDC = f(u, "uintptr_t __stdcall GetDC(uintptr_t hwnd)");
  const releaseDC = f(u, "int __stdcall ReleaseDC(uintptr_t hwnd, uintptr_t hdc)");
  const printWindow = f(u, "int __stdcall PrintWindow(uintptr_t hwnd, uintptr_t hdc, uint32_t flags)");
  const createDC = f(gdi, "uintptr_t __stdcall CreateCompatibleDC(uintptr_t hdc)");
  const createBitmap = f(gdi, "uintptr_t __stdcall CreateCompatibleBitmap(uintptr_t hdc, int width, int height)");
  const select = f(gdi, "uintptr_t __stdcall SelectObject(uintptr_t hdc, uintptr_t object)");
  const deleteObject = f(gdi, "int __stdcall DeleteObject(uintptr_t object)");
  const deleteDC = f(gdi, "int __stdcall DeleteDC(uintptr_t hdc)");
  const getBits = f(gdi, "int __stdcall GetDIBits(uintptr_t hdc, uintptr_t bitmap, uint32_t start, uint32_t lines, _Out_ uint8_t *bits, CU2_BITMAPINFOHEADER *info, uint32_t usage)");
  // Per-monitor DPI awareness v2 for this process, then this thread.
  try { f(u, "int __stdcall SetProcessDpiAwarenessContext(intptr_t context)")(-4); } catch { /* older Windows */ }
  f(u, "intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)")(-4);
  const marker = 0x4f4d4e49;
  const injectBatch = (items) => {
    if (!items.length) return;
    if (send(items.length, items, koffi.sizeof(input)) !== items.length) fail("input_unavailable", "Windows blocked input. Keep the app on the active desktop, run it without administrator privileges, and continue.");
  };
  const keyItem = (vk, scan, flags) => ({ type: 1, value: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: marker } } });
  const mouseItem = (flags, data = 0, dx = 0, dy = 0) => ({ type: 0, value: { mi: { dx, dy, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: marker } } });
  const downKeys = new Set();
  const downButtons = new Set();
  const release = () => {
    const items = [...downKeys].map((key) => keyItem(key, 0, 2));
    if (downButtons.has(1)) items.push(mouseItem(4));
    if (downButtons.has(3)) items.push(mouseItem(0x10));
    try { injectBatch(items); } catch { /* best effort */ }
    downKeys.clear(); downButtons.clear(); setHeld([], []);
  };
  const peek = f(u, "int __stdcall PeekMessageW(_Out_ CU2_MSG *message, uintptr_t hwnd, uint32_t first, uint32_t last, uint32_t remove)");
  const nextHook = f(u, "intptr_t __stdcall CallNextHookEx(uintptr_t hook, int code, uintptr_t wParam, void *lParam)");
  const installHook = f(u, "uintptr_t __stdcall SetWindowsHookExW(int type, CU2_HOOKPROC *callback, uintptr_t module, uint32_t thread)");
  const uninstall = f(u, "int __stdcall UnhookWindowsHookEx(uintptr_t hook)");
  let callbacks = [], hooks = [], interrupting = false;
  // Global hooks run only while a session is active or an approval is pending.
  const startMonitoring = (interrupt = true) => {
    interrupting = interrupt || interrupting;
    if (hooks.length) return;
    callbacks = [[hookKey, 0x10], [hookMouse, 0x1]].map(([type, injectedFlag]) => koffi.register((code, wParam, lParam) => {
      if (code >= 0) {
        const value = koffi.decode(lParam, type);
        if (Number(value.dwExtraInfo) !== marker) {
          const down = [0x100, 0x104, 0x201, 0x204, 0x207].includes(Number(wParam));
          if (down) Object.assign(lastInput, { synthetic: (value.flags & injectedFlag) !== 0, at: Date.now(), kind: type === hookKey ? "key" : "pointer" });
          if (interrupting) { changed(); release(); }
        }
      }
      return nextHook(0, code, wParam, lParam);
    }, koffi.pointer(hookProto)));
    hooks = [installHook(13, callbacks[0], 0, 0), installHook(14, callbacks[1], 0, 0)];
    if (hooks.some((v) => !v)) {
      hooks.forEach((h) => { if (h) uninstall(h); });
      callbacks.forEach((c) => koffi.unregister(c));
      hooks = []; callbacks = [];
      fail("input_unavailable", "Windows input monitoring is unavailable. Restart on your normal desktop.");
    }
  };
  const stopMonitoring = () => {
    hooks.forEach((hook) => uninstall(hook));
    callbacks.forEach((callback) => koffi.unregister(callback));
    hooks = []; callbacks = []; interrupting = false;
  };
  const poll = () => {
    if (!hooks.length) return;
    const value = {};
    while (peek(value, 0, 0, 0, 1)) { /* pump hook messages */ }
  };
  const available = () => {
    const handle = openDesktop(0, 0, 1);
    if (!handle) return false;
    try { const data = Buffer.alloc(512), size = [0]; return Boolean(userInfo(handle, 2, data, data.length, size)) && data.toString("utf16le").split("\0")[0].toLowerCase() === "default"; }
    finally { closeDesktop(handle); }
  };
  const text = (fn, id, count = 4096) => { const buffer = Buffer.alloc(count * 2); fn(id, buffer, count); return buffer.toString("utf16le").split("\0")[0]; };
  function window(id) {
    if (!available() || !isWindow(id) || !visible(id) || iconic(id)) fail("window_unavailable", "Keep the approved app visible on an unlocked desktop.");
    const pid = [0]; const thread = pidOf(id, pid);
    const handle = openProcess(0x1000, 0, pid[0]);
    if (!handle) fail("window_unavailable", "This app cannot be inspected. Run it without administrator privileges.");
    let executable, identity;
    try {
      const name = Buffer.alloc(65536), size = [32768], created = {};
      if (!processName(handle, 0, name, size) || !times(handle, created, {}, {}, {})) fail("window_unavailable", "The app identity could not be verified.");
      executable = name.toString("utf16le", 0, size[0] * 2);
      identity = `${pid[0]}:${created.high}:${created.low}`;
    } finally { closeHandle(handle); }
    const box = {};
    if (boundsOf(id, 9, box, koffi.sizeof(rect)) !== 0) fail("window_unavailable", "The window bounds could not be read.");
    const bounds = { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
    if (bounds.width <= 0 || bounds.height <= 0) fail("window_unavailable", "The window is not visible.");
    let dpi = 96;
    try { dpi = dpiOfWindow(id) || 96; } catch { /* older Windows */ }
    return { id: Number(id), pid: pid[0], thread, identity, executable, appId: executable.toLowerCase(), appName: path.win32.basename(executable, ".exe"), title: text(titleOf, id), bounds, dpi, scale: dpi / 96, monitor: String(Number(monitorOf(id, 2))) };
  }
  function screens() {
    const out = [];
    const cb = koffi.register((monitor) => {
      const info = { cbSize: koffi.sizeof("CU2_MONITORINFO"), rcMonitor: {}, rcWork: {}, dwFlags: 0 };
      if (monitorInfo(monitor, info)) out.push({ id: String(Number(monitor)), x: info.rcMonitor.left, y: info.rcMonitor.top, width: info.rcMonitor.right - info.rcMonitor.left, height: info.rcMonitor.bottom - info.rcMonitor.top, scale: 1, primary: (info.dwFlags & 1) === 1 });
      return 1;
    }, koffi.pointer(monitorProto));
    try { enumMonitors(0, null, cb, 0); } finally { koffi.unregister(cb); }
    return out;
  }
  function check(expected, expectedGeneration, deadline) {
    if (Date.now() >= deadline) fail("session_expired", "The approved session expired. Start a new session.");
    poll();
    if (generation !== expectedGeneration) fail("paused_by_person", "Your input paused computer use. Choose Continue when ready.");
    const current = window(expected.id);
    if (current.identity !== expected.identity || JSON.stringify(current.bounds) !== JSON.stringify(expected.bounds)) fail("window_changed", "The approved window moved or changed. Observe it again.");
    if (Number(ancestor(foreground(), 2)) !== expected.id) fail("focus_changed", "The approved window must stay in front. Choose Continue when ready.");
    return current;
  }
  const hit = (expected, p) => Number(ancestor(fromPoint({ x: p.x, y: p.y }), 2)) === expected.id;
  const moveTo = (x, y) => {
    const left = metrics(76), top = metrics(77), width = metrics(78), height = metrics(79);
    if (width <= 1 || height <= 1) fail("input_unavailable", "The desktop bounds could not be read.");
    return mouseItem(0x8000 | 0x4000 | 1, 0, Math.round(((x - left) * 65535) / (width - 1)), Math.round(((y - top) * 65535) / (height - 1)));
  };
  const VK = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Insert: 45, Space: 32, Left: 37, Up: 38, Right: 39, Down: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, CapsLock: 20, ContextMenu: 93, PrintScreen: 44 };
  const OEM = { ";": 0xba, "=": 0xbb, ",": 0xbc, "-": 0xbd, ".": 0xbe, "/": 0xbf, "`": 0xc0, "[": 0xdb, "\\": 0xdc, "]": 0xdd, "'": 0xde };
  const MOD = { ctrl: 17, shift: 16, alt: 18, meta: 0x5b };
  const vkOf = (key) => VK[key] ?? (/^F\d+$/.test(key) ? 111 + Number(key.slice(1)) : /^[a-z0-9]$/.test(key) ? key.toUpperCase().charCodeAt(0) : OEM[key] ?? null);
  const EXTENDED = new Set([33, 34, 35, 36, 37, 38, 39, 40, 45, 46, 93]);
  function secureRects(expected) {
    const out = [];
    const cb = koffi.register((child) => {
      try {
        if (visible(child) && /^edit$/i.test(text(classOf, child, 64)) && (styleOf(child, -16) & 0x20)) {
          const r = {};
          if (windowRect(child, r)) out.push({ x: r.left - expected.bounds.x, y: r.top - expected.bounds.y, width: r.right - r.left, height: r.bottom - r.top });
        }
      } catch { /* skip */ }
      return 1;
    }, koffi.pointer(enumProto));
    try { enumChildren(expected.id, cb, 0); } finally { koffi.unregister(cb); }
    return out;
  }
  function caret(expected) {
    const info = { cbSize: koffi.sizeof("CU2_GUITHREADINFO"), flags: 0, hwndActive: 0, hwndFocus: 0, hwndCapture: 0, hwndMenuOwner: 0, hwndMoveSize: 0, hwndCaret: 0, rcCaret: {} };
    if (!guiInfo(expected.thread ?? 0, info) || !info.hwndCaret) return null;
    const p = { x: info.rcCaret.left, y: info.rcCaret.top };
    if (!clientToScreen(info.hwndCaret, p)) return null;
    return { x: p.x - expected.bounds.x - 4, y: p.y - expected.bounds.y - 4, width: info.rcCaret.right - info.rcCaret.left + 8, height: info.rcCaret.bottom - info.rcCaret.top + 8 };
  }
  async function capture(expected) {
    const current = window(expected.id);
    if (current.identity !== expected.identity) fail("window_changed", "The window changed. Observe again.");
    const wr = {};
    if (!windowRect(current.id, wr)) fail("capture_unavailable", "The window image is unavailable.");
    const fw = wr.right - wr.left, fh = wr.bottom - wr.top;
    if (fw <= 0 || fh <= 0 || fw * fh > 33_177_600) fail("capture_unavailable", "This window is too large to capture. Resize it and observe again.");
    const screen = getDC(0), memory = createDC(screen), bitmap = createBitmap(screen, fw, fh), previous = select(memory, bitmap);
    try {
      // PW_RENDERFULLCONTENT: the window's own pixels, never another window covering it.
      if (!printWindow(current.id, memory, 2)) fail("capture_unavailable", "The window image is unavailable. Keep it visible and observe again.");
      const bits = Buffer.alloc(fw * fh * 4);
      const header = { biSize: 40, biWidth: fw, biHeight: -fh, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
      if (getBits(memory, bitmap, 0, fh, bits, header, 0) !== fh) fail("capture_unavailable", "The window image could not be read.");
      const ox = current.bounds.x - wr.left, oy = current.bounds.y - wr.top, { width, height } = current.bounds;
      const data = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
        const s = ((y + oy) * fw + (x + ox)) * 4, o = (y * width + x) * 4;
        data[o] = bits[s + 2]; data[o + 1] = bits[s + 1]; data[o + 2] = bits[s]; data[o + 3] = 255;
      }
      return { width, height, data, secure: secureRects(current), caret: caret(current) };
    } finally { select(memory, previous); deleteObject(bitmap); deleteDC(memory); releaseDC(0, screen); }
  }
  async function act(expected, expectedGeneration, action, deadline) {
    const checked = () => check(expected, expectedGeneration, deadline);
    const modifiers = action.modifiers ?? [];
    const modsDown = modifiers.map((m) => keyItem(MOD[m], 0, MOD[m] === 0x5b ? 1 : 0));
    const modsUp = [...modifiers].reverse().map((m) => keyItem(MOD[m], 0, MOD[m] === 0x5b ? 3 : 2));
    try {
      checked();
      if (action.type === "type") {
        for (const char of action.text) {
          checked();
          const items = [];
          for (let i = 0; i < char.length; i += 1) { items.push(keyItem(0, char.charCodeAt(i), 4), keyItem(0, char.charCodeAt(i), 6)); }
          injectBatch(items);
          await sleep(4);
        }
      } else if (action.type === "key") {
        if (blockedChord(action.key, modifiers)) fail("unsupported_action", "System-wide shortcuts are unavailable.");
        const vk = vkOf(action.key);
        if (!vk) fail("unsupported_action", "This key is not available on Windows.");
        const ext = EXTENDED.has(vk) ? 1 : 0;
        // One batch: down/up pairs can never be left half sent.
        injectBatch([...modsDown, keyItem(vk, 0, ext), keyItem(vk, 0, ext | 2), ...modsUp]);
      } else if (action.type === "move") {
        injectBatch([moveTo(action.x, action.y)]);
      } else if (["click", "double_click", "right_click"].includes(action.type)) {
        injectBatch([moveTo(action.x, action.y)]);
        await sleep(15);
        checked();
        const [down, up] = action.type === "right_click" ? [8, 0x10] : [2, 4];
        const clicks = action.type === "double_click" ? 2 : 1;
        const items = [...modsDown];
        for (let i = 0; i < clicks; i += 1) items.push(mouseItem(down), mouseItem(up));
        items.push(...modsUp);
        injectBatch(items);
      } else if (action.type === "scroll") {
        injectBatch([moveTo(action.x, action.y)]);
        await sleep(30);
        checked();
        injectBatch([...modsDown, mouseItem(action.axis === "horizontal" ? 0x1000 : 0x800, action.delta * (action.axis === "horizontal" ? 120 : -120)), ...modsUp]);
      } else if (action.type === "drag") {
        injectBatch([moveTo(action.path[0].x, action.path[0].y)]);
        await sleep(20);
        checked();
        for (const m of modifiers) downKeys.add(MOD[m]);
        downButtons.add(1); setHeld([...downKeys], [...downButtons]);
        injectBatch([...modsDown, mouseItem(2)]);
        for (const p of action.path.slice(1)) { await sleep(16); checked(); injectBatch([moveTo(p.x, p.y)]); }
        await sleep(16);
        injectBatch([mouseItem(4), ...modsUp]);
        downButtons.clear(); downKeys.clear(); setHeld([], []);
      } else fail("unsupported_action", "This action is unavailable.");
    } finally { release(); }
  }
  return {
    poll, window, screens, available, release, startMonitoring, stopMonitoring, check, hit, capture, act,
    cursor() { const p = {}; return cursorPos(p) ? { x: p.x, y: p.y } : null; },
    list() { const result = []; const cb = koffi.register((id) => { try { const item = window(id); if (item.title) result.push(item); } catch { /* skip */ } return 1; }, koffi.pointer(enumProto)); try { enumWindows(cb, 0); } finally { koffi.unregister(cb); } return result; },
    focus(expected) { if (window(expected.id).identity !== expected.identity || !focusWindow(expected.id)) fail("focus_changed", "Bring the approved app to the front, then choose Continue."); poll(); },
    releaseHeld({ keys = [], buttons = [] }) { for (const key of keys) downKeys.add(key); for (const b of buttons) downButtons.add(b); release(); },
    close() { release(); stopMonitoring(); },
  };
}

// ---------------------------------------------------------------------- X11

function x11() {
  if (process.env.XDG_SESSION_TYPE === "wayland" || process.env.WAYLAND_DISPLAY) fail("wayland_unavailable", "Computer use on Linux needs an X11 session; Wayland desktops are not supported yet. Sign in to an X11 session.");
  if (!process.env.DISPLAY) fail("desktop_unavailable", "Computer use needs a graphical Linux desktop (DISPLAY is not set).");
  const x = koffi.load("libX11.so.6"), xt = koffi.load("libXtst.so.6"), xi = koffi.load("libXi.so.6");
  const attributes = koffi.struct("CU2_XWindowAttributes", {
    x: "int", y: "int", width: "int", height: "int", border_width: "int", depth: "int", visual: "void *", root: "ulong", class: "int", bit_gravity: "int", win_gravity: "int", backing_store: "int", backing_planes: "ulong", backing_pixel: "ulong", save_under: "int", colormap: "ulong", map_installed: "int", map_state: "int", all_event_masks: "long", your_event_mask: "long", do_not_propagate_mask: "long", override_redirect: "int", screen: "void *",
  });
  const cookieType = koffi.struct("CU2_XGenericEventCookie", { type: "int", serial: "ulong", send_event: "int", display: "void *", extension: "int", evtype: "int", cookie: "uint", data: "void *" });
  const rawType = koffi.struct("CU2_XIRawEvent", { type: "int", serial: "ulong", send_event: "int", display: "void *", extension: "int", evtype: "int", time: "ulong", deviceid: "int", sourceid: "int", detail: "int", flags: "int", valuators: koffi.struct({ mask_len: "int", mask: "void *", values: "void *" }), raw_values: "void *" });
  const deviceType = koffi.struct("CU2_XIDeviceInfo", { deviceid: "int", name: "str", use: "int", attachment: "int", enabled: "int", num_classes: "int", classes: "void *" });
  koffi.struct("CU2_XIEventMask", { deviceid: "int", mask_len: "int", mask: "void *" });
  const display = x.func("void *XOpenDisplay(str name)")(null);
  if (!display) fail("desktop_unavailable", "Could not connect to the X11 desktop.");
  const closeDisplay = x.func("int XCloseDisplay(void *display)");
  const root = x.func("ulong XDefaultRootWindow(void *display)")(display);
  const internAtom = x.func("ulong XInternAtom(void *display, str name, int only)");
  const atoms = new Map();
  const atom = (name) => { if (!atoms.has(name)) atoms.set(name, internAtom(display, name, 0)); return atoms.get(name); };
  const property = x.func("int XGetWindowProperty(void *display, ulong window, ulong property, long offset, long length, int remove, ulong requested, _Out_ ulong *actual, _Out_ int *format, _Out_ ulong *count, _Out_ ulong *remaining, _Out_ void **data)");
  const free = x.func("int XFree(void *data)");
  const getAttributes = x.func("int XGetWindowAttributes(void *display, ulong window, _Out_ CU2_XWindowAttributes *attributes)");
  const translate = x.func("int XTranslateCoordinates(void *display, ulong source, ulong destination, int x, int y, _Out_ int *root_x, _Out_ int *root_y, _Out_ ulong *child)");
  const queryTree = x.func("int XQueryTree(void *display, ulong window, _Out_ ulong *root, _Out_ ulong *parent, _Out_ void **children, _Out_ uint *count)");
  const queryPointer = x.func("int XQueryPointer(void *display, ulong window, _Out_ ulong *root, _Out_ ulong *child, _Out_ int *root_x, _Out_ int *root_y, _Out_ int *win_x, _Out_ int *win_y, _Out_ uint *mask)");
  const sync = x.func("int XSync(void *display, int discard)");
  const setError = x.func("void *XSetErrorHandler(void *callback)");
  const errorProto = koffi.proto("int CU2_XErrorHandler(void *display, void *event)");
  let xError = false;
  const errorCallback = koffi.register(() => { xError = true; return 0; }, koffi.pointer(errorProto));
  setError(errorCallback);
  const pending = x.func("int XPending(void *display)"), nextEvent = x.func("int XNextEvent(void *display, void *event)");
  const eventData = x.func("int XGetEventData(void *display, _Inout_ CU2_XGenericEventCookie *cookie)");
  const freeEventData = x.func("void XFreeEventData(void *display, CU2_XGenericEventCookie *cookie)");
  const queryDevices = xi.func("CU2_XIDeviceInfo *XIQueryDevice(void *display, int deviceid, _Out_ int *count)");
  const freeDevices = xi.func("void XIFreeDeviceInfo(CU2_XIDeviceInfo *devices)");
  const selectEvents = xi.func("int XISelectEvents(void *display, ulong window, CU2_XIEventMask *masks, int count)");
  const major = [2], minor = [0];
  if (xi.func("int XIQueryVersion(void *display, _Inout_ int *major, _Inout_ int *minor)")(display, major, minor) !== 0) fail("input_unavailable", "XInput2 is required to notice your input.");
  const testDevices = new Set();
  const refreshDevices = () => { const count = [0], ptr = queryDevices(display, 0, count); testDevices.clear(); if (ptr) { for (const d of koffi.decode(ptr, deviceType, count[0])) if (d.name.includes("XTEST")) testDevices.add(d.deviceid); freeDevices(ptr); } };
  refreshDevices();
  // XI_HierarchyChanged (11), XI_RawKeyPress/Release (13/14), XI_RawButtonPress/Release (15/16), XI_RawMotion (17) on the root.
  const eventMask = Buffer.alloc(4);
  for (const type of [11, 13, 14, 15, 16, 17]) eventMask[type >> 3] |= 1 << (type & 7);
  if (selectEvents(display, root, [{ deviceid: 0, mask_len: eventMask.length, mask: eventMask }], 1) !== 0) fail("input_unavailable", "X11 input monitoring could not start.");
  sync(display, 0);
  let injecting = false, interrupting = false;
  const poll = () => {
    while (pending(display)) {
      const event = Buffer.alloc(192); nextEvent(display, event);
      const cookie = koffi.decode(event, cookieType);
      if (cookie.type !== 35 || !eventData(display, cookie)) continue;
      try {
        if (cookie.evtype === 11) refreshDevices();
        else if ([13, 14, 15, 16, 17].includes(cookie.evtype)) {
          const raw = koffi.decode(cookie.data, rawType);
          const ours = injecting && testDevices.has(raw.sourceid);
          if (ours) continue;
          if (cookie.evtype === 13 || cookie.evtype === 15) Object.assign(lastInput, { synthetic: testDevices.has(raw.sourceid), at: Date.now(), kind: cookie.evtype === 13 ? "key" : "pointer" });
          if (interrupting) changed();
        }
      } finally { freeEventData(display, cookie); }
    }
  };
  function prop(id, name, type = 0) {
    const actual = [0], format = [0], count = [0], remaining = [0], data = [null];
    xError = false;
    if (property(display, id, atom(name), 0, 4096, 0, type, actual, format, count, remaining, data) !== 0 || !data[0] || xError) return [];
    try {
      if (format[0] === 32) return Array.from(koffi.decode(data[0], "ulong", Math.min(count[0], 4096)), Number);
      if (format[0] === 8) return Buffer.from(koffi.decode(data[0], "uint8_t", Math.min(count[0], 16384))).toString("utf8");
      return [];
    } finally { free(data[0]); }
  }
  const tree = (id) => {
    const parent = [0], parentRoot = [0], data = [null], count = [0];
    if (!queryTree(display, id, parentRoot, parent, data, count)) return { parent: 0, children: [] };
    try { return { parent: Number(parent[0]), children: data[0] ? Array.from(koffi.decode(data[0], "ulong", Math.min(count[0], 4096)), Number) : [] }; }
    finally { if (data[0]) free(data[0]); }
  };
  const isAncestorOrSelf = (id, target) => { for (let i = 0; id && i < 32; i += 1) { if (Number(id) === target) return true; id = tree(id).parent; } return false; };
  const rootSize = () => { const a = {}; getAttributes(display, root, a); return { width: a.width, height: a.height }; };
  function window(id) {
    const box = {};
    xError = false;
    if (!getAttributes(display, id, box) || xError || box.map_state !== 2 || box.width <= 0 || box.height <= 0) fail("window_unavailable", "Keep the approved app visible on your desktop.");
    const pid = prop(id, "_NET_WM_PID")[0];
    let executable, identity;
    try {
      executable = readlinkSync(`/proc/${pid}/exe`);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      identity = `${pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
    } catch { fail("window_unavailable", "The app identity could not be verified."); }
    const xRoot = [0], yRoot = [0], child = [0];
    if (!translate(display, id, root, 0, 0, xRoot, yRoot, child)) fail("window_unavailable", "Could not read the window position.");
    const title = prop(id, "_NET_WM_NAME", atom("UTF8_STRING"));
    const fallback = typeof title === "string" && title ? title : prop(id, "WM_NAME");
    const wmClass = prop(id, "WM_CLASS");
    const className = typeof wmClass === "string" ? wmClass.split("\0").filter(Boolean).at(-1) : null;
    return { id: Number(id), pid: Number(pid), executable, identity, appId: executable, appName: className || path.basename(executable), title: typeof fallback === "string" ? fallback.replaceAll("\0", "") : "", bounds: { x: xRoot[0], y: yRoot[0], width: box.width, height: box.height }, dpi: 96, scale: 1, monitor: "0" };
  }
  const currentFocus = () => { const focused = [0], revert = [0]; x.func("int XGetInputFocus(void *display, _Out_ ulong *focus, _Out_ int *revert)")(display, focused, revert); return Number(focused[0]); };
  const activeWindow = () => Number(prop(root, "_NET_ACTIVE_WINDOW")[0] ?? 0);
  function check(expected, expectedGeneration, deadline) {
    if (Date.now() >= deadline) fail("session_expired", "The approved session expired. Start a new session.");
    poll();
    if (generation !== expectedGeneration) fail("paused_by_person", "Your input paused computer use. Choose Continue when ready.");
    const current = window(expected.id);
    if (current.identity !== expected.identity || JSON.stringify(current.bounds) !== JSON.stringify(expected.bounds)) fail("window_changed", "The approved window moved or changed. Observe it again.");
    if (!isAncestorOrSelf(currentFocus(), expected.id) && activeWindow() !== expected.id) fail("focus_changed", "The approved window must stay in front. Choose Continue when ready.");
    return current;
  }
  // The window chain under a root point, top-level first (what a click there would hit).
  function chainAt(px, py) {
    const chain = [];
    let parent = root;
    for (let i = 0; i < 32; i += 1) {
      const rx = [0], ry = [0], child = [0];
      if (!translate(display, root, parent, px, py, rx, ry, child) || !child[0]) break;
      parent = Number(child[0]);
      chain.push(parent);
    }
    return chain;
  }
  const hit = (expected, p) => chainAt(p.x, p.y).includes(expected.id) || chainAt(p.x, p.y).some((id) => isAncestorOrSelf(expected.id, id) && tree(id).children.length === 0);
  // Capture the window's own off-screen pixmap (XComposite): never another window covering it.
  const composite = koffi.load("libXcomposite.so.1");
  const compositeMajor = [0], compositeMinor = [0];
  if (!composite.func("int XCompositeQueryVersion(void *display, _Out_ int *major, _Out_ int *minor)")(display, compositeMajor, compositeMinor) || (compositeMajor[0] === 0 && compositeMinor[0] < 2)) fail("capture_unavailable", "X11 Composite window capture is required.");
  const redirect = composite.func("void XCompositeRedirectWindow(void *display, ulong window, int update)");
  const unredirect = composite.func("void XCompositeUnredirectWindow(void *display, ulong window, int update)");
  const namePixmap = composite.func("ulong XCompositeNameWindowPixmap(void *display, ulong window)");
  const imageType = koffi.struct("CU2_XImage", { width: "int", height: "int", xoffset: "int", format: "int", data: "void *", byte_order: "int", bitmap_unit: "int", bitmap_bit_order: "int", bitmap_pad: "int", depth: "int", bytes_per_line: "int", bits_per_pixel: "int", red_mask: "ulong", green_mask: "ulong", blue_mask: "ulong", obdata: "void *", functions: koffi.struct({ create_image: "void *", destroy_image: "void *", get_pixel: "void *", put_pixel: "void *", sub_image: "void *", add_pixel: "void *" }) });
  const visualType = koffi.struct("CU2_XVisual", { ext_data: "void *", visualid: "ulong", class: "int", red_mask: "ulong", green_mask: "ulong", blue_mask: "ulong", bits_per_rgb: "int", map_entries: "int" });
  const getImage = x.func("CU2_XImage *XGetImage(void *display, ulong drawable, int x, int y, uint width, uint height, ulong planes, int format)");
  const destroyImage = x.func("int XDestroyImage(CU2_XImage *image)");
  const freePixmap = x.func("int XFreePixmap(void *display, ulong pixmap)");
  const redirected = new Set();
  const clearCapture = () => { for (const id of redirected) unredirect(display, id, 0); redirected.clear(); sync(display, 0); };
  // Pixels of `drawable` (x, y, width, height) as RGBA, in the color format of `visualOf`.
  function readImage(drawable, visualOf, px, py, width, height) {
    let ptr;
    try {
      ptr = getImage(display, drawable, px, py, width, height, ~0n, 2);
      if (!ptr) fail("capture_unavailable", "The window image is unavailable. Keep it visible and observe again.");
      const value = koffi.decode(ptr, imageType), bytes = value.bits_per_pixel / 8;
      const a = {};
      if (!getAttributes(display, visualOf, a) || !a.visual) fail("capture_unavailable", "The window color format is unavailable.");
      const visual = koffi.decode(a.visual, visualType);
      if (![2, 3, 4].includes(bytes) || value.width !== width || value.height !== height || value.bytes_per_line < value.width * bytes || value.bytes_per_line * value.height > 134_217_728 || ![0, 1].includes(value.byte_order) || visual.class !== 4 || !visual.red_mask || !visual.green_mask || !visual.blue_mask) fail("capture_unavailable", "This X11 image format is unavailable.");
      const source = Buffer.from(koffi.decode(value.data, "uint8_t", value.bytes_per_line * value.height));
      const data = Buffer.alloc(width * height * 4);
      const channels = [visual.red_mask, visual.green_mask, visual.blue_mask].map((mask) => { const m = Number(mask) >>> 0; const shift = Math.log2((m & -m) >>> 0); return { mask: m, shift, max: m >>> shift }; });
      for (let y = 0; y < height; y += 1) for (let column = 0; column < width; column += 1) {
        const offset = y * value.bytes_per_line + column * bytes;
        const pixel = value.byte_order === 0 ? source.readUIntLE(offset, bytes) : source.readUIntBE(offset, bytes);
        const o = (y * width + column) * 4;
        for (let i = 0; i < 3; i += 1) { const c = channels[i]; data[o + i] = Math.round((((pixel & c.mask) >>> c.shift) * 255) / c.max); }
        data[o + 3] = 255;
      }
      return { width, height, data };
    } finally { if (ptr) destroyImage(ptr); }
  }
  const topLevelOf = (id) => { let current = id; for (let i = 0; i < 32; i += 1) { const parent = tree(current).parent; if (!parent || parent === Number(root)) return current; current = parent; } return current; };
  const pidUnder = (id) => { const own = prop(id, "_NET_WM_PID")[0]; if (own) return Number(own); for (const child of tree(id).children.slice(0, 8)) { const p = prop(child, "_NET_WM_PID")[0]; if (p) return Number(p); } return 0; };
  // True when nothing but the approved app (its own menus and popups) is drawn over its window.
  function unobstructed(current) {
    const top = topLevelOf(current.id);
    const stack = tree(root).children;
    const index = stack.indexOf(top);
    if (index < 0) return false;
    const b = current.bounds;
    for (const id of stack.slice(index + 1)) {
      const a = {};
      xError = false;
      if (!getAttributes(display, id, a) || xError || a.map_state !== 2) continue;
      const ox = [0], oy = [0], child = [0];
      if (!translate(display, id, root, 0, 0, ox, oy, child)) continue;
      if (ox[0] >= b.x + b.width || oy[0] >= b.y + b.height || ox[0] + a.width <= b.x || oy[0] + a.height <= b.y) continue;
      const pid = pidUnder(id);
      if (pid === current.pid) continue;
      if (a.override_redirect && !pid) continue;
      return false;
    }
    return true;
  }
  async function capture(expected) {
    const current = window(expected.id);
    if (current.identity !== expected.identity) fail("window_changed", "The window changed. Observe again.");
    if (current.bounds.width * current.bounds.height > 33_177_600) fail("capture_unavailable", "This window is too large to capture. Resize it and observe again.");
    const size = rootSize(), b = current.bounds;
    const onScreen = b.x >= 0 && b.y >= 0 && b.x + b.width <= size.width && b.y + b.height <= size.height;
    // Unobstructed: the screen region, so the app's own menus and popups are in the image.
    if (onScreen && unobstructed(current)) return { ...readImage(root, root, b.x, b.y, b.width, b.height), secure: [], caret: null, source: "screen" };
    // Otherwise the window's own off-screen pixmap: never another app covering it.
    if (!redirected.has(current.id)) {
      xError = false; redirect(display, current.id, 0); sync(display, 0);
      if (xError) fail("capture_unavailable", "The approved window cannot be captured separately.");
      redirected.add(current.id);
      await sleep(50);
    }
    xError = false;
    const pixmap = namePixmap(display, current.id); sync(display, 0);
    if (xError || !pixmap) fail("capture_unavailable", "The approved window cannot be captured separately.");
    try { return { ...readImage(pixmap, current.id, 0, 0, b.width, b.height), secure: [], caret: null, source: "window" }; }
    finally { freePixmap(display, pixmap); }
  }
  const rawKey = xt.func("int XTestFakeKeyEvent(void *display, uint key, int down, ulong delay)");
  const rawButton = xt.func("int XTestFakeButtonEvent(void *display, uint button, int down, ulong delay)");
  const rawMotion = xt.func("int XTestFakeMotionEvent(void *display, int screen, int x, int y, ulong delay)");
  const inject = (fn, args, guard = true) => {
    const previous = generation; poll();
    if (guard && previous !== generation) fail("paused_by_person", "Your input paused computer use. Choose Continue when ready.");
    injecting = true;
    try { const result = fn(...args); sync(display, 0); poll(); return result; }
    finally { injecting = false; }
  };
  const keysymOf = x.func("ulong XStringToKeysym(str name)"), keycodeOf = x.func("uint8_t XKeysymToKeycode(void *display, ulong symbol)");
  const symbolAt = x.func("ulong XKeycodeToKeysym(void *display, uint8_t code, int index)");
  const displayKeycodes = x.func("int XDisplayKeycodes(void *display, _Out_ int *min, _Out_ int *max)");
  const getMapping = x.func("void *XGetKeyboardMapping(void *display, uint8_t first, int count, _Out_ int *per)");
  const changeMapping = x.func("int XChangeKeyboardMapping(void *display, int first, int per, ulong *symbols, int count)");
  const downKeys = new Set();
  const downButtons = new Set();
  const release = () => {
    for (const code of downKeys) { try { inject(rawKey, [display, code, 0, 0], false); } catch { /* best effort */ } }
    for (const button of downButtons) { try { inject(rawButton, [display, button, 0, 0], false); } catch { /* best effort */ } }
    downKeys.clear(); downButtons.clear(); sync(display, 0); setHeld([], []);
  };
  // A keycode with no symbols, borrowed to type characters the layout lacks.
  let spare = null;
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
  const press = (code, down) => {
    if (down) downKeys.add(code); else downKeys.delete(code);
    if (!inject(rawKey, [display, code, down ? 1 : 0, 0])) fail("input_unavailable", "X11 rejected keyboard input.");
  };
  const MOD = { ctrl: "Control_L", shift: "Shift_L", alt: "Alt_L", meta: "Super_L" };
  const NAMES = { Enter: "Return", Tab: "Tab", Escape: "Escape", Backspace: "BackSpace", Delete: "Delete", Insert: "Insert", Space: "space", Left: "Left", Up: "Up", Right: "Right", Down: "Down", Home: "Home", End: "End", PageUp: "Prior", PageDown: "Next", CapsLock: "Caps_Lock", ContextMenu: "Menu", PrintScreen: "Print" };
  const symbolOfKey = (key) => {
    if (NAMES[key]) return Number(keysymOf(NAMES[key]));
    if (/^F\d+$/.test(key)) return Number(keysymOf(key));
    return key.codePointAt(0);
  };
  // Types one symbol: its own key (with Shift when it sits on level 2), or the spare keycode remapped to it.
  async function typeSymbol(symbol) {
    const code = keycodeOf(display, symbol);
    const level0 = code ? Number(symbolAt(display, code, 0)) : 0, level1 = code ? Number(symbolAt(display, code, 1)) : 0;
    if (code && (level0 === symbol || level1 === symbol)) {
      const shifted = level1 === symbol && level0 !== symbol;
      const shift = keycodeOf(display, Number(keysymOf("Shift_L")));
      if (shifted) press(shift, true);
      press(code, true); press(code, false);
      if (shifted) press(shift, false);
      return;
    }
    const borrowed = spareCode();
    if (!borrowed) fail("unsupported_action", "This character cannot be typed with the active keyboard layout.");
    remap(borrowed, symbol);
    await sleep(12);
    try { press(borrowed, true); press(borrowed, false); await sleep(8); }
    finally { remap(borrowed, 0); }
  }
  const moveTo = (px, py) => inject(rawMotion, [display, -1, px, py, 0]);
  async function act(expected, expectedGeneration, action, deadline) {
    const checked = () => check(expected, expectedGeneration, deadline);
    const modifiers = action.modifiers ?? [];
    const modCodes = modifiers.map((m) => keycodeOf(display, Number(keysymOf(MOD[m]))));
    const holdMods = () => { for (const code of modCodes) press(code, true); };
    const releaseMods = () => { for (const code of [...modCodes].reverse()) press(code, false); };
    try {
      checked();
      if (action.type === "type") {
        for (const char of action.text) {
          checked();
          const cp = char.codePointAt(0);
          const symbol = char === "\n" ? Number(keysymOf("Return")) : char === "\t" ? Number(keysymOf("Tab")) : cp <= 0xff ? cp : 0x01000000 + cp;
          await typeSymbol(symbol);
          await sleep(3);
        }
      } else if (action.type === "key") {
        if (blockedChord(action.key, modifiers)) fail("unsupported_action", "System-wide shortcuts are unavailable.");
        const symbol = symbolOfKey(action.key);
        const code = symbol ? keycodeOf(display, symbol) : 0;
        if (!code) fail("unsupported_action", "This key is not available in the active keyboard layout.");
        const shifted = !modifiers.includes("shift") && Number(symbolAt(display, code, 1)) === symbol && Number(symbolAt(display, code, 0)) !== symbol;
        const shift = keycodeOf(display, Number(keysymOf("Shift_L")));
        holdMods(); if (shifted) press(shift, true);
        press(code, true); press(code, false);
        if (shifted) press(shift, false); releaseMods();
      } else if (action.type === "move") {
        moveTo(action.x, action.y);
      } else if (["click", "double_click", "right_click"].includes(action.type)) {
        moveTo(action.x, action.y);
        await sleep(15);
        checked();
        const button = action.type === "right_click" ? 3 : 1;
        holdMods();
        for (let i = 0; i < (action.type === "double_click" ? 2 : 1); i += 1) {
          downButtons.add(button); inject(rawButton, [display, button, 1, 0]); inject(rawButton, [display, button, 0, 0]); downButtons.delete(button);
          if (i === 0 && action.type === "double_click") await sleep(60);
        }
        releaseMods();
      } else if (action.type === "scroll") {
        moveTo(action.x, action.y);
        await sleep(30);
        const button = action.axis === "horizontal" ? (action.delta > 0 ? 7 : 6) : action.delta > 0 ? 5 : 4;
        holdMods();
        for (let i = 0; i < Math.abs(action.delta); i += 1) {
          checked();
          downButtons.add(button); inject(rawButton, [display, button, 1, 0]); await sleep(8); inject(rawButton, [display, button, 0, 0]); downButtons.delete(button);
          await sleep(12);
        }
        releaseMods();
      } else if (action.type === "drag") {
        moveTo(action.path[0].x, action.path[0].y);
        await sleep(20);
        checked();
        holdMods();
        downButtons.add(1); setHeld([...downKeys], [...downButtons]);
        inject(rawButton, [display, 1, 1, 0]);
        for (const p of action.path.slice(1)) { await sleep(16); checked(); moveTo(p.x, p.y); }
        await sleep(16);
        inject(rawButton, [display, 1, 0, 0]); downButtons.delete(1);
        releaseMods(); setHeld([], []);
      } else fail("unsupported_action", "This action is unavailable.");
    } finally { release(); }
  }
  return {
    poll, window, release, check, hit, capture, clearCapture, act, available: () => true,
    startMonitoring(interrupt = true) { interrupting = interrupt || interrupting; },
    stopMonitoring() { interrupting = false; },
    screens() { const s = rootSize(); return [{ id: "0", x: 0, y: 0, width: s.width, height: s.height, scale: 1, primary: true }]; },
    cursor() { const r = [0], c = [0], rx = [0], ry = [0], wx = [0], wy = [0], m = [0]; return queryPointer(display, root, r, c, rx, ry, wx, wy, m) ? { x: rx[0], y: ry[0] } : null; },
    list() { const ids = prop(root, "_NET_CLIENT_LIST_STACKING"); const result = []; for (const id of Array.isArray(ids) && ids.length ? ids : tree(root).children) { try { result.push(window(id)); } catch { /* skip */ } } return result; },
    focus(expected) {
      if (window(expected.id).identity !== expected.identity) fail("window_unavailable", "The approved app has closed.");
      x.func("int XRaiseWindow(void *display, ulong window)")(display, expected.id);
      x.func("int XSetInputFocus(void *display, ulong window, int revert, ulong time)")(display, expected.id, 2, 0);
      sync(display, 0); poll();
    },
    releaseHeld({ keys = [], buttons = [] }) { for (const k of keys) downKeys.add(k); for (const b of buttons) downButtons.add(b); release(); },
    close() { release(); clearCapture(); closeDisplay(display); setError(null); koffi.unregister(errorCallback); },
  };
}

// ------------------------------------------------------------------ process

const releaseOnly = process.argv.indexOf("--release");
if (releaseOnly >= 0) {
  // `node native-worker.mjs --release '{"keys":[..],"buttons":[..]}'`: the parent's
  // stuck-input release after a worker exited with input held.
  try {
    const value = JSON.parse(process.argv[releaseOnly + 1] ?? "{}");
    const b = process.platform === "win32" ? windows() : x11();
    b.releaseHeld({ keys: Array.isArray(value.keys) ? value.keys.filter(Number.isInteger) : [], buttons: Array.isArray(value.buttons) ? value.buttons.filter(Number.isInteger) : [] });
    b.close();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

let timer;
const startPolling = () => { if (!timer) timer = setInterval(() => { try { backend?.poll(); } catch { changed(); } }, 10); };
const stopPolling = () => { if (timer) { clearInterval(timer); timer = undefined; } };
if (releaseOnly < 0) {
  try {
    backend = process.platform === "win32" ? windows() : x11();
    if (process.platform !== "win32") startPolling();
    post({ event: "ready", supported: true, platform: process.platform });
  } catch (error) {
    post({ event: "ready", supported: false, code: error.code ?? "native_unavailable", error: error.message });
  }
}

let busy = false;
process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  const { id, method, params = {} } = message;
  let ownsBusy = false;
  try {
    if (method === "shutdown") {
      generation += 1; backend?.release(); backend?.stopMonitoring?.(); stopPolling();
      while (busy) await sleep(10);
      backend?.close(); backend = null;
      post({ id, result: {} }); process.disconnect?.(); return;
    }
    if (!backend) fail("native_unavailable", "Desktop access is unavailable.");
    if (method === "start" || method === "watch") {
      if (busy) fail("busy", "Desktop operations must be sequential.");
      backend.startMonitoring?.(method === "start");
      if (process.platform === "win32") startPolling();
      post({ id, result: { generation } });
      return;
    }
    if (method === "stop") {
      generation += 1;
      backend.release();
      backend.stopMonitoring?.();
      if (process.platform === "win32") stopPolling();
      backend.clearCapture?.();
      post({ id, result: {} });
      return;
    }
    if (method === "input-source") { backend.poll(); post({ id, result: { ...lastInput } }); return; }
    if (busy) fail("busy", "Desktop operations must be sequential.");
    busy = true; ownsBusy = true;
    backend.poll();
    let result;
    if (method === "list") result = backend.list();
    else if (method === "window") result = backend.window(params.id);
    else if (method === "screens") result = backend.screens();
    else if (method === "cursor") result = backend.cursor();
    else if (method === "focus") { backend.focus(params.window); result = { generation }; }
    else if (method === "state") result = { generation, available: backend.available() };
    else if (method === "capture") result = await backend.capture(params.window);
    else if (method === "check") { backend.check(params.window, params.generation, params.deadline); result = {}; }
    else if (method === "hit") result = { inside: (params.points ?? []).map((p) => backend.hit(params.window, p)) };
    else if (method === "act") { await backend.act(params.window, params.generation, params.action, params.deadline); result = { generation }; }
    else fail("unknown_method", "Unknown native operation.");
    post({ id, result });
  } catch (error) {
    post({ id, error: { code: error.code ?? "native_error", message: error.message } });
  } finally { if (ownsBusy) busy = false; }
});
process.on("disconnect", () => { stopPolling(); try { backend?.close(); } catch { /* exiting */ } });
