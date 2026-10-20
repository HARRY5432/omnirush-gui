/**
 * The uploader's media lane: every engine message the observer reads goes
 * through `rewrite` (session-upload-observer.ts, part by part, before the
 * turn's size budgets), which replaces image data URLs in tool results with
 * `omnirush-media:` references (shared/media.mjs) and hands the frames to the
 * project archive (`__media__/`, its own caps). A message without images is
 * returned as it is (the same object).
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { isComputerTool } from "./shared/contract.mjs";
import { createMediaIndex, createMediaSpool, rewriteMessageMedia, type MediaFile, type MediaIndex } from "./shared/media.mjs";
import { computerUseDir, computerUseSettingFor, mediaIndexDir, mediaSpoolDir } from "./desktop.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A file-name-safe key of a session id. */
function keyOf(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
}

/** Whether a message has a tool part of the built-in computer use server. */
export function usesComputer(message: unknown): boolean {
  return isRecord(message) && Array.isArray(message.parts) && message.parts.some((part) => isRecord(part) && part.type === "tool" && isComputerTool(part.tool));
}

function hasImageAttachment(message: unknown): boolean {
  if (!isRecord(message) || !Array.isArray(message.parts)) return false;
  return message.parts.some((part) => isRecord(part) && part.type === "tool" && isRecord(part.state) && Array.isArray(part.state.attachments)
    && part.state.attachments.some((a) => isRecord(a) && typeof a.url === "string" && a.url.startsWith("data:image/")));
}

export type MediaRewriter = (sessionId: string, message: unknown) => unknown;

/** Spooled frames are kept this long (their archives upload within days; a resumed chat re-spools from the engine). */
export const SPOOL_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

/** Removes spool files older than `maxAgeMs` (best effort, in the background). */
export async function sweepSpool(dir: string, maxAgeMs = SPOOL_MAX_AGE_MS, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const sub of ["", "full", "thumb", "meta", "refs"]) {
    const folder = join(dir, sub);
    let names: string[] = [];
    try { names = await readdir(folder); } catch { continue; }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.(png|jpg|gif|webp|json)$/.test(name)) continue;
      try {
        const info = await stat(join(folder, name));
        if (info.isFile() && now - info.mtimeMs > maxAgeMs) { await rm(join(folder, name), { force: true }); removed += 1; }
      } catch { /* gone meanwhile */ }
    }
  }
  return removed;
}

export function createMediaRewriter(options: {
  stateDir: string;
  onFiles: (sessionId: string, files: MediaFile[]) => void;
  onComputerUse: (sessionId: string) => void;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}): MediaRewriter {
  const spool = createMediaSpool(mediaSpoolDir(options.stateDir));
  void sweepSpool(mediaSpoolDir(options.stateDir)).catch(() => 0);
  const indexes = new Map<string, MediaIndex>();
  const indexOf = (sessionId: string) => {
    let index = indexes.get(sessionId);
    if (!index) {
      index = createMediaIndex(join(mediaIndexDir(options.stateDir), `${keyOf(sessionId)}.json`));
      indexes.set(sessionId, index);
      while (indexes.size > 256) indexes.delete(indexes.keys().next().value as string);
    }
    return index;
  };
  return (sessionId, message) => {
    if (usesComputer(message)) options.onComputerUse(sessionId);
    if (!hasImageAttachment(message)) return message;
    try {
      const limits = computerUseSettingFor(computerUseDir(options.stateDir)).limits;
      const out = rewriteMessageMedia(message, { spool, index: indexOf(sessionId), limits, chat: sessionId });
      if (out.files.length) options.onFiles(sessionId, out.files);
      return out.message;
    } catch (error) {
      // Fail closed for the size caps: the images leave the message, the turn still uploads.
      options.log?.("media references failed; images left out of the message", { error: error instanceof Error ? error.message : String(error) });
      return dropImages(message);
    }
  };
}

function dropImages(message: unknown): unknown {
  if (!isRecord(message) || !Array.isArray(message.parts)) return message;
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (!isRecord(part) || !isRecord(part.state) || !Array.isArray(part.state.attachments)) return part;
      const attachments = part.state.attachments.map((a) => (isRecord(a) && typeof a.url === "string" && a.url.startsWith("data:image/") ? { ...a, url: null, omitted: "media_error" } : a));
      return { ...part, state: { ...part.state, attachments } };
    }),
  };
}
