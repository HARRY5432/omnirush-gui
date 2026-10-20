// Types of contract.mjs (the same files in omnirush-cli src/computer-use/ and
// omnirush-gui apps/server/src/computer-use/shared/; PARITY.sha256).

export const CONTRACT_VERSION: "omnirush.computer-use/2";
export const SERVER_ID: "computer-use";
export const SERVER_NAME: string;
export const TOOL_PREFIX: "computer-use_";
export type ToolName = "computer_discover" | "computer_open_session" | "computer_observe" | "computer_act" | "computer_session_status" | "computer_close_session";
export const TOOLS: readonly ToolName[];
export type SessionMode = "observe" | "control";
export const SESSION_MODES: readonly SessionMode[];
export type ActionType = "click" | "double_click" | "right_click" | "move" | "drag" | "scroll" | "type" | "key" | "wait";
export const ACTION_TYPES: readonly ActionType[];
export const POINT_ACTIONS: readonly ActionType[];
export type Modifier = "ctrl" | "shift" | "alt" | "meta";
export const MODIFIERS: readonly Modifier[];
export const NAMED_KEYS: readonly string[];
export const KEY_ALIASES: Readonly<Record<string, string>>;
export const MODIFIER_ALIASES: Readonly<Record<string, Modifier>>;
export const NOT_ERROR_CODES: readonly string[];

export type Limits = {
  session_seconds: number;
  idle_pause_seconds: number;
  actions_per_session: number;
  actions_per_second: number;
  screenshots_per_chat: number;
  model_long_side: number;
  full_long_side: number;
  observation_ttl_seconds: number;
  approval_timeout_seconds: number;
  chat_approval_seconds: number;
  media_full_bytes: number;
  media_model_bytes: number;
};
export const DEFAULT_LIMITS: Readonly<Limits>;
export const LIMIT_RANGES: Readonly<Record<keyof Limits, [number, number]>>;
export const TEXT_MAX: number;
export const INTENT_MAX: number;
export const PURPOSE_MAX: number;
export const WAIT_MAX_MS: number;
export const DRAG_POINTS: readonly [number, number];
export const SCROLL_STEPS: number;
export const UNTRUSTED_SCREEN_TEXT: string;
export const INSTRUCTIONS: string;

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Bounds = { x: number; y: number; width: number; height: number };
export type Action =
  | { type: "click" | "double_click" | "right_click" | "move"; x: number; y: number; modifiers?: Modifier[] }
  | { type: "scroll"; x: number; y: number; delta: number; axis: "vertical" | "horizontal"; modifiers?: Modifier[] }
  | { type: "drag"; path: Point[]; modifiers?: Modifier[] }
  | { type: "type"; text: string }
  | { type: "key"; key: string; modifiers?: Modifier[] }
  | { type: "wait"; ms: number };

export type McpTool = { name: ToolName; description: string; inputSchema: Record<string, unknown> };
export type Invalid = { ok: false; code: string; message: string };

export function normalizeLimits(raw: unknown): Limits;
export function toolDefinitions(options?: { limits?: Partial<Limits> }): McpTool[];
export function canonicalKey(value: unknown): string | null;
export function canonicalModifiers(value: unknown): Modifier[] | null;
export function validateAction(action: unknown, size: Size | null | undefined): { ok: true; action: Action } | Invalid;
export function validateCall(name: string, args: unknown): { ok: true; args: Record<string, unknown> } | Invalid;
export function mapPoint(point: Point, observation: Size, bounds: Bounds): { model: Point; window: Point; screen: Point };
export function modelSize(width: number, height: number, longSide?: number): Size;

export type FrameRef = { sha256: string };
export type ObservationRef = {
  id: string;
  width: number;
  height: number;
  sha256: string;
  mime?: string;
  full?: { width: number; height: number; sha256: string };
  ocr?: "client" | "none";
  masked?: number;
};
export type WindowRef = {
  id?: string;
  app_id: string;
  app_name: string;
  bundle_or_exe: string;
  pid: number;
  title: string;
  origin?: Point;
  bounds?: Bounds;
};
export type ScreenRef = { id: string; width: number; height: number; scale: number };
export type ActResult = {
  ok: boolean;
  code?: string;
  message?: string;
  session_id?: string;
  request_id?: string;
  action?: Action;
  intent?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  cursor_before?: Point | null;
  cursor_after?: Point | null;
  may_have_acted: boolean;
  point?: { model: Point; screen: Point };
  path?: Array<{ model: Point; screen: Point }>;
  scale?: number;
  dpi?: number;
  monitor_id?: string;
  screen?: ScreenRef;
  window?: WindowRef;
  frame_before?: FrameRef;
  frame_after?: FrameRef;
  approval?: { asked: boolean; reasons?: string[]; by?: "person" | "rule" };
  observation?: ObservationRef;
  os?: string;
  next?: string;
};

export function failure(code: string, message: string, extra?: Record<string, unknown>): { ok: false; code: string; message: string } & Record<string, unknown>;
export function isFailure(result: unknown): boolean;
export function actResult(fields: Record<string, unknown>): ActResult;
export function observeResult(fields: Record<string, unknown>): Record<string, unknown>;
export function mcpResult(state: Record<string, unknown>, image?: { data: Uint8Array | string; mime?: string } | null): { content: Array<Record<string, unknown>>; isError: boolean };
export function parseResultText(text: unknown): Record<string, unknown> | null;
export function isComputerTool(name: unknown): boolean;
export function osName(platform?: string): string;
