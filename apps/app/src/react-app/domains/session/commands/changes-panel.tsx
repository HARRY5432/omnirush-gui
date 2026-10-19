/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileDiff, ListChecks, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { unwrap } from "@/app/lib/opencode";
import { cn } from "@/lib/utils";
import type { OmniRushSessionSnapshot } from "@/app/lib/omnirush-server";
import { snapshotKey, statusKey } from "@/react-app/domains/session/sync/session-sync";
import {
  CHANGES_EMPTY,
  CHANGES_SOURCE_LABEL,
  changeTotals,
  normalizeChanges,
  patchLines,
  type ChangedFile,
  type ChangesSource,
} from "./changes";
import { useSessionCommandBridge, useSessionCommandsStore } from "./session-commands-store";
import { latestUserMessageId, useCachedQueryData, useOpencodeClient, type SessionCommandTarget } from "./use-session-commands";

const SOURCES: ChangesSource[] = ["chat", "turn", "tree"];

const STATUS_BADGE: Record<ChangedFile["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
};

function DiffBody({ patch }: { patch: string }) {
  const lines = useMemo(() => patchLines(patch), [patch]);
  if (!lines.length) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">No line changes to show (a binary file, or only its mode changed).</div>;
  }
  return (
    <div className="max-h-[50vh] overflow-auto border-t border-border font-mono text-[11.5px] leading-[1.55]" data-testid="changes-diff">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            "flex min-w-max",
            line.kind === "add" && "bg-green-3/40 text-green-11",
            line.kind === "del" && "bg-red-3/40 text-red-11",
            line.kind === "hunk" && "bg-blue-2/40 text-blue-11",
            line.kind === "meta" && "text-muted-foreground",
          )}
        >
          <span className="w-10 shrink-0 select-none pr-1 text-right text-muted-foreground/70">{line.oldLine ?? ""}</span>
          <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/70">{line.newLine ?? ""}</span>
          <span className="w-3 shrink-0 select-none">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}</span>
          <span className="whitespace-pre pr-4">{line.kind === "hunk" ? line.text : line.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

function FileRow({ file, defaultOpen }: { file: ChangedFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background/60" data-testid="changes-file" data-path={file.path}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-muted/60"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold",
            file.status === "added" && "bg-green-4 text-green-11",
            file.status === "deleted" && "bg-red-4 text-red-11",
            file.status === "modified" && "bg-amber-4 text-amber-11",
          )}
          title={file.status}
        >
          {STATUS_BADGE[file.status]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{file.path}</span>
        <span className="shrink-0 font-mono text-[11.5px] text-green-11">+{file.additions}</span>
        <span className="shrink-0 font-mono text-[11.5px] text-red-11">-{file.deletions}</span>
      </button>
      {open ? <DiffBody patch={file.patch} /> : null}
    </div>
  );
}

/**
 * The Changes panel: the files this chat changed (or its last turn, or the
 * whole working tree), with +/- counts and each file's diff, and a Review
 * button that asks the agent to review them in the chat.
 */
export function ChangesPanel(props: SessionCommandTarget) {
  const openFor = useSessionCommandsStore((state) => state.changesOpenFor);
  const closeChanges = useSessionCommandsStore((state) => state.closeChanges);
  const open = openFor === props.sessionId;
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) closeChanges(); }}>
      <SheetContent side="right" className="w-[min(720px,92vw)] gap-0 data-[side=right]:sm:max-w-[720px]" data-testid="changes-panel">
        {open ? <ChangesBody {...props} onClose={closeChanges} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function ChangesBody(props: SessionCommandTarget & { onClose: () => void }) {
  const client = useOpencodeClient(props);
  const bridge = useSessionCommandBridge(props.sessionId);
  const [source, setSource] = useState<ChangesSource>("chat");
  const snapshot = useCachedQueryData<OmniRushSessionSnapshot>(snapshotKey(props.workspaceId, props.sessionId));
  const status = useCachedQueryData<{ type: string }>(statusKey(props.workspaceId, props.sessionId));
  const lastUserId = latestUserMessageId(snapshot?.session.id === props.sessionId ? snapshot : null);
  const revertId = snapshot?.session.revert?.messageID ?? null;
  const running = (status?.type ?? "idle") !== "idle";

  const query = useQuery({
    queryKey: ["session-commands-changes", props.workspaceId, props.sessionId, source, source === "turn" ? lastUserId : null, revertId],
    queryFn: async () => {
      if (source === "tree") {
        return normalizeChanges(unwrap(await client.vcs.diff({ mode: "git", directory: props.workspaceRoot || undefined })));
      }
      if (source === "turn") {
        if (!lastUserId) return [];
        return normalizeChanges(unwrap(await client.session.diff({ sessionID: props.sessionId, messageID: lastUserId })));
      }
      return normalizeChanges(unwrap(await client.session.diff({ sessionID: props.sessionId })));
    },
    staleTime: 2_000,
    retry: false,
  });

  // A turn that ends changes what this lists.
  const { refetch } = query;
  useEffect(() => {
    if (!running) void refetch();
  }, [running, refetch]);

  const files = query.data ?? [];
  const totals = changeTotals(files);
  const reviewDisabled = !bridge || bridge.busy || running;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader className="gap-3 border-b border-border p-4 pr-14">
        <div className="flex items-center gap-2">
          <FileDiff className="size-4 text-muted-foreground" />
          <SheetTitle>Changes</SheetTitle>
          <span className="text-xs text-muted-foreground" data-testid="changes-totals">
            {query.isSuccess
              ? `${totals.files} ${totals.files === 1 ? "file" : "files"} · +${totals.additions} -${totals.deletions}`
              : ""}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh"
              title="Refresh"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={cn("size-3.5", query.isFetching && "animate-spin")} />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="changes-review"
              disabled={reviewDisabled}
              title={running ? "Wait for the agent to finish first" : "Ask the agent to review the uncommitted changes in this chat"}
              onClick={() => {
                if (!bridge) return;
                void bridge.runCommand("/review");
                props.onClose();
              }}
            >
              <ListChecks className="size-3.5" />
              Review
            </Button>
          </div>
        </div>
        <SheetDescription className="sr-only">The files this chat changed and their diffs.</SheetDescription>
        <div className="flex w-fit items-center gap-0.5 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Changes source">
          {SOURCES.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={source === item}
              data-testid={`changes-source-${item}`}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                source === item && "bg-background text-foreground shadow-sm",
              )}
              onClick={() => setSource(item)}
            >
              {CHANGES_SOURCE_LABEL[item]}
            </button>
          ))}
        </div>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {query.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading changes…</div>
        ) : query.isError ? (
          <div className="text-sm text-muted-foreground" data-testid="changes-error">
            {source === "tree"
              ? "The working tree's changes could not be read (is this folder a git repository?)."
              : "The changes could not be read."}
          </div>
        ) : files.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid="changes-empty">
            {CHANGES_EMPTY[source]}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {files.map((file) => (
              <FileRow key={`${source}:${file.path}`} file={file} defaultOpen={files.length <= 3} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
