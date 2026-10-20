// Media references: image data URLs in tool results (computer use
// screenshots, playwright screenshots, any MCP image) are replaced by
// `omnirush-media:<sha256>.<ext>` references while the engine's messages are
// read, part by part, before any size cap, so a turn of hundreds of frames
// uploads whole. The bytes go to the archive under `__media__/`, with their
// own budget and lane:
//   __media__/<sha256>.<ext>       the exact bytes the model saw
//   __media__/full/<sha256>.png    full resolution, only when larger
//
// The same file ships in omnirush-cli (src/computer-use/) and omnirush-gui
// (apps/server/src/computer-use/shared/); PARITY.sha256 lists it in both.
//
// A reference (it replaces the attachment's `url`, other keys are kept):
//   { mime, url: "omnirush-media:<sha>.<ext>", sha256, width, height, bytes,
//     full?: { sha256, width, height, bytes, ext } | { omitted: "budget" },
//     omitted?: "budget",                     (model copy not archived)
//     thumb?: "data:image/jpeg;base64,..." }  (≤ 320 px; first time per chat)

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_LIMITS } from "./contract.mjs";
import { decodePng, encodeJpeg, extensionOf, fitLongSide, imageInfo } from "./image.mjs";

export const MEDIA_ROOT = "__media__";
export const MEDIA_SCHEME = "omnirush-media:";
export const THUMB_LONG_SIDE = 320;
export const THUMB_QUALITY = 70;
export const THUMBS_PER_MESSAGE_BYTES = 2 * 1024 * 1024;
export const INDEX_VERSION = 1;

const SHA = /^[a-f0-9]{64}$/;
const EXT = /^(png|jpg|gif|webp)$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** "omnirush-media:<sha>.<ext>" */
export function mediaUrl(sha, ext) {
  return `${MEDIA_SCHEME}${sha}.${ext}`;
}

/** { sha, ext } of a media reference url, or null. */
export function parseMediaUrl(url) {
  if (typeof url !== "string" || !url.startsWith(MEDIA_SCHEME)) return null;
  const [sha, ext] = url.slice(MEDIA_SCHEME.length).split(".");
  return SHA.test(sha ?? "") && EXT.test(ext ?? "") ? { sha, ext } : null;
}

/** Archive paths of a reference's files. */
export function mediaPaths(sha, ext) {
  return { model: `${MEDIA_ROOT}/${sha}.${ext}`, full: `${MEDIA_ROOT}/full/${sha}.png` };
}

/** { mime, bytes } of a base64 image data URL, or null (not an image, not base64, malformed). */
export function parseImageDataUrl(url) {
  if (typeof url !== "string" || !url.startsWith("data:image/")) return null;
  const comma = url.indexOf(",");
  if (comma < 0 || comma > 200) return null;
  const head = url.slice(5, comma);
  if (!/;base64$/i.test(head)) return null;
  const mime = head.slice(0, head.indexOf(";")).toLowerCase();
  if (!["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"].includes(mime)) return null;
  const bytes = Buffer.from(url.slice(comma + 1), "base64");
  return bytes.length ? { mime: mime === "image/jpg" ? "image/jpeg" : mime, bytes } : null;
}

/** A ≤ 320 px JPEG thumbnail of PNG bytes (the decoder this module has), else null. */
export function thumbnailOf(bytes, mime) {
  if (mime !== "image/png") return null;
  const image = decodePng(bytes, { maxPixels: 40_000_000 });
  if (!image) return null;
  return encodeJpeg(fitLongSide(image, THUMB_LONG_SIDE), { quality: THUMB_QUALITY });
}

function writeAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, data, { mode: 0o600 });
  renameSync(temp, file);
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * The local media spool: hosts put each frame here when they take it (model
 * copy, full-resolution PNG, thumbnail, size), the reader finds them by sha.
 * Frames the reader meets without a host (playwright) are put by the reader.
 *   <dir>/<sha>.<ext>, <dir>/full/<sha>.png, <dir>/thumb/<sha>.jpg, <dir>/meta/<sha>.json
 */
export function createMediaSpool(dir) {
  const metaFile = (sha) => path.join(dir, "meta", `${sha}.json`);
  const spool = {
    dir,
    /**
     * Stores a frame. `bytes`/`mime`: the model copy; `full`: { bytes (PNG),
     * width, height } when the host has a larger original; `thumb`: JPEG bytes.
     * Returns its meta { sha256, ext, mime, width, height, bytes, full?, thumb? }.
     */
    put({ bytes, mime, width, height, full, thumb, ocr, masked }) {
      const data = Buffer.from(bytes);
      const sha = sha256(data);
      const existing = spool.meta(sha);
      if (existing) return existing;
      const info = imageInfo(data);
      const type = info?.mime ?? mime;
      const ext = extensionOf(type);
      const meta = { sha256: sha, ext, mime: type, width: width ?? info?.width ?? 0, height: height ?? info?.height ?? 0, bytes: data.length };
      writeAtomic(path.join(dir, `${sha}.${ext}`), data);
      if (full?.bytes && (full.width * full.height > meta.width * meta.height)) {
        const fullBytes = Buffer.from(full.bytes);
        const fullSha = sha256(fullBytes);
        writeAtomic(path.join(dir, "full", `${sha}.png`), fullBytes);
        meta.full = { sha256: fullSha, width: full.width, height: full.height, bytes: fullBytes.length, ext: "png" };
      }
      const thumbBytes = thumb ? Buffer.from(thumb) : null;
      if (thumbBytes?.length) { writeAtomic(path.join(dir, "thumb", `${sha}.jpg`), thumbBytes); meta.thumb = thumbBytes.length; }
      if (ocr) meta.ocr = ocr;
      if (Number.isInteger(masked)) meta.masked = masked;
      writeAtomic(metaFile(sha), JSON.stringify(meta));
      return meta;
    },
    meta(sha) {
      if (!SHA.test(String(sha))) return null;
      const value = readJson(metaFile(sha));
      return isRecord(value) && value.sha256 === sha ? value : null;
    },
    modelPath(sha, ext) { return path.join(dir, `${sha}.${ext}`); },
    fullPath(sha) { return path.join(dir, "full", `${sha}.png`); },
    thumb(sha) { try { return readFileSync(path.join(dir, "thumb", `${sha}.jpg`)); } catch { return null; } },
    has(sha, ext) { return existsSync(path.join(dir, `${sha}.${ext}`)); },
    /** Deletes a frame's local files (after its upload). */
    remove(sha) {
      if (!SHA.test(String(sha))) return;
      const meta = spool.meta(sha);
      for (const file of [meta ? path.join(dir, `${sha}.${meta.ext}`) : null, path.join(dir, "full", `${sha}.png`), path.join(dir, "thumb", `${sha}.jpg`), metaFile(sha)]) if (file) rmSync(file, { force: true });
    },
  };
  return spool;
}

/**
 * The per-chat media index, persisted (it survives resumes): which frames
 * the chat has seen (a thumbnail is inlined only the first time), which went
 * to the archive, and the bytes used of each budget.
 */
export function createMediaIndex(file) {
  const loaded = readJson(file);
  const state = isRecord(loaded) && loaded.v === INDEX_VERSION
    ? { v: INDEX_VERSION, seen: isRecord(loaded.seen) ? loaded.seen : {}, model_bytes: Number(loaded.model_bytes) || 0, full_bytes: Number(loaded.full_bytes) || 0, frames: Number(loaded.frames) || 0 }
    : { v: INDEX_VERSION, seen: {}, model_bytes: 0, full_bytes: 0, frames: 0 };
  let dirty = false;
  return {
    file,
    state,
    entry(sha) { return state.seen[sha] ?? null; },
    /** Records a frame once; `stored`: { model, full } booleans. */
    add(sha, { model, full, modelBytes, fullBytes }) {
      if (state.seen[sha]) return state.seen[sha];
      const entry = { m: model ? 1 : 0, f: full ? 1 : 0 };
      state.seen[sha] = entry;
      state.frames += 1;
      if (model) state.model_bytes += modelBytes;
      if (full) state.full_bytes += fullBytes;
      dirty = true;
      return entry;
    },
    save() {
      if (!dirty || !file) return;
      writeAtomic(file, JSON.stringify(state));
      dirty = false;
    },
  };
}

function budgets(limits) {
  const l = isRecord(limits) ? limits : {};
  return {
    model: Number.isFinite(l.media_model_bytes) ? l.media_model_bytes : DEFAULT_LIMITS.media_model_bytes,
    full: Number.isFinite(l.media_full_bytes) ? l.media_full_bytes : DEFAULT_LIMITS.media_full_bytes,
  };
}

/**
 * Replaces image data URLs in the tool parts of one engine message (in place
 * on a structured copy; the input is not changed) with media references.
 * `ctx`: { spool, index, limits, thumbBudget }. Returns
 * { message, changed, files: [{ path, file, sha, kind: "model"|"full" }] }:
 * the archive files this message adds (each frame once per chat).
 * User file parts are left alone (the archive keeps those as attachments).
 */
export function rewriteMessageMedia(message, ctx) {
  if (!isRecord(message) || !Array.isArray(message.parts)) return { message, changed: false, files: [] };
  let changed = false;
  let thumbsLeft = Number.isFinite(ctx.thumbBudget) ? ctx.thumbBudget : THUMBS_PER_MESSAGE_BYTES;
  const files = [];
  const budget = budgets(ctx.limits);
  const parts = message.parts.map((part) => {
    const attachments = isRecord(part) && part.type === "tool" && isRecord(part.state) && Array.isArray(part.state.attachments) ? part.state.attachments : null;
    if (!attachments || !attachments.some((a) => isRecord(a) && typeof a.url === "string" && a.url.startsWith("data:image/"))) return part;
    const next = attachments.map((attachment) => {
      const parsed = isRecord(attachment) ? parseImageDataUrl(attachment.url) : null;
      if (!parsed) return attachment;
      const sha = sha256(parsed.bytes);
      let meta = ctx.spool.meta(sha);
      if (!meta) {
        const thumb = thumbnailOf(parsed.bytes, parsed.mime);
        meta = ctx.spool.put({ bytes: parsed.bytes, mime: parsed.mime, ...(thumb ? { thumb } : {}) });
      } else if (!ctx.spool.has(sha, meta.ext)) {
        // Uploaded and removed from the spool, then met again: the engine still has the model copy.
        meta = { ...ctx.spool.put({ bytes: parsed.bytes, mime: parsed.mime }), ...(meta.full ? { full: meta.full } : {}) };
      }
      let entry = ctx.index.entry(sha);
      const first = !entry;
      if (first) {
        const model = ctx.index.state.model_bytes + meta.bytes <= budget.model;
        const full = Boolean(meta.full) && model && ctx.index.state.full_bytes + meta.full.bytes <= budget.full && existsSync(ctx.spool.fullPath(sha));
        entry = ctx.index.add(sha, { model, full, modelBytes: meta.bytes, fullBytes: meta.full?.bytes ?? 0 });
        const paths = mediaPaths(sha, meta.ext);
        if (model) files.push({ path: paths.model, file: ctx.spool.modelPath(sha, meta.ext), sha, kind: "model", bytes: meta.bytes });
        if (full) files.push({ path: paths.full, file: ctx.spool.fullPath(sha), sha, kind: "full", bytes: meta.full.bytes });
      }
      const { url: _url, ...rest } = attachment;
      const ref = { ...rest, mime: meta.mime, url: mediaUrl(sha, meta.ext), sha256: sha, width: meta.width, height: meta.height, bytes: meta.bytes };
      if (meta.full) ref.full = entry.f ? { ...meta.full } : { omitted: "budget" };
      if (!entry.m) ref.omitted = "budget";
      if (first) {
        const thumb = ctx.spool.thumb(sha);
        if (thumb && thumb.length * 4 / 3 + 32 <= thumbsLeft) {
          ref.thumb = `data:image/jpeg;base64,${thumb.toString("base64")}`;
          thumbsLeft -= ref.thumb.length;
        }
      }
      changed = true;
      return ref;
    });
    return { ...part, state: { ...part.state, attachments: next } };
  });
  if (changed) ctx.index.save();
  return { message: changed ? { ...message, parts } : message, changed, files };
}

/** Every media reference in a message's tool parts ([{ sha, ext }]). */
export function mediaRefsOf(message) {
  const out = [];
  for (const part of isRecord(message) && Array.isArray(message.parts) ? message.parts : []) {
    const attachments = isRecord(part) && isRecord(part.state) && Array.isArray(part.state.attachments) ? part.state.attachments : [];
    for (const a of attachments) { const ref = isRecord(a) ? parseMediaUrl(a.url) : null; if (ref) out.push(ref); }
  }
  return out;
}

/** Bytes of a spool file, or 0. */
export function fileBytes(file) {
  try { return statSync(file).size; } catch { return 0; }
}

// ------------------------------------------------------- model context pruning

export const KEEP_IMAGES = 12;
export const DROP_IMAGES = 8;

/**
 * Prunes screenshots from the MODEL context (the engine plugin hook
 * `experimental.chat.messages.transform`; the stored chat is untouched):
 * keeps up to KEEP_IMAGES tool-result images; when the count passes it, the
 * oldest DROP_IMAGES at a time are replaced by a text note, so the cached
 * prefix stays stable for several steps. Mutates `messages` in place and
 * returns the number of images dropped. `messages`: engine WithParts list.
 */
export function pruneImages(messages, { keep = KEEP_IMAGES, drop = DROP_IMAGES } = {}) {
  const found = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const part of isRecord(message) && Array.isArray(message.parts) ? message.parts : []) {
      if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state) || !Array.isArray(part.state.attachments)) continue;
      part.state.attachments.forEach((a, i) => { if (isRecord(a) && typeof a.mime === "string" && a.mime.startsWith("image/")) found.push({ part, index: i, attachment: a }); });
    }
  }
  if (found.length <= keep) return 0;
  // Drop in blocks of `drop`: the number dropped only changes every `drop` new images.
  const excess = found.length - keep;
  const count = Math.min(found.length, Math.ceil(excess / drop) * drop);
  const byPart = new Map();
  for (const item of found.slice(0, count)) {
    const list = byPart.get(item.part) ?? [];
    list.push(item);
    byPart.set(item.part, list);
  }
  for (const [part, items] of byPart) {
    const drops = new Set(items.map((i) => i.index));
    const notes = items.map(({ attachment }) => {
      const sha = typeof attachment.sha256 === "string" ? attachment.sha256 : parseImageDataUrl(attachment.url) ? sha256(parseImageDataUrl(attachment.url).bytes) : "";
      return `[screenshot ${sha.slice(0, 8)} omitted]`;
    });
    part.state.attachments = part.state.attachments.filter((_, i) => !drops.has(i));
    if (typeof part.state.output === "string") part.state.output = `${part.state.output}\n${notes.join("\n")}`;
  }
  return count;
}
