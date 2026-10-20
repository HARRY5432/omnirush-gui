// Types of media.mjs (the same files in omnirush-cli src/computer-use/ and
// omnirush-gui apps/server/src/computer-use/shared/; PARITY.sha256).

export const MEDIA_ROOT: "__media__";
export const MEDIA_SCHEME: "omnirush-media:";
export const THUMB_LONG_SIDE: number;
export const THUMB_QUALITY: number;
export const THUMBS_PER_MESSAGE_BYTES: number;
export const INDEX_VERSION: 1;
export const KEEP_IMAGES: number;
export const DROP_IMAGES: number;

export type FullMeta = { sha256: string; width: number; height: number; bytes: number; ext: "png" };
export type MediaMeta = {
  sha256: string;
  ext: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  full?: FullMeta;
  thumb?: number;
  ocr?: "client" | "none";
  masked?: number;
};
export type MediaRef = {
  mime: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  bytes: number;
  full?: FullMeta | { omitted: "budget" };
  omitted?: "budget";
  thumb?: string;
  [key: string]: unknown;
};
export type MediaFile = { path: string; file: string; sha: string; kind: "model" | "full"; bytes: number };

export type MediaSpool = {
  dir: string;
  put(frame: { bytes: Uint8Array; mime: string; width?: number; height?: number; full?: { bytes: Uint8Array; width: number; height: number } | null; thumb?: Uint8Array | null; ocr?: "client" | "none"; masked?: number }): MediaMeta;
  meta(sha: string): MediaMeta | null;
  modelPath(sha: string, ext: string): string;
  fullPath(sha: string): string;
  thumb(sha: string): Buffer | null;
  has(sha: string, ext: string): boolean;
  remove(sha: string): void;
};
export type MediaIndexState = { v: 1; seen: Record<string, { m: 0 | 1; f: 0 | 1 }>; model_bytes: number; full_bytes: number; frames: number };
export type MediaIndex = {
  file: string;
  state: MediaIndexState;
  entry(sha: string): { m: 0 | 1; f: 0 | 1 } | null;
  add(sha: string, stored: { model: boolean; full: boolean; modelBytes: number; fullBytes: number }): { m: 0 | 1; f: 0 | 1 };
  save(): void;
};

export function sha256(bytes: Uint8Array): string;
export function mediaUrl(sha: string, ext: string): string;
export function parseMediaUrl(url: unknown): { sha: string; ext: string } | null;
export function mediaPaths(sha: string, ext: string): { model: string; full: string };
export function parseImageDataUrl(url: unknown): { mime: string; bytes: Buffer } | null;
export function thumbnailOf(bytes: Uint8Array, mime: string): Buffer | null;
export function createMediaSpool(dir: string): MediaSpool;
export function createMediaIndex(file: string): MediaIndex;
export function rewriteMessageMedia<T>(message: T, ctx: { spool: MediaSpool; index: MediaIndex; limits?: { media_full_bytes?: number; media_model_bytes?: number } | null; thumbBudget?: number }): { message: T; changed: boolean; files: MediaFile[] };
export function mediaRefsOf(message: unknown): Array<{ sha: string; ext: string }>;
export function fileBytes(file: string): number;
export function pruneImages(messages: unknown[], options?: { keep?: number; drop?: number }): number;
