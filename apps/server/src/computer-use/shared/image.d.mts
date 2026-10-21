// Types of image.mjs (the same files in omnirush-cli src/computer-use/ and
// omnirush-gui apps/server/src/computer-use/shared/; PARITY.sha256).

export type RgbaImage = { width: number; height: number; data: Uint8Array };
export type Rect = { x: number; y: number; width: number; height: number };
export type Grid = { cell: number; cols: number; rows: number; width: number; height: number; values: Float32Array };

export function encodePng(image: RgbaImage, options?: { level?: number }): Buffer;
export function decodePng(bytes: Uint8Array, options?: { maxPixels?: number }): RgbaImage | null;
export function resize(image: RgbaImage, width: number, height: number): RgbaImage;
export function fitLongSide(image: RgbaImage, longSide: number): RgbaImage;
export function paintBoxes(image: RgbaImage, boxes: Rect[] | null | undefined, color?: [number, number, number]): number;
export function encodeJpeg(image: RgbaImage, options?: { quality?: number }): Buffer;
export function imageInfo(bytes: Uint8Array): { mime: string; width: number; height: number } | null;
export function extensionOf(mime: unknown): "png" | "jpg" | "gif" | "webp" | "bin";
export function luminanceGrid(image: RgbaImage, cell?: number): Grid;
export function compareGrids(a: Grid | null | undefined, b: Grid | null | undefined, options?: { mask?: Rect[]; threshold?: number; minMass?: number; fraction?: number }): { stale: boolean; changed: number; span?: number; mass?: number };
export const AGENT_CURSOR_COLOR: readonly [number, number, number];
export function drawCursor(image: RgbaImage, x: number, y: number, options?: { color?: readonly number[]; label?: boolean; scale?: number }): Rect;
