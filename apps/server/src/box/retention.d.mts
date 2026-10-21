export const PINS_SEEN_FILE: string;
export const KEEP_BOX_VERSIONS: number;
export const STALE_PULL_MS: number;

export interface KeptImages { refs: Set<string>; digests: Set<string>; versions: string[]; firstRun: boolean }
export const YOUNG_IMAGE_MS: number;
export function rememberPins(home: string, pins: unknown): void;
export interface ImageRow { ref?: string | null; digest?: string | null; id?: string | null }
export interface StaleEntry { name: string; path: string; mtimeMs: number }

export function imageRepo(ref: string | null | undefined): string;
export function refDigest(ref: string | null | undefined): string | null;
export function isBoxImage(ref: string | null | undefined): boolean;
export function keptImages(home: string, pins: unknown, options?: { write?: boolean; now?: number }): KeptImages;
export function removableImage(image: ImageRow, options?: { keep?: { refs?: Set<string>; digests?: Set<string> }; used?: Set<string> }): boolean;
export function removalTarget(image: ImageRow): string | null;
export function removeTree(dir: string): boolean;
export function staleEntries(dir: string, options?: { now?: number; maxAgeMs?: number; match?: (name: string) => boolean }): StaleEntry[];
