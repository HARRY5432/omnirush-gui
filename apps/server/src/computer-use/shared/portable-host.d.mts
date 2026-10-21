// Types of portable-host.mjs (the same files in omnirush-cli src/computer-use/ and
// omnirush-gui apps/server/src/computer-use/shared/; PARITY.sha256).
// native-worker.mjs is a child process (Node IPC, advanced serialization); it has no exports.
import type { Limits } from "./contract.mjs";
import type { MediaSpool } from "./media.mjs";
import type { DenyEntry, PermissionMode, ProcessInfo } from "./policy.mjs";

export type NativeWorker = {
  ready: Promise<{ supported: boolean; code?: string; error?: string; platform?: string }>;
  pid?: number;
  readonly held: { keys: number[]; buttons: number[] };
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  call(method: string, params?: Record<string, unknown>, ms?: number): Promise<unknown>;
  kill?(): void;
  close(): Promise<void>;
};
export function createNativeWorker(options?: { workerPath?: string; nodePath?: string; nodeEnv?: Record<string, string>; koffiPath?: string; timeoutMs?: number }): NativeWorker;

export type HostSettings = { enabled: boolean; real_screen?: boolean; limits?: Partial<Limits> | null; deny_apps?: Array<DenyEntry | string>; mode?: PermissionMode | string | null; message?: string | null; ask_send_delete?: boolean };
export type HostContext = { ancestors?: ProcessInfo[]; self_pids?: number[]; tty_pids?: number[]; chat?: string | null };
export type AppRef = { app_id: string; app_name: string; bundle_or_exe: string; pid: number };
export type OpenRequest = { session_id: string; request_id: string; app: AppRef; windows: Array<{ id: string; title: string }>; window_id: string; mode: "observe" | "control"; purpose: string; os: string; seconds: number; /** "Allow for this chat": 0 = until the chat ends, else at most this many seconds. */ chat_seconds: number; /** The chat the request belongs to (null: none named, e.g. the copied CLI connection). */ chat: string | null };
export type OpenAnswer = { decision: "chat" | "once" | "deny"; window_id?: string };
export type ActRequest = {
  chat: string | null;
  session_id: string;
  request_id: string;
  app: AppRef;
  window_title: string;
  purpose: string;
  intent: string;
  action: Record<string, unknown>;
  reasons: Array<{ code: string; detail?: string }>;
  points: Array<{ x: number; y: number }>;
  frame: { width: number; height: number; sha256: string; data_url: string };
};
export type SessionEvent = {
  event: "opened" | "approved" | "denied" | "paused" | "continued" | "stopped" | "closed" | "expired";
  by: "person" | "agent" | "limit" | "server";
  session_id: string;
  app_id: string;
  app_name: string;
  bundle_or_exe: string;
  mode: "observe" | "control";
  approval?: "once" | "chat";
  screen?: { id: string; width: number; height: number; scale: number };
  os: string;
  /** e.g. native_unavailable, action_limit, window_unavailable, worker_restarted (on "opened"). */
  reason?: string;
  reused?: boolean;
};
export type HostSessionState = {
  id: string;
  phase: "approval" | "working" | "paused" | "ended";
  mode: "observe" | "control";
  purpose: string;
  status: string;
  app: AppRef;
  window: { id: string; title: string };
  windows: Array<{ id: string; title: string }>;
  approval: "once" | "chat" | null;
  actions: number;
  actions_left: number;
  seconds_left: number;
  can_continue: boolean;
  log: Array<{ at: string; action: string; intent: string; ok: boolean; code: string | null }>;
  frame: { sha: string; width: number; height: number; mime: string; data_url: string; at: string } | null;
  chat: string | null;
  /** The person hid the floating pill. */
  hidden: boolean;
  /** The window's native bounds, for placing the floating pill. */
  window_bounds: { x: number; y: number; width: number; height: number };
};
export type McpConnection = { id: string; handle(message: unknown): Promise<Record<string, unknown> | null>; close(): Promise<void> };
export type PortableHost = {
  readonly availability: { supported: boolean; code?: string; error?: string };
  os: string;
  /** internal false: a connection from outside the app's own engine (no chat, never keeps or reuses a grant). */
  connect(options?: { internal?: boolean }): McpConnection;
  /** discoveryPath: the app's own engine relay; externalDiscoveryPath: the copied CLI connection (external). */
  listen(dir: string): Promise<{ discoveryPath: string; externalDiscoveryPath: string; close(): Promise<void> }>;
  control(input: { session_id: string; action: "stop" | "takeover" | "continue" | "hide" | "show" }): Promise<void>;
  stopAll(by?: SessionEvent["by"], event?: SessionEvent["event"]): Promise<void>;
  syntheticInput(withinMs?: number): Promise<boolean>;
  /** A physical key or button press within `withinMs` (not injected, not a remote-debugging click). */
  /** Default 1.5 s; a pointer press must be inside `rect` (screen pixels) when given; a key press must be one of `keys` (default Enter, Space). */
  physicalInput(withinMs?: number, options?: { foregroundPid?: number | null; rect?: { x: number; y: number; width: number; height: number } | null; keys?: string[] }): Promise<boolean>;
  watchInput(): Promise<void>;
  state(): HostSessionState[];
  close(): Promise<void>;
};
export function createPortableHost(options: {
  native: NativeWorker;
  /** Starts a new worker after this one died (at most 3 times in 10 minutes, on the next call). */
  nativeFactory?: (() => NativeWorker) | null;
  spool?: MediaSpool | null;
  settings: () => HostSettings;
  /** May be async (read once per discover / open-session). */
  context?: () => HostContext | Promise<HostContext>;
  /** Read the server's switch and limits now (before each open); false or a throw: unread, no grant is reused. */
  refresh?: (() => Promise<boolean> | boolean) | null;
  approve: { open(request: OpenRequest): Promise<OpenAnswer> | OpenAnswer; act(request: ActRequest): Promise<{ allow: boolean }> | { allow: boolean } };
  onEvent?: (event: SessionEvent) => void;
  onState?: (states: HostSessionState[]) => void;
  onFrame?: (frame: { session_id: string; sha: string; width: number; height: number; mime: string; data_url: string; at: string }) => void;
  platform?: string;
}): Promise<PortableHost>;
