/**
 * Approval mode of the desktop engine.
 *
 *   careful  ("Careful" in the app) asks before every file change, every
 *            command and every MCP tool; reading and searching run freely.
 *   guarded  ("Normal", the default) asks only before risky actions: the
 *            shared rules (permissions/permission-modes.json, the same file
 *            as the CLI's) plus the git workflow rules.
 *   full     ("Auto") every engine permission is allowed without a prompt;
 *            the organization's deny rules from Den still apply.
 *
 * The stored values stay "guarded" and "full" so settings saved by earlier
 * versions keep their meaning; "normal" and "auto" are accepted as aliases.
 *
 * Precedence, highest first: OMNIRUSH_APPROVALS=careful|guarded|full in the server
 * (desktop) process environment, then the user setting persisted in the
 * global runtime config row, then guarded. The server resolves the mode; the
 * managed-policy engine plugin learns it from every /managed-policy/evaluate
 * answer, so a toggle applies to the next tool call without an engine restart
 * (the injected permission rules still need the reload Settings triggers).
 *
 * Shared by the server and the engine plugins (imported with "../"), so it
 * must stay free of server-only dependencies.
 */
export type ApprovalMode = "careful" | "guarded" | "full";
export type ApprovalModeSource = "environment" | "settings" | "default";

export const APPROVAL_MODE_ENV = "OMNIRUSH_APPROVALS";
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "guarded";

export interface ResolvedApprovalMode {
  mode: ApprovalMode;
  source: ApprovalModeSource;
  /** The persisted user setting, whether or not the environment overrides it. */
  setting: ApprovalMode | null;
}

export function parseApprovalMode(value: unknown): ApprovalMode | null {
  if (typeof value !== "string") return null;
  const mode = value.trim().toLowerCase();
  if (mode === "careful" || mode === "guarded" || mode === "full") return mode;
  if (mode === "normal") return "guarded";
  if (mode === "auto") return "full";
  return null;
}

export function approvalModeFromEnv(env: NodeJS.ProcessEnv = process.env): ApprovalMode | null {
  return parseApprovalMode(env[APPROVAL_MODE_ENV]);
}

export function resolveApprovalMode(
  runtime: { approvals?: { mode: ApprovalMode } },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedApprovalMode {
  const setting = runtime.approvals?.mode ?? null;
  const environment = approvalModeFromEnv(env);
  if (environment) return { mode: environment, source: "environment", setting };
  if (setting) return { mode: setting, source: "settings", setting };
  return { mode: DEFAULT_APPROVAL_MODE, source: "default", setting };
}

/**
 * The capture setup record's permission settings for a mode: Careful and
 * Normal name it as `permission_mode`; Auto adds nothing, so its record stays
 * what earlier versions sent (the CLI's permissionSetupSettings does the same).
 */
export function permissionSetupSettings(mode: ApprovalMode | null | undefined): Record<string, unknown> {
  if (mode === "careful") return { permission_mode: "careful" };
  if (mode === "guarded") return { permission_mode: "normal" };
  return {};
}
