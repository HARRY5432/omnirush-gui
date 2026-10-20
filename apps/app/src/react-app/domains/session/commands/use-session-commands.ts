import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { QueryKey } from "@tanstack/react-query";

import { toast } from "@/components/ui/sonner";
import { createClient, unwrap } from "@/app/lib/opencode";
import { createClientV2, isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";
import { abortSessionSafe, revertSession, unrevertSession } from "@/app/lib/opencode-session";
import type { OmniRushSessionMessage, OmniRushSessionSnapshot } from "@/app/lib/omnirush-server";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import {
  applySessionRevert,
  applySessionUnrevert,
  snapshotKey,
  statusKey,
  transcriptKey,
} from "@/react-app/domains/session/sync/session-sync";
import { getComposerDraft, useComposerStateStore } from "@/react-app/domains/session/surface/composer-state-store";
import { REDO_NOTICE, projectTracksFiles, undoNotice } from "./undo-notice";
import { commandTemplateLabel } from "./review-message";

export type SessionCommandTarget = {
  workspaceId: string;
  sessionId: string;
  opencodeBaseUrl: string;
  token: string;
  workspaceRoot: string;
};

export type OpencodeClient = ReturnType<typeof createClient>;

/** A query's cached data, read straight from the cache (never fetched or refetched from here). */
export function useCachedQueryData<T>(queryKey: QueryKey): T | undefined {
  const queryClient = getReactQueryClient();
  const subscribe = useCallback((listener: () => void) => queryClient.getQueryCache().subscribe(listener), [queryClient]);
  const hash = JSON.stringify(queryKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const read = useCallback(() => queryClient.getQueryData<T>(queryKey), [queryClient, hash]);
  return useSyncExternalStore(subscribe, read, read);
}

export function useOpencodeClient(target: Pick<SessionCommandTarget, "opencodeBaseUrl" | "token" | "workspaceRoot">): OpencodeClient {
  return useMemo(
    () => isOpencodeV2BaseUrl(target.opencodeBaseUrl)
      ? createClientV2(target.opencodeBaseUrl, target.workspaceRoot || undefined, { token: target.token })
      : createClient(target.opencodeBaseUrl, target.workspaceRoot.trim() || undefined, { token: target.token, mode: "omnirush" }),
    [target.opencodeBaseUrl, target.token, target.workspaceRoot],
  );
}

const role = (message: OmniRushSessionMessage) => (message.info as { role?: string }).role;

/** The messages the chat shows: those before its revert point (an undo hides the rest until redo). */
export function visibleMessages(snapshot: OmniRushSessionSnapshot | null | undefined): OmniRushSessionMessage[] {
  if (!snapshot) return [];
  const revertId = snapshot.session.revert?.messageID ?? null;
  return revertId ? snapshot.messages.filter((message) => message.info.id < revertId) : snapshot.messages;
}

/** The user message an undo rewinds to: the newest one the chat still shows. */
export function undoTarget(snapshot: OmniRushSessionSnapshot | null | undefined): OmniRushSessionMessage | null {
  return visibleMessages(snapshot).findLast((message) => role(message) === "user") ?? null;
}

/** The text a user message was sent with (what goes back into the composer after an undo). */
export function userMessageText(message: OmniRushSessionMessage | null): string {
  if (!message) return "";
  return message.parts
    .flatMap((part) => {
      const value = part as { type?: string; text?: string; synthetic?: boolean; ignored?: boolean };
      return value.type === "text" && !value.synthetic && !value.ignored && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n")
    .trim();
}

/** The newest user message's id (the "Last turn" of the Changes panel). */
export function latestUserMessageId(snapshot: OmniRushSessionSnapshot | null | undefined): string | null {
  return undoTarget(snapshot)?.info.id ?? null;
}

/** The chat's session and newest messages as the engine has them now (enough to find its last turn). */
async function freshSnapshot(client: OpencodeClient, sessionId: string): Promise<OmniRushSessionSnapshot> {
  const [session, messages] = await Promise.all([
    client.session.get({ sessionID: sessionId }).then((result) => unwrap(result)),
    client.session.messages({ sessionID: sessionId, limit: 400 }).then((result) => unwrap(result)),
  ]);
  return { session, messages, todos: [], status: { type: "idle" } } as unknown as OmniRushSessionSnapshot;
}

const trackedByRoot = new Map<string, boolean>();

async function tracksFiles(client: OpencodeClient, root: string): Promise<boolean> {
  const known = trackedByRoot.get(root);
  if (known !== undefined) return known;
  try {
    const project = unwrap(await client.project.current({ directory: root || undefined })) as { worktree?: string } | null;
    const tracked = projectTracksFiles(project);
    trackedByRoot.set(root, tracked);
    return tracked;
  } catch {
    // Unknown: say what the engine reported about the files.
    return true;
  }
}

/**
 * Undo of the last turn and its redo, for one chat: the engine rewinds the
 * chat to its newest user message and takes the turn's file changes back
 * (content-checked: the person's own edits are kept), and redo puts it back.
 */
export function useUndoRedo(target: SessionCommandTarget) {
  const client = useOpencodeClient(target);
  const snapshot = useCachedQueryData<OmniRushSessionSnapshot>(snapshotKey(target.workspaceId, target.sessionId));
  const status = useCachedQueryData<{ type: string }>(statusKey(target.workspaceId, target.sessionId));
  const [busyAction, setBusyAction] = useState<"undo" | "redo" | null>(null);
  const restoredTextRef = useRef<{ sessionId: string; text: string } | null>(null);
  const redoRef = useRef<() => Promise<void>>(async () => undefined);

  const current = snapshot?.session.id === target.sessionId ? snapshot : null;
  const transcript = useCachedQueryData<Array<{ role?: string }>>(transcriptKey(target.workspaceId, target.sessionId));
  const canUndo = (Boolean(undoTarget(current)) || Boolean(transcript?.some((message) => message.role === "user"))) && busyAction === null;
  const canRedo = Boolean(current?.session.revert?.messageID) && busyAction === null;
  const running = (status?.type ?? current?.status.type ?? "idle") !== "idle";

  const stopFirst = useCallback(async (source: string) => {
    if (!running) return;
    await abortSessionSafe(client, target.sessionId, target.workspaceRoot || undefined, {
      source,
      initiator: "user",
      reason: "abort active run before undo or redo",
    });
  }, [client, running, target.sessionId, target.workspaceRoot]);

  const redo = useCallback(async () => {
    if (busyAction) return;
    const queryClient = getReactQueryClient();
    setBusyAction("redo");
    try {
      const session = unwrap(await client.session.get({ sessionID: target.sessionId })) as { revert?: { messageID?: string } | null };
      if (!session?.revert?.messageID) return;
      await stopFirst("session.commands.redo");
      await unrevertSession(client, target.sessionId);
      applySessionUnrevert(target.workspaceId, target.sessionId);
      void queryClient.invalidateQueries({ queryKey: snapshotKey(target.workspaceId, target.sessionId) });
      // The text an undo put back goes away with the turn it belongs to.
      const restored = restoredTextRef.current;
      if (restored?.sessionId === target.sessionId) {
        const draft = getComposerDraft(useComposerStateStore.getState(), target.sessionId);
        if (draft.trim() === restored.text.trim()) useComposerStateStore.getState().replaceDraft(target.sessionId, "");
        restoredTextRef.current = null;
      }
      toast.success(REDO_NOTICE, { duration: 4000 });
    } catch (error) {
      toast.error(`Redo failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, client, stopFirst, target.sessionId, target.workspaceId]);
  redoRef.current = redo;

  const undo = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("undo");
    try {
      await stopFirst("session.commands.undo");
      // The engine's own view, not the screen's cache: the newest user message before its revert point.
      const message = undoTarget(await freshSnapshot(client, target.sessionId));
      if (!message) {
        toast.info("Nothing to undo yet", { duration: 3000 });
        return;
      }
      const reverted = await revertSession(client, target.sessionId, message.info.id);
      applySessionRevert(target.workspaceId, reverted);
      // The turn's prompt goes back into an empty composer (a draft being written is left alone).
      // A review or fix turn goes back as the command it was typed as, not its expanded prompt.
      const sent = userMessageText(message);
      const text = commandTemplateLabel(sent) ?? sent;
      const draft = getComposerDraft(useComposerStateStore.getState(), target.sessionId);
      if (text && !draft.trim()) {
        useComposerStateStore.getState().replaceDraft(target.sessionId, text);
        restoredTextRef.current = { sessionId: target.sessionId, text };
      }
      const tracked = await tracksFiles(client, target.workspaceRoot);
      const notice = undoNotice((reverted as { revert?: Parameters<typeof undoNotice>[0] } | null)?.revert, tracked);
      const show = notice.variant === "warning" ? toast.warning : toast.success;
      show(notice.title, {
        description: notice.message,
        duration: 9000,
        action: { label: "Redo", onClick: () => void redoRef.current() },
      });
    } catch (error) {
      toast.error(`Undo failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, client, stopFirst, target.sessionId, target.workspaceId, target.workspaceRoot]);

  return { client, snapshot: current, running, canUndo, canRedo, busyAction, undo, redo };
}
