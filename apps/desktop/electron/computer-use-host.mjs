// macOS computer use host (contract v2). The tool surface, validation,
// results, per-action approvals, `computer.session` events, media spool and
// MCP transport are the shared portable host's
// (apps/server/src/computer-use/shared/portable-host.mjs), exactly as on
// Windows and Linux; the signed Swift helper (`ComputerUse worker`,
// packages/computer-use/native NativeWorker.swift) is its native layer:
// window list, capture (with password-field boxes and on-device text
// recognition), hit testing, window-targeted input and person-input pauses.
//
// createComputerUseHost() returns the same interface as createPortableHost()
// (availability, os, connect, listen(dir) → { discoveryPath, close }, control,
// stopAll, syntheticInput, watchInput, state, close) and calls the same
// callbacks (approve.open / approve.act, onEvent, onState, onFrame), so
// Electron main treats both hosts alike. The engine reaches it through the
// bundled relay with the discovery file, as on the other platforms.
import { spawn } from "node:child_process";

const SHARED = new URL("../../server/src/computer-use/shared/", import.meta.url);
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const MAX_LINE = 1_048_576;
const MAX_FRAME = 7680 * 7680 * 4;

/** Boxes (capture pixels) of recognized text that looks like a credential: the matching words, else the whole line. */
export function credentialBoxes(lines, looksLikeCredential) {
  const boxes = [];
  const box = (b) => (record(b) && [b.x, b.y, b.width, b.height].every(Number.isFinite) ? { x: b.x - 2, y: b.y - 2, width: b.width + 4, height: b.height + 4 } : null);
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!record(line) || typeof line.text !== "string") continue;
    const words = (Array.isArray(line.words) ? line.words : []).filter((w) => record(w) && typeof w.text === "string");
    const hits = words.filter((w) => looksLikeCredential(w.text));
    // `password: hunter22` matches as a line but not word by word: the words after the label go too.
    const pairs = words.slice(1).filter((w, i) => !hits.includes(w) && looksLikeCredential(`${words[i].text} ${w.text}`));
    const picked = [...hits, ...pairs].map((w) => box(w.box)).filter(Boolean);
    if (picked.length) boxes.push(...picked);
    else if (looksLikeCredential(line.text)) { const b = box(line.box); if (b) boxes.push(b); }
  }
  return boxes;
}

/**
 * The native worker over the Swift helper's stdio (the NativeWorker interface
 * of portable-host.d.mts). `captureLongSide()` caps capture size (the
 * full_long_side limit); `looksLikeCredential` (policy.mjs) picks the
 * recognized words that are painted over.
 */
export function createMacNativeWorker({ executable, args = ["worker"], captureLongSide = () => 3840, looksLikeCredential = () => false, paintBoxes = null, timeoutMs = 10_000 }) {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  const listeners = new Set();
  let nextId = 0, closed = false, held = { keys: [], buttons: [] }, release = null, lastOcr = "none";
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const readyTimer = setTimeout(() => readyResolve({ supported: false, code: "native_unavailable", error: "Desktop access did not start. Restart the app." }), timeoutMs);

  const deliver = (value) => {
    if (!record(value)) return;
    if (value.event === "ready") { clearTimeout(readyTimer); readyResolve({ supported: value.supported === true, platform: "darwin", ...(value.code ? { code: value.code } : {}), ...(value.error ? { error: value.error } : {}) }); return; }
    if (value.event === "held") { held = { keys: value.keys ?? [], buttons: value.buttons ?? [] }; release = record(value.release) ? value.release : null; return; }
    if (value.event) { for (const listener of listeners) listener(value); return; }
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id); clearTimeout(request.timer);
    if (record(value.error)) request.reject(Object.assign(new Error(String(value.error.message)), { code: value.error.code }));
    else request.resolve(value.result);
  };

  // JSON lines; a header with result.bytes is followed by that many raw bytes.
  let line = [], lineBytes = 0, binary = null;
  child.stdout.on("data", (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (binary) {
        const take = Math.min(binary.need - binary.have, chunk.length - offset);
        binary.parts.push(chunk.subarray(offset, offset + take));
        binary.have += take; offset += take;
        if (binary.have === binary.need) { const { message, parts, need } = binary; binary = null; message.result.data = Buffer.concat(parts, need); deliver(message); }
        continue;
      }
      const end = chunk.indexOf(10, offset);
      if (end < 0) {
        line.push(chunk.subarray(offset)); lineBytes += chunk.length - offset;
        if (lineBytes > MAX_LINE) child.kill();
        return;
      }
      line.push(chunk.subarray(offset, end));
      const text = Buffer.concat(line).toString("utf8");
      line = []; lineBytes = 0; offset = end + 1;
      let message;
      try { message = JSON.parse(text); } catch { continue; }
      const bytes = message?.result?.bytes;
      if (record(message?.result) && Number.isSafeInteger(bytes)) {
        if (bytes < 0 || bytes > MAX_FRAME) { child.kill(); return; }
        delete message.result.bytes;
        if (bytes === 0) { message.result.data = Buffer.alloc(0); deliver(message); }
        else binary = { message, need: bytes, have: 0, parts: [] };
        continue;
      }
      deliver(message);
    }
  });

  const fail = (error) => {
    if (closed) return;
    clearTimeout(readyTimer); readyResolve({ supported: false, code: "native_unavailable", error: error.message });
    closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    if (held.buttons.length && release) {
      // The helper died with a button pressed: lift it from a fresh one.
      const releaser = spawn(executable, ["release", JSON.stringify(release)], { stdio: "ignore" });
      releaser.on("error", () => {});
      held = { keys: [], buttons: [] }; release = null;
    }
    for (const listener of listeners) listener({ event: "unavailable" });
  };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("Desktop access stopped. Restart the app.")));
  child.stdin.on("error", () => {});

  const raw = (method, params = {}, ms = timeoutMs) => {
    if (closed) return Promise.reject(Object.assign(new Error("Desktop access has stopped."), { code: "native_unavailable" }));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error("Desktop operation timed out."), { code: "timeout" })); }, ms);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };

  return {
    ready,
    pid: child.pid,
    get held() { return held; },
    /** Whether on-device text recognition ran on the latest capture ("client" | "none"). */
    get ocr() { return lastOcr; },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async call(method, params = {}, ms = timeoutMs) {
      if (method !== "capture") return raw(method, params, ms);
      const frame = await raw(method, { ...params, max_long_side: captureLongSide() }, ms);
      if (!record(frame) || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || !Buffer.isBuffer(frame.data) || frame.data.length !== frame.width * frame.height * 4) {
        throw Object.assign(new Error("The window image could not be read."), { code: "capture_unavailable" });
      }
      // Password fields (accessibility) plus recognized text that looks like a credential: painted on both copies.
      const text = credentialBoxes(frame.text_boxes, looksLikeCredential);
      lastOcr = frame.ocr === "client" ? "client" : "none";
      const secure = [...(Array.isArray(frame.secure) ? frame.secure : []), ...text];
      // Painted here on every capture (the host paints the same boxes again, which changes nothing), so
      // the host's stale check compares a masked observation with a masked fresh capture.
      paintBoxes?.(frame, secure);
      // The recognized lines (boxes + text) for the host's per-act rules (risky targets); never sent to the model.
      const texts = Array.isArray(frame.text_boxes) ? frame.text_boxes.filter((l) => record(l) && typeof l.text === "string" && record(l.box)).map((l) => ({ x: l.box.x, y: l.box.y, width: l.box.width, height: l.box.height, text: l.text })) : null;
      return { width: frame.width, height: frame.height, data: frame.data, secure, secure_fields: Array.isArray(frame.secure) ? frame.secure : [], ...(frame.ocr === "client" && texts ? { texts } : {}), caret: frame.caret ?? null, ocr: frame.ocr === "client" ? "client" : "none", credential_boxes: text.length, source: frame.source };
    },
    kill() { child.kill(); },
    async close() { if (closed) return; await raw("shutdown", {}, 3000).catch(() => {}); closed = true; if (child.exitCode === null) child.kill(); },
  };
}

/**
 * The macOS host. Options as createPortableHost's (spool, settings, context, refresh,
 * approve, onEvent, onState, onFrame) plus `executable`, the helper binary
 * (OmniRush.ai Computer Use.app/Contents/MacOS/ComputerUse). `shared` may
 * supply the shared modules ({ portable, policy, contract, image }) when they are
 * bundled elsewhere.
 */
export async function createComputerUseHost({ executable, spool = null, settings, context, refresh = null, approve, onEvent, onState, onFrame, shared = /** @type {{ portable?: any, policy?: any, contract?: any, image?: any }} */ ({}) }) {
  if (!executable) throw new Error("Computer Use helper unavailable.");
  const portable = shared.portable ?? await import(new URL("portable-host.mjs", SHARED).href);
  const policy = shared.policy ?? await import(new URL("policy.mjs", SHARED).href);
  const contract = shared.contract ?? await import(new URL("contract.mjs", SHARED).href);
  const image = shared.image ?? await import(new URL("image.mjs", SHARED).href);
  const native = createMacNativeWorker({
    executable,
    captureLongSide: () => contract.normalizeLimits(settings?.()?.limits).full_long_side,
    looksLikeCredential: policy.looksLikeCredential,
    paintBoxes: image.paintBoxes,
  });
  // The archive copy records that the frame was read on the device (text recognition ran).
  const ocrSpool = spool ? Object.create(spool, { put: { value: (frame) => spool.put({ ...frame, ocr: native.ocr }) } }) : null;
  const host = await portable.createPortableHost({ native, spool: ocrSpool, settings, context, refresh, approve, onEvent, onState, onFrame, platform: "darwin" });
  return { ...host, executable };
}
