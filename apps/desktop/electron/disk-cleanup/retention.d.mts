export const MB: number;
export const DAY_MS: number;
export const LOG_FILE_CAP_BYTES: number;
export const LOG_TOTAL_CAP_BYTES: number;
export const LOG_MAX_AGE_MS: number;
export const TEMP_MAX_AGE_MS: number;

export interface Removal { ok: boolean; bytes: number; locked?: boolean; error?: string; dryRun?: boolean }
export interface Rotation { rotated: boolean; bytes: number; locked?: boolean; error?: string; wouldRotate?: number; dryRun?: boolean }
export interface LogRemoval { path: string; bytes: number; reason: string; locked?: boolean; dryRun?: boolean }

export function sizeOf(p: string): number;
export function formatBytes(bytes: number): string;
export function removePath(p: string, options?: { dryRun?: boolean }): Removal;
export function parseVersion(value: unknown): [number, number, number, string[]] | null;
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1;
export function versionsToRemove(versions: string[], options: { current: string; previous?: string | null; protect?: string[] }): string[];
export function rotateLog(file: string, options?: { maxBytes?: number; dryRun?: boolean }): Rotation | null;
export function capLogs(dir: string, options?: { match?: (name: string) => boolean; active?: string[]; maxTotalBytes?: number; maxAgeMs?: number; now?: number; dryRun?: boolean }): LogRemoval[];
export function staleTemp(dir: string, prefixes: string[], options?: { now?: number; maxAgeMs?: number }): string[];
export function acquireLock(file: string, options?: { staleMs?: number; now?: number }): (() => void) | null;
export function summarize(items: Array<{ bytes?: number; locked?: boolean; error?: string } | null | undefined>): { count: number; bytes: number; locked: number };
