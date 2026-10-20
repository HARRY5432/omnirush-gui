// Shared computer-use media references and image codecs (computer-use/shared/).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { compareGrids, decodePng, encodeJpeg, encodePng, fitLongSide, imageInfo, luminanceGrid, paintBoxes, resize } from "./shared/image.mjs";
import {
  createMediaIndex,
  createMediaSpool,
  MEDIA_ROOT,
  mediaRefsOf,
  parseImageDataUrl,
  parseMediaUrl,
  pruneImages,
  rewriteMessageMedia,
  sha256,
  THUMBS_PER_MESSAGE_BYTES,
} from "./shared/media.mjs";

const dirs: string[] = [];
function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cu-media-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function frame(width: number, height: number, seed: number) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const o = (y * width + x) * 4;
    data[o] = (x * 7 + seed * 13) & 255; data[o + 1] = (y * 5 + seed * 3) & 255; data[o + 2] = (seed * 31) & 255; data[o + 3] = 255;
  }
  data[0] = seed & 255;
  data[1] = (seed >> 8) & 255;
  return { width, height, data };
}

const dataUrl = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

function toolPart(id: string, urls: string[]) {
  return { id, type: "tool", tool: "computer-use_computer_act", callID: `call_${id}`, state: { status: "completed", input: {}, output: "{\"ok\":true}", attachments: urls.map((url, i) => ({ type: "file", mime: url.slice(5, url.indexOf(";")), url, filename: `shot-${i}` })), time: { start: 1, end: 2 } } };
}

describe("image codecs", () => {
  test("PNG round trip, JPEG encode, sniffing, resize", () => {
    const img = frame(333, 211, 1);
    const png = encodePng(img);
    expect(imageInfo(png)).toEqual({ mime: "image/png", width: 333, height: 211 });
    const back = decodePng(png);
    expect(back && Buffer.from(back.data).equals(Buffer.from(img.data))).toBe(true);
    const jpeg = encodeJpeg(img, { quality: 80 });
    expect(imageInfo(jpeg)).toEqual({ mime: "image/jpeg", width: 333, height: 211 });
    expect(jpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(fitLongSide(frame(2560, 1600, 2), 1280)).toMatchObject({ width: 1280, height: 800 });
    expect(resize(img, 10, 10).data.length).toBe(400);
    expect(decodePng(Buffer.from("not a png"))).toBeNull();
  });

  test("painting boxes and the tolerant compare (caret masked)", () => {
    const a = frame(320, 200, 4);
    const b = { ...a, data: Uint8Array.from(a.data) };
    // A blinking caret: a 2x14 bar.
    paintBoxes(b, [{ x: 100, y: 50, width: 2, height: 14 }], [255, 255, 255]);
    expect(compareGrids(luminanceGrid(a), luminanceGrid(b)).stale).toBe(false);
    expect(compareGrids(luminanceGrid(a), luminanceGrid(b), { mask: [{ x: 96, y: 48, width: 10, height: 20 }] }).changed).toBe(0);
    expect(compareGrids(luminanceGrid(a), luminanceGrid(b)).changed).toBeGreaterThan(0);
    // A dialog opened: a large region changed.
    const c = { ...a, data: Uint8Array.from(a.data) };
    paintBoxes(c, [{ x: 40, y: 40, width: 200, height: 100 }]);
    expect(compareGrids(luminanceGrid(a), luminanceGrid(c)).stale).toBe(true);
    expect(compareGrids(luminanceGrid(a), luminanceGrid(frame(160, 100, 4))).stale).toBe(true);
    // A GTK overlay scrollbar fading in at the right edge: a 3 px strip down the window.
    const wide = frame(660, 220, 6);
    const strip = { ...wide, data: Uint8Array.from(wide.data) };
    paintBoxes(strip, [{ x: 655, y: 29, width: 3, height: 187 }], [120, 120, 120]);
    expect(compareGrids(luminanceGrid(wide), luminanceGrid(strip)).stale).toBe(false);
    // One typed word is a small change too; a cleared text area is not.
    const typed = { ...wide, data: Uint8Array.from(wide.data) };
    // Glyph strokes, not a solid block: a few 2 px lines.
    paintBoxes(typed, [0, 6, 12, 18, 24, 30, 36].map((dx) => ({ x: 4 + dx, y: 30, width: 2, height: 12 })), [0, 0, 0]);
    expect(compareGrids(luminanceGrid(wide), luminanceGrid(typed)).stale).toBe(false);
    const cleared = { ...wide, data: Uint8Array.from(wide.data) };
    paintBoxes(cleared, [{ x: 0, y: 26, width: 660, height: 194 }], [255, 255, 255]);
    expect(compareGrids(luminanceGrid(wide), luminanceGrid(cleared)).stale).toBe(true);
  });
});

describe("media references", () => {
  test("data URLs become refs; first-seen thumb; files once per chat; user file parts untouched", () => {
    const dir = tmp();
    const spool = createMediaSpool(path.join(dir, "spool"));
    const index = createMediaIndex(path.join(dir, "index", "ses_1.json"));
    const png = encodePng(frame(1280, 800, 9));
    const url = dataUrl("image/png", png);
    const message = { info: { id: "msg_1", role: "assistant" }, parts: [toolPart("p1", [url]), { type: "file", mime: "image/png", url, filename: "user.png" }] };
    const before = JSON.stringify(message);
    const out = rewriteMessageMedia(message, { spool, index, limits: {} });
    expect(JSON.stringify(message)).toBe(before);
    expect(out.changed).toBe(true);
    const ref = (out.message.parts[0] as ReturnType<typeof toolPart>).state.attachments[0] as Record<string, unknown>;
    const sha = sha256(png);
    expect(ref).toMatchObject({ type: "file", filename: "shot-0", mime: "image/png", url: `omnirush-media:${sha}.png`, sha256: sha, width: 1280, height: 800, bytes: png.length });
    expect(String(ref.thumb)).toStartWith("data:image/jpeg;base64,");
    const thumb = Buffer.from(String(ref.thumb).split(",")[1] ?? "", "base64");
    expect(imageInfo(thumb)).toMatchObject({ width: 320, height: 200 });
    expect(thumb.length).toBeLessThan(40_000);
    expect((out.message.parts[1] as { url: string }).url).toBe(url);
    expect(out.files).toEqual([{ path: `${MEDIA_ROOT}/${sha}.png`, file: spool.modelPath(sha, "png"), sha, kind: "model", bytes: png.length }]);
    expect(readFileSync(out.files[0]?.file ?? "").equals(png)).toBe(true);
    expect(mediaRefsOf(out.message)).toEqual([{ sha, ext: "png" }]);
    expect(parseMediaUrl(ref.url)).toEqual({ sha, ext: "png" });
    // Seen again (another read, or a resume with a fresh index object): no thumb, no new file.
    const again = rewriteMessageMedia(message, { spool, index: createMediaIndex(path.join(dir, "index", "ses_1.json")), limits: {} });
    const ref2 = (again.message.parts[0] as ReturnType<typeof toolPart>).state.attachments[0] as Record<string, unknown>;
    expect(ref2.thumb).toBeUndefined();
    expect(again.files).toEqual([]);
    // Already rewritten messages pass through.
    expect(rewriteMessageMedia(out.message, { spool, index, limits: {} }).changed).toBe(false);
  });

  test("host frames: full resolution kept only when larger, and its own budget", () => {
    const dir = tmp();
    const spool = createMediaSpool(path.join(dir, "spool"));
    const fullImg = frame(2560, 1600, 3);
    const model = encodeJpeg(fitLongSide(fullImg, 1280), { quality: 80 });
    const fullPng = encodePng(fullImg, { level: 1 });
    const meta = spool.put({ bytes: model, mime: "image/jpeg", full: { bytes: fullPng, width: 2560, height: 1600 }, thumb: encodeJpeg(fitLongSide(fullImg, 320)) });
    expect(meta.full).toMatchObject({ width: 2560, height: 1600, ext: "png", bytes: fullPng.length });
    const small = encodeJpeg(frame(400, 300, 5));
    expect(spool.put({ bytes: small, mime: "image/jpeg", full: { bytes: encodePng(frame(400, 300, 5)), width: 400, height: 300 } }).full).toBeUndefined();
    const message = { parts: [toolPart("a", [dataUrl("image/jpeg", model), dataUrl("image/jpeg", small)])] };
    const out = rewriteMessageMedia(message, { spool, index: createMediaIndex(path.join(dir, "i.json")), limits: { media_full_bytes: 10, media_model_bytes: 200 * 1024 * 1024 } });
    const [a, b] = (out.message.parts[0] as ReturnType<typeof toolPart>).state.attachments as Array<Record<string, unknown>>;
    expect(a?.full).toEqual({ omitted: "budget" });
    expect(b?.full).toBeUndefined();
    expect(out.files.map((f) => f.kind)).toEqual(["model", "model"]);
    const roomy = rewriteMessageMedia(message, { spool, index: createMediaIndex(path.join(dir, "j.json")), limits: {} });
    expect(roomy.files.map((f) => f.kind)).toEqual(["model", "full", "model"]);
    expect(((roomy.message.parts[0] as ReturnType<typeof toolPart>).state.attachments[0] as Record<string, unknown>).full).toMatchObject({ width: 2560 });
    spool.remove(meta.sha256);
    expect(existsSync(spool.modelPath(meta.sha256, "jpg"))).toBe(false);
  });

  test("a 600-frame turn uploads whole: small message, 2 MB of thumbs, every frame archived under the caps", () => {
    const dir = tmp();
    const spool = createMediaSpool(path.join(dir, "spool"));
    const index = createMediaIndex(path.join(dir, "index.json"));
    const parts = [];
    let raw = 0;
    for (let i = 0; i < 600; i += 1) {
      const png = encodePng(frame(160, 100, i), { level: 1 });
      // Pad each frame to ~150 KB (the size of a 1280x800 JPEG) with a private chunk.
      const pad = Buffer.alloc(8 + 150_000 + 4);
      pad.writeUInt32BE(150_000, 0);
      pad.write("paDa", 4, "latin1");
      const padded = Buffer.concat([png.subarray(0, png.length - 12), pad, png.subarray(png.length - 12)]);
      const url = dataUrl("image/png", padded);
      raw += url.length;
      parts.push(toolPart(`p${i}`, [url]));
    }
    const message = { info: { id: "msg_big" }, parts };
    expect(raw).toBeGreaterThan(64 * 1024 * 1024);
    const out = rewriteMessageMedia(message, { spool, index, limits: {} });
    const size = Buffer.byteLength(JSON.stringify(out.message));
    expect(size).toBeLessThan(8 * 1024 * 1024);
    const thumbs = (out.message.parts as Array<ReturnType<typeof toolPart>>).flatMap((p) => p.state.attachments).filter((a) => "thumb" in a).reduce((n, a) => n + String((a as { thumb: string }).thumb).length, 0);
    expect(thumbs).toBeGreaterThan(0);
    expect(thumbs).toBeLessThanOrEqual(THUMBS_PER_MESSAGE_BYTES);
    expect(out.files.length).toBe(600);
    expect(new Set(out.files.map((f) => f.path)).size).toBe(600);
    expect(index.state.model_bytes).toBeLessThanOrEqual(200 * 1024 * 1024);
    expect(JSON.stringify(out.message)).not.toContain("data:image/png");
  }, 60_000);

  test("model budget: past it, refs say omitted and no file is added", () => {
    const dir = tmp();
    const spool = createMediaSpool(path.join(dir, "spool"));
    const pngs = [0, 1, 2].map((i) => encodePng(frame(64, 64, i)));
    const limit = pngs[0]!.length + pngs[1]!.length;
    const out = rewriteMessageMedia({ parts: [toolPart("a", pngs.map((p) => dataUrl("image/png", p)))] }, { spool, index: createMediaIndex(path.join(dir, "i.json")), limits: { media_model_bytes: limit } });
    expect(out.files.length).toBe(2);
    expect(((out.message.parts[0] as ReturnType<typeof toolPart>).state.attachments[2] as Record<string, unknown>).omitted).toBe("budget");
  });

  test("a frame released after one chat's upload comes back whole for the next chat (thumb and full)", () => {
    const dir = tmp();
    const spool = createMediaSpool(path.join(dir, "spool"));
    const big = frame(1600, 1000, 11);
    const model = encodePng(fitLongSide(big, 800));
    const put = () => spool.put({ bytes: model, mime: "image/png", full: { bytes: encodePng(big, { level: 1 }), width: 1600, height: 1000 }, thumb: encodeJpeg(fitLongSide(big, 320)) });
    const meta = put();
    spool.ref(meta.sha256, "ses_a");
    spool.ref(meta.sha256, "ses_b");
    expect(spool.release(meta.sha256, "ses_a")).toBe(false);
    expect(spool.has(meta.sha256, meta.ext)).toBe(true);
    expect(spool.release(meta.sha256, "ses_b")).toBe(true);
    expect(spool.has(meta.sha256, meta.ext)).toBe(false);
    // The host takes the identical frame again in a new chat; the reader meets it too.
    put();
    const out = rewriteMessageMedia({ parts: [toolPart("x", [dataUrl("image/png", model)])] }, { spool, index: createMediaIndex(path.join(dir, "c.json")), limits: {}, chat: "ses_c" });
    const ref = (out.message.parts[0] as ReturnType<typeof toolPart>).state.attachments[0] as Record<string, unknown>;
    expect(String(ref.thumb)).toStartWith("data:image/jpeg;base64,");
    expect(ref.full).toMatchObject({ width: 1600, height: 1000 });
    expect(out.files.map((f) => f.kind)).toEqual(["model", "full"]);
    // Only the reader meets it (meta kept, files gone): the model copy and a thumb come back from the message.
    spool.ref(meta.sha256, "ses_c");
    for (const sub of ["", "thumb"]) rmSync(path.join(dir, "spool", sub, sub ? `${meta.sha256}.jpg` : `${meta.sha256}.png`), { force: true });
    const back = rewriteMessageMedia({ parts: [toolPart("y", [dataUrl("image/png", model)])] }, { spool, index: createMediaIndex(path.join(dir, "d.json")), limits: {}, chat: "ses_d" });
    expect(String(((back.message.parts[0] as ReturnType<typeof toolPart>).state.attachments[0] as Record<string, unknown>).thumb)).toStartWith("data:image/jpeg;base64,");
    expect(spool.has(meta.sha256, "png")).toBe(true);
  });

  test("raw MCP image results kept in a tool part's metadata become refs too (same frame, one file)", () => {
    const dir = tmp();
    const spool = createMediaSpool(path.join(dir, "spool"));
    const png = encodePng(frame(40, 30, 21));
    const part = toolPart("m", [dataUrl("image/png", png)]);
    const withMeta = { ...part, state: { ...part.state, metadata: { omnirushMcpApp: { content: [{ type: "text", text: "{}" }, { type: "image", mimeType: "image/png", data: png.toString("base64") }] } } } };
    const out = rewriteMessageMedia({ parts: [withMeta] }, { spool, index: createMediaIndex(path.join(dir, "i.json")), limits: {} });
    const state = (out.message.parts[0] as typeof withMeta).state;
    expect(JSON.stringify(state)).not.toContain(png.toString("base64"));
    const content = state.metadata.omnirushMcpApp.content[1] as Record<string, unknown>;
    expect(content).toEqual({ type: "image", mimeType: "image/png", url: `omnirush-media:${sha256(png)}.png`, sha256: sha256(png) });
    expect(String((state.attachments[0] as Record<string, unknown>).thumb)).toStartWith("data:image/jpeg");
    expect(out.files.length).toBe(1);
    const untouched = { parts: [{ type: "tool", tool: "bash", state: { status: "completed", output: "ok", metadata: { exit: 0 } } }] };
    expect(rewriteMessageMedia(untouched, { spool, index: createMediaIndex(path.join(dir, "j.json")), limits: {} }).message).toBe(untouched);
  });

  test("only computer use parts by default: a playwright screenshot stays exactly as it was", () => {
    const dir = tmp();
    const spool = createMediaSpool(path.join(dir, "spool"));
    const png = encodePng(frame(30, 20, 31));
    const part = { ...toolPart("pw", [dataUrl("image/png", png)]), tool: "playwright_browser_take_screenshot" };
    const message = { parts: [part] };
    const out = rewriteMessageMedia(message, { spool, index: createMediaIndex(path.join(dir, "i.json")), limits: {} });
    expect(out.message).toBe(message);
    expect(out.files).toEqual([]);
    const all = rewriteMessageMedia(message, { spool, index: createMediaIndex(path.join(dir, "j.json")), limits: {}, match: () => true });
    expect(all.files.length).toBe(1);
  });

  test("data URL parsing", () => {
    expect(parseImageDataUrl("data:image/png;base64,AQID")).toEqual({ mime: "image/png", bytes: Buffer.from([1, 2, 3]) });
    expect(parseImageDataUrl("data:text/plain;base64,AQID")).toBeNull();
    expect(parseImageDataUrl("data:image/svg+xml;base64,AQID")).toBeNull();
    expect(parseImageDataUrl("https://x/y.png")).toBeNull();
  });
});

describe("model context pruning", () => {
  function chat(count: number) {
    const parts = Array.from({ length: count }, (_, i) => toolPart(`p${i}`, [dataUrl("image/png", encodePng(frame(8, 8, i)))]));
    return [{ info: { role: "assistant" }, parts }];
  }
  const images = (messages: ReturnType<typeof chat>) => messages[0]!.parts.reduce((n, p) => n + p.state.attachments.length, 0);

  test("keeps up to 12; past 12 drops the oldest 8 at a time; notes the dropped ones", () => {
    const twelve = chat(12);
    expect(pruneImages(twelve)).toBe(0);
    expect(images(twelve)).toBe(12);
    const thirteen = chat(13);
    expect(pruneImages(thirteen)).toBe(8);
    expect(images(thirteen)).toBe(5);
    expect(thirteen[0]!.parts[0]!.state.output).toMatch(/\[screenshot [a-f0-9]{8} omitted\]$/);
    const twenty = chat(20);
    pruneImages(twenty);
    expect(images(twenty)).toBe(12);
    const twentyOne = chat(21);
    pruneImages(twentyOne);
    expect(images(twentyOne)).toBe(5);
    // Stable prefix: the same oldest images are dropped from 13 to 20 images.
    const at14 = chat(14);
    pruneImages(at14);
    expect(at14[0]!.parts.slice(0, 8).every((p) => p.state.attachments.length === 0)).toBe(true);
    expect(at14[0]!.parts[8]!.state.attachments.length).toBe(1);
  });
});
