/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDownToLine,
  FileDiff,
  GitBranch,
  GitMerge,
  Layers,
  MessageSquare,
  Plus,
  Square,
  Trash2,
} from "lucide-react";

import type { OmniRushWorkspaceTask } from "@/app/lib/omnirush-server";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { cn } from "@/lib/utils";
import { isTaskActive, useWorkspaceTasks, workspaceTasksQueryKey, type WorkspaceTasksClient } from "./workspace-tasks-query";

export type TasksBoardPageProps = {
  client: WorkspaceTasksClient | null;
  /** The workspace the board belongs to (a task's own workspace shows its repository's board). */
  workspaceId: string;
  workspaceName: string;
  /** Creates the task and sends its prompt in its own chat, like the composer. */
  onStartTask: (prompt: string) => Promise<OmniRushWorkspaceTask>;
  onOpenChat: (workspaceId: string, sessionId: string | null) => void;
  /** The workspace list changed (a task's workspace was added or removed). */
  onWorkspacesChanged: () => void;
};

type PendingAction = { kind: "apply" | "merge" | "remove"; task: OmniRushWorkspaceTask };
type Changes = { task: OmniRushWorkspaceTask; stat: string; reply: string };

const STATE_STYLE: Record<OmniRushWorkspaceTask["state"], { dot: string; text: string }> = {
  created: { dot: "bg-blue-9 animate-pulse", text: "Starting" },
  running: { dot: "bg-blue-9 animate-pulse", text: "Running" },
  done: { dot: "bg-green-9", text: "Done" },
  failed: { dot: "bg-red-9", text: "Failed" },
  stopped: { dot: "bg-muted-foreground", text: "Stopped" },
  applied: { dot: "bg-green-9", text: "Applied here" },
  merged: { dot: "bg-violet-9", text: "Merged" },
  missing: { dot: "bg-amber-9", text: "Folder missing" },
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  return typeof error.code === "string" ? error.code : "";
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function TasksBoardPage(props: TasksBoardPageProps) {
  const queryClient = useQueryClient();
  const tasksQuery = useWorkspaceTasks(props.client, props.workspaceId);
  const [newOpen, setNewOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ title: string; message: string } | null>(null);
  const [changes, setChanges] = useState<Changes | null>(null);

  // The command palette's "New parallel task…" opens the board with ?new=1.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    setNewOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: workspaceTasksQueryKey(props.workspaceId) });

  const start = async () => {
    const text = prompt.trim();
    if (!text || starting) return;
    setStarting(true);
    try {
      const task = await props.onStartTask(text);
      setPrompt("");
      setNewOpen(false);
      toast.success("Task started in its own copy of the repository", task.startedDirty ? { description: dirtyNote(task) } : undefined);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setStarting(false);
      void refresh();
    }
  };

  const act = async (task: OmniRushWorkspaceTask, kind: "apply" | "merge" | "remove" | "stop") => {
    const client = props.client;
    if (!client) return;
    setBusyTaskId(task.id);
    try {
      if (kind === "stop") {
        await client.stopWorkspaceTask(props.workspaceId, task.id);
        toast.success("Task stopped");
      } else if (kind === "remove") {
        await client.removeWorkspaceTask(props.workspaceId, task.id);
        props.onWorkspacesChanged();
        toast.success("Task removed");
      } else {
        const done = await client.bringBackWorkspaceTask(props.workspaceId, task.id, kind);
        toast.success(kind === "apply"
          ? `Applied ${plural(done.files.length, "file")} to ${tasksQuery.data?.branch ?? "this checkout"} (not committed)`
          : `Merged ${task.branch} (${plural(done.files.length, "file")})`);
      }
    } catch (error) {
      const code = errorCode(error);
      if (code === "task_conflict" || code === "task_no_changes" || code === "task_commit_failed") {
        setConflict({
          title: code === "task_no_changes" ? "Nothing to bring back" : kind === "merge" ? "The merge did not go through" : "The changes do not apply",
          message: `${errorMessage(error)} Your checkout was left exactly as it was.`,
        });
      } else {
        toast.error(errorMessage(error));
      }
    } finally {
      setBusyTaskId(null);
      void refresh();
    }
  };

  const viewChanges = async (task: OmniRushWorkspaceTask) => {
    if (!props.client) return;
    try {
      const shown = await props.client.showWorkspaceTask(props.workspaceId, task.id);
      setChanges({ task: shown.task, stat: shown.stat, reply: shown.reply });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const list = tasksQuery.data;
  const tasks = list?.tasks ?? [];
  const runningCount = tasks.filter(isTaskActive).length;
  const canStart = Boolean(list?.git && list.hasCommit);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-6" data-testid="tasks-board">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">Parallel tasks</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each task works in its own copy of {list?.repo ?? props.workspaceName} (a git worktree on its own branch), so several can run at once
            without touching your files. Bring a result back when it is done.
          </p>
        </div>
        <Button onClick={() => setNewOpen(true)} disabled={!canStart} data-testid="tasks-new">
          <Plus /> New parallel task
        </Button>
      </div>

      {tasksQuery.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2" role="status" aria-label="Loading tasks">
          <Skeleton className="h-36 rounded-2xl" />
          <Skeleton className="h-36 rounded-2xl" />
        </div>
      ) : tasksQuery.error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Tasks unavailable</AlertTitle>
          <AlertDescription>{errorMessage(tasksQuery.error)}</AlertDescription>
        </Alert>
      ) : !list?.git || !list.hasCommit ? (
        <Empty className="rounded-2xl border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon"><GitBranch /></EmptyMedia>
            <EmptyTitle>{!list?.git ? "Parallel tasks need a git repository" : "Commit once to start tasks"}</EmptyTitle>
            <EmptyDescription>
              {!list?.git
                ? "This folder is not in a git repository. Tasks run in separate copies of a repository, so open a project that uses git (or run git init and make a first commit)."
                : "The repository has no commit yet. Each task starts from your latest commit, so make one first."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : tasks.length === 0 ? (
        <Empty className="rounded-2xl border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Layers /></EmptyMedia>
            <EmptyTitle>No tasks yet</EmptyTitle>
            <EmptyDescription>
              Start a task to let the agent work on something in the background while you keep working here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => setNewOpen(true)}><Plus /> New parallel task</Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {runningCount ? `${plural(runningCount, "task")} running` : "No task is running"}
            {list.branch ? ` · results come back into ${list.branch}` : ""}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                busy={busyTaskId === task.id}
                onOpenChat={() => task.workspaceId && props.onOpenChat(task.workspaceId, task.sessionId)}
                onViewChanges={() => void viewChanges(task)}
                onApply={() => setPending({ kind: "apply", task })}
                onMerge={() => setPending({ kind: "merge", task })}
                onStop={() => void act(task, "stop")}
                onRemove={() => setPending({ kind: "remove", task })}
              />
            ))}
          </div>
        </>
      )}

      <Dialog open={newOpen} onOpenChange={(open) => { if (!starting) setNewOpen(open); }}>
        <DialogContent className="w-full max-w-lg sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New parallel task</DialogTitle>
            <DialogDescription>
              Runs in a new copy of {list?.repo ?? props.workspaceName} on its own branch, starting from your latest commit
              {list?.branch ? ` on ${list.branch}` : ""}. Uncommitted changes here are not part of it.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            value={prompt}
            placeholder="What should the agent do? For example: add input validation to the signup form"
            className="min-h-28"
            data-testid="tasks-new-prompt"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void start();
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)} disabled={starting}>Cancel</Button>
            <Button onClick={() => void start()} disabled={!prompt.trim() || starting} data-testid="tasks-new-start">
              {starting ? "Starting…" : "Start task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        open={pending !== null}
        variant={pending?.kind === "remove" ? "danger" : "warning"}
        title={pending?.kind === "apply" ? "Apply the changes here?" : pending?.kind === "merge" ? "Merge the task's branch?" : "Remove this task?"}
        message={pending ? confirmMessage(pending, list?.branch ?? null) : ""}
        confirmLabel={pending?.kind === "apply" ? "Apply here" : pending?.kind === "merge" ? "Merge" : isTaskActive(pending?.task ?? { state: "done" }) ? "Stop and remove" : "Remove"}
        cancelLabel="Cancel"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const next = pending;
          setPending(null);
          if (next) void act(next.task, next.kind);
        }}
      />

      <Dialog open={conflict !== null} onOpenChange={(open) => { if (!open) setConflict(null); }}>
        <DialogContent className="w-full max-w-md sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{conflict?.title}</DialogTitle>
            <DialogDescription>{conflict?.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <Dialog open={changes !== null} onOpenChange={(open) => { if (!open) setChanges(null); }}>
        <DialogContent className="w-full max-w-2xl sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{changes?.task.title}</DialogTitle>
            <DialogDescription>{changes ? `${changes.task.branch} · ${STATE_STYLE[changes.task.state].text}` : ""}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Files changed</div>
              <pre className="max-h-56 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-5 whitespace-pre" data-testid="tasks-changes-stat">
                {changes?.stat || (changes && isTaskActive(changes.task) ? "Shown when the task finishes." : "No changes.")}
              </pre>
            </div>
            {changes?.reply ? (
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Last reply</div>
                <p className="max-h-48 overflow-auto rounded-lg border p-3 text-sm whitespace-pre-wrap">{changes.reply}</p>
              </div>
            ) : null}
          </div>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function dirtyNote(task: Pick<OmniRushWorkspaceTask, "baseCommit">): string {
  return `It starts from the last commit (${task.baseCommit.slice(0, 7)}); your uncommitted changes are not in it.`;
}

function confirmMessage(pending: PendingAction, branch: string | null): string {
  const into = branch ? ` (${branch})` : "";
  if (pending.kind === "apply") {
    return `The task's changes are written into your checkout${into} as uncommitted edits, for you to review and commit. If they clash with your own edits nothing is changed.`;
  }
  if (pending.kind === "merge") {
    return `The task's changes are committed on ${pending.task.branch}, which is merged into your current branch${into}. If the merge conflicts it is undone and nothing changes.`;
  }
  return `Its folder and branch ${pending.task.branch} are deleted, with any changes that were not brought back. Its chat stays in your history.`;
}

type TaskCardProps = {
  task: OmniRushWorkspaceTask;
  busy: boolean;
  onOpenChat: () => void;
  onViewChanges: () => void;
  onApply: () => void;
  onMerge: () => void;
  onStop: () => void;
  onRemove: () => void;
};

function TaskCard({ task, busy, ...actions }: TaskCardProps) {
  const style = STATE_STYLE[task.state];
  const active = isTaskActive(task);
  const canBringBack = task.finished && (task.files ?? 0) > 0;
  return (
    <div
      className={cn("flex flex-col gap-3 rounded-2xl border border-dls-border bg-dls-card p-4 shadow-[var(--dls-card-shadow)]", busy && "opacity-70")}
      data-testid="task-card"
      data-task-state={task.state}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-dls-text" title={task.prompt}>{task.title}</div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate font-mono" title={task.path}>{task.branch}</span>
          </div>
        </div>
        <Badge variant="outline" className="shrink-0 gap-1.5" data-testid="task-state">
          <span className={cn("size-1.5 rounded-full", style.dot)} aria-hidden="true" />
          {style.text}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span data-testid="task-files">{task.files === null ? "Files: unknown" : plural(task.files, "file") + " changed"}</span>
        {task.age ? <span>Started {task.age}</span> : null}
        {task.result ? <span>{task.result.mode === "apply" ? "Applied" : "Merged"} {plural(task.result.files, "file")}</span> : null}
      </div>
      {task.startedDirty && !task.result ? <p className="text-xs text-muted-foreground" data-testid="task-dirty-note">{dirtyNote(task)}</p> : null}
      <div className="mt-auto flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" onClick={actions.onOpenChat} disabled={!task.workspaceId || !task.sessionId}>
          <MessageSquare /> Open chat
        </Button>
        <Button size="sm" variant="outline" onClick={actions.onViewChanges} disabled={busy}>
          <FileDiff /> View changes
        </Button>
        {active ? (
          <Button size="sm" variant="outline" onClick={actions.onStop} disabled={busy}>
            <Square /> Stop
          </Button>
        ) : null}
        {task.finished ? (
          <>
            <Button size="sm" variant="outline" onClick={actions.onApply} disabled={busy || !canBringBack} data-testid="task-apply">
              <ArrowDownToLine /> Apply here
            </Button>
            <Button size="sm" variant="outline" onClick={actions.onMerge} disabled={busy || !canBringBack} data-testid="task-merge">
              <GitMerge /> Merge
            </Button>
          </>
        ) : null}
        <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={actions.onRemove} disabled={busy} aria-label="Remove task" data-testid="task-remove">
          <Trash2 /> Remove
        </Button>
      </div>
    </div>
  );
}
