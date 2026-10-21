// Types of policy.mjs (the same files in omnirush-cli src/computer-use/ and
// omnirush-gui apps/server/src/computer-use/shared/; PARITY.sha256).
import type { Action, Limits } from "./contract.mjs";

export type PermissionMode = "careful" | "normal" | "auto";
export const PERMISSION_MODES: readonly PermissionMode[];
export const CLIENTS: readonly ("cli" | "desktop")[];
export const OFF_MESSAGE: string;

export type DenyEntry = { match: string; reason: string | null };
export type ComputerUseBlock = {
  enabled: boolean;
  clients: string[] | null;
  os: string[] | null;
  models: string[] | null;
  real_screen: boolean;
  virtual_display: boolean;
  deny_apps: DenyEntry[];
  limits: Limits;
  message: string | null;
};
export type ComputerUseSetting = ComputerUseBlock & {
  source: "env" | "server" | "default";
  reason: null | "env" | "no_switch" | "off" | "client" | "os" | "no_display";
};

export function normalizeComputerUse(block: unknown): ComputerUseBlock;
export function computerUseSetting(options?: { env?: Record<string, string | undefined>; block?: unknown; client?: "cli" | "desktop"; platform?: string }): ComputerUseSetting;
export function modelAllowed(setting: ComputerUseSetting | ComputerUseBlock | null | undefined, modelId: unknown): boolean;
export function offMessage(setting: { message?: string | null } | null | undefined): string;

export const DENIED_APPS: Readonly<Record<"self" | "terminal" | "password_manager" | "credentials" | "lock_screen", readonly string[]>>;
export const SETTINGS_APPS: readonly string[];
export const SECURITY_PANE: RegExp;
export const AGENT_HOSTS: readonly string[];

export type AppIdentity = { pid?: number; name?: string; app_name?: string; exe?: string; executable?: string; bundle_id?: string; bundle_or_exe?: string; app_id?: string; title?: string };
export type ProcessInfo = { pid: number; name: string; exe: string };
export type DenyContext = {
  ancestors?: ProcessInfo[];
  tty_pids?: number[];
  self_pids?: number[];
  deny_apps?: Array<DenyEntry | string>;
  secure_input?: boolean;
};
export type Denial = { code: "protected_app"; category: string; reason: string };

export function appNames(app: AppIdentity): Set<string>;
export function deniedApp(app: AppIdentity, ctx?: DenyContext): Denial | null;
export function readAncestors(options?: { pid?: number; platform?: string; limit?: number }): ProcessInfo[];
export function nestedAgent(options?: { env?: Record<string, string | undefined>; ancestors?: ProcessInfo[] }): boolean;

export const RISKY_WORDS: readonly string[];
export function riskyWords(value: unknown, from?: "screen" | "intent"): string[];
export function looksLikeCredential(value: unknown): boolean;
export const ASK_SEND_DELETE: boolean;

export type AskReasonCode = "careful" | "risky_intent" | "risky_target" | "secure_field" | "credential_text" | "credential_intent" | "other_window" | "risky_page" | "send_delete_target" | "delete_chord" | "send_after_typing";
export type ApprovalInput = {
  mode?: PermissionMode | string;
  action?: Action | Record<string, unknown>;
  intent?: string;
  target?: { text?: string; secure?: boolean };
  window?: { id?: string | number; app_id?: string; title?: string };
  approved?: { window_id?: string | number; app_id?: string };
  /** The agent's previous act in this window typed text (and no click or Enter since). */
  typed_before?: boolean;
};
export function actApproval(input?: ApprovalInput, options?: { sendDelete?: boolean }): { ask: boolean; reasons: Array<{ code: AskReasonCode; detail?: string }> };
export const ASK_REASONS: Readonly<Record<AskReasonCode, string>>;
export const SCREEN_BASH_RULES: Readonly<Record<string, "ask">>;
export function computerPermissionRules(): Record<string, "allow">;
export function subagentPermissionRules(): Record<string, "deny">;
