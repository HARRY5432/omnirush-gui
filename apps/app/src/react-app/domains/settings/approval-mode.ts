// Shared approval-mode state. The Settings > General "Permissions" card and the
// composer's permissions menu both read it through useApprovalMode, so they
// show the same mode and a change in either updates the other at once.
// State is keyed by server (client.baseUrl): the mode is a server-wide setting,
// not a workspace one, and a remote workspace talks to a different server.
import { useCallback, useEffect } from "react";
import { create } from "zustand";

import type { OmniRushApprovalMode, OmniRushRuntimeApprovals, OmniRushServerClient } from "@/app/lib/omnirush-server";
import { t } from "@/i18n";
import { reloadEngineWithDesktopFallback } from "@/react-app/shell/engine-reload-escalation";

export type ApprovalsClient = Pick<OmniRushServerClient, "getRuntimeApprovals" | "setRuntimeApprovals" | "reloadEngine"> & {
  /** Keys the shared state; clients without one share a single entry. */
  baseUrl?: string;
};

/** The modes in the order the app lists them. Stored values: careful, guarded (Normal), full (Auto). */
export const APPROVAL_MODES: readonly OmniRushApprovalMode[] = ["careful", "guarded", "full"];

/**
 * Title and summary of a mode. The summaries are the `labels` of the rules
 * file shared with the CLI (apps/server/src/permissions/permission-modes.json).
 */
export function approvalModeLabel(mode: OmniRushApprovalMode): { title: string; summary: string } {
  switch (mode) {
    case "careful":
      return { title: t("permissions.mode.careful"), summary: t("permissions.mode.careful_summary") };
    case "full":
      return { title: t("permissions.mode.auto"), summary: t("permissions.mode.auto_summary") };
    default:
      return { title: t("permissions.mode.normal"), summary: t("permissions.mode.normal_summary") };
  }
}

export const FULL_PERMISSIONS_HELP = "Runs every command and edits files without asking. Organisation policies still apply.";

/** Shown while OMNIRUSH_APPROVALS in the launch environment forces the mode. */
export function approvalsEnvironmentHint(approvals: OmniRushRuntimeApprovals): string | null {
  if (approvals.source !== "environment") return null;
  return `Set by environment (OMNIRUSH_APPROVALS=${approvals.mode}); change it where the app is launched.`;
}

export type FullPermissionsOutcome = {
  approvals: OmniRushRuntimeApprovals;
  status: string;
  /** "success" once the engine reloaded; "warning" when the setting is saved but the engine still needs a reload. */
  tone: "success" | "warning";
};

/**
 * Persist the approval mode, then reload the engine the way Settings "Reload"
 * does (a manual reload bypasses the fingerprint guard) so the new permission
 * rules apply within seconds. A failed reload keeps the saved setting and says
 * what to do next.
 */
export async function applyApprovalMode(
  client: ApprovalsClient,
  workspaceId: string | null,
  requested: OmniRushApprovalMode,
): Promise<FullPermissionsOutcome> {
  const { mode, source, setting } = await client.setRuntimeApprovals(requested);
  const approvals: OmniRushRuntimeApprovals = { mode, source, setting };
  const label = t("permissions.status_mode", { mode: approvalModeLabel(mode).title });
  if (!workspaceId) return { approvals, status: `${label} ${t("permissions.status_reload_needed")}`, tone: "warning" };
  try {
    await reloadEngineWithDesktopFallback(client, workspaceId);
    return { approvals, status: `${label} ${t("permissions.status_reloaded")}`, tone: "success" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { approvals, status: `${label} ${t("permissions.status_reload_failed", { reason })}`, tone: "warning" };
  }
}

/** Earlier on/off form: on is Auto, off is Normal. */
export function applyFullPermissions(
  client: ApprovalsClient,
  workspaceId: string | null,
  enabled: boolean,
): Promise<FullPermissionsOutcome> {
  return applyApprovalMode(client, workspaceId, enabled ? "full" : "guarded");
}

export type ApprovalModeEntry = {
  /** Null until the server has answered (or while the load keeps failing). */
  approvals: OmniRushRuntimeApprovals | null;
  /** True while a change persists and the engine reloads. */
  busy: boolean;
  /** The last load or change result, or the error to act on. */
  status: string;
};

const EMPTY_ENTRY: ApprovalModeEntry = { approvals: null, busy: false, status: "" };

type ApprovalModeStore = {
  byServer: Record<string, ApprovalModeEntry>;
  patch: (key: string, patch: Partial<ApprovalModeEntry>) => void;
};

export const useApprovalModeStore = create<ApprovalModeStore>((set) => ({
  byServer: {},
  patch: (key, patch) =>
    set((state) => ({
      byServer: { ...state.byServer, [key]: { ...(state.byServer[key] ?? EMPTY_ENTRY), ...patch } },
    })),
}));

export function approvalModeKey(client: ApprovalsClient): string {
  return client.baseUrl?.trim() || "default";
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const inflightLoads = new Map<string, Promise<void>>();
// Bumped whenever a change starts so a load that began before the change
// cannot overwrite the new mode with the value it fetched earlier.
const changeSequence = new Map<string, number>();

/** Record that a change is starting so earlier in-flight loads are ignored. */
export function markApprovalChange(key: string): void {
  changeSequence.set(key, (changeSequence.get(key) ?? 0) + 1);
}

/** Fetch the mode; components mounting at the same time share one request. */
export function loadApprovalMode(client: ApprovalsClient): Promise<void> {
  const key = approvalModeKey(client);
  const pending = inflightLoads.get(key);
  if (pending) return pending;
  const { patch } = useApprovalModeStore.getState();
  const startedAt = changeSequence.get(key) ?? 0;
  const task = client.getRuntimeApprovals()
    .then((approvals) => {
      const stale = (changeSequence.get(key) ?? 0) !== startedAt || useApprovalModeStore.getState().byServer[key]?.busy;
      if (!stale) patch(key, { approvals });
    })
    .catch((error: unknown) => patch(key, { status: messageOf(error, "The approval mode could not be loaded.") }))
    .finally(() => {
      inflightLoads.delete(key);
    });
  inflightLoads.set(key, task);
  return task;
}

export type ApprovalModeChange = {
  approvals: OmniRushRuntimeApprovals | null;
  status: string;
  tone: "success" | "warning" | "error";
};

/**
 * The approval mode of the server behind `client`, loaded on mount, and the
 * action that changes it. `workspaceId` names the engine to reload afterwards;
 * without one the setting is saved and the status asks for a reload.
 */
export function useApprovalMode(client: ApprovalsClient | null, workspaceId: string | null) {
  const key = client ? approvalModeKey(client) : null;
  const entry = useApprovalModeStore((state) => (key ? state.byServer[key] : undefined)) ?? EMPTY_ENTRY;

  useEffect(() => {
    if (!client) return;
    void loadApprovalMode(client);
  }, [client]);

  const setApprovalMode = useCallback(async (mode: OmniRushApprovalMode): Promise<ApprovalModeChange | null> => {
    if (!client || !key) return null;
    const { patch } = useApprovalModeStore.getState();
    markApprovalChange(key);
    patch(key, { busy: true, status: t("permissions.status_switching", { mode: approvalModeLabel(mode).title }) });
    try {
      const outcome = await applyApprovalMode(client, workspaceId, mode);
      patch(key, { approvals: outcome.approvals, busy: false, status: outcome.status });
      return outcome;
    } catch (error) {
      const status = messageOf(error, "The approval mode could not be saved.");
      patch(key, { busy: false, status });
      return { approvals: useApprovalModeStore.getState().byServer[key]?.approvals ?? null, status, tone: "error" };
    }
  }, [client, key, workspaceId]);

  /** Earlier on/off form: on is Auto, off is Normal. */
  const setFullPermissions = useCallback(
    (enabled: boolean) => setApprovalMode(enabled ? "full" : "guarded"),
    [setApprovalMode],
  );

  return { approvals: entry.approvals, busy: entry.busy, status: entry.status, setApprovalMode, setFullPermissions };
}
