// Types of virtual-host.mjs (the same files in omnirush-cli src/computer-use/ and
// omnirush-gui apps/server/src/computer-use/shared/; PARITY.sha256).
// virtual-worker.mjs is a child process (Node IPC, advanced serialization); it exports glidePath only.
import type { Limits } from "./contract.mjs";
import type { MediaSpool } from "./media.mjs";
import type { HostSessionState, NativeWorker, SessionEvent } from "./portable-host.mjs";

export const VIRTUAL_SIZE: Readonly<{ width: number; height: number }>;
export const VIRTUAL_WORKER_PATH: string;
export const SETTLE_MS: Readonly<Record<string, number>>;
export function which(name: string, env?: Record<string, string | undefined>): string | null;
export function freeDisplay(from?: number, to?: number): number | null;
export function virtualPackages(env?: Record<string, string | undefined>): { xvfb: string | null; openbox: string | null };
export type Browser = { path: string; kind: "chromium" | "firefox"; name: string };
export function findBrowser(env?: Record<string, string | undefined>): Browser | null;
export function browserArgs(browser: Browser, options?: { profile: string; url?: string; width?: number; height?: number; root?: boolean }): string[];
export function rawFrame(answer: unknown): { width: number; height: number; data: Uint8Array } | null;

/** The worker interface of a backend: capture → { width, height, data RGBA } (or { image: PNG }), pointer → { x, y }, act { action }, release. */
export type VirtualWorker = Pick<NativeWorker, "call"> & { close?(): Promise<void> };
export type VirtualBackend = {
  ok: true;
  kind: string;
  name?: string;
  display: string;
  width: number;
  height: number;
  wm?: string | null;
  packages?: Record<string, string | null>;
  /** sandbox false: Chromium's sandbox could not start here (root, or no user namespaces), so it runs without. */
  browser?: { name: string; kind?: string; version?: string | null; profile: "fresh"; sandbox?: boolean } | null;
  worker: VirtualWorker;
  close(): Promise<void>;
};
export type Failure = { ok: false; code: string; message: string };
export function startXvfbBackend(options?: { name?: string; env?: Record<string, string | undefined>; nodePath?: string; nodeEnv?: Record<string, string>; koffiPath?: string | null; url?: string | null; browser?: boolean; size?: { width: number; height: number }; deps?: Record<string, unknown> }): Promise<VirtualBackend | Failure>;

export type CursorMove = { session_id: string; from: { x: number; y: number } | null; to: { x: number; y: number }; path: Array<{ x: number; y: number }>; action: string; width: number; height: number };
export type VirtualHost = {
  owns(id: unknown): boolean;
  open(args: { app_id: string; mode: "observe" | "control"; purpose: string; url?: string; browser?: boolean }): Promise<Record<string, unknown>>;
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  state(): HostSessionState[];
  control(input: { session_id: string; action: "stop" | "hide" | "show" | string }): Promise<void>;
  stopAll(by?: SessionEvent["by"], event?: SessionEvent["event"]): Promise<void>;
  close(): Promise<void>;
  hint: string;
};
export function createVirtualHost(options: {
  startBackend: (name: string, options: { url: string | null; browser: boolean }) => Promise<VirtualBackend | Failure>;
  settings?: () => { enabled?: boolean; virtual_display?: boolean; limits?: Partial<Limits> | null; message?: string | null };
  context?: () => { chat?: string | null } | Promise<{ chat?: string | null }>;
  spool?: MediaSpool | null;
  onEvent?: (event: SessionEvent) => void;
  onState?: (states: HostSessionState[]) => void;
  onFrame?: (frame: { session_id: string; sha: string; width: number; height: number; mime: string; data_url: string; at: string; cursor: { x: number; y: number } | null }) => void;
  onCursor?: (move: CursorMove) => void;
  platform?: string;
}): VirtualHost;
