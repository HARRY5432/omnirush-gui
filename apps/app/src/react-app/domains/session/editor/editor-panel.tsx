/** @jsxImportSource react */
/**
 * The desktop editor beside the chat: file tree, tabs, Monaco, the agent's
 * changes for review (accept/reject per hunk), a git panel, quick open and
 * the integrated terminal. Loaded lazily (editor-entry.tsx) so the chat
 * never pays for Monaco until the editor is opened.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleDot,
  FileCode2,
  FileDiff,
  Files,
  GitBranch,
  GitCommitHorizontal,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  Undo2,
  X,
} from "lucide-react";

import type { Client } from "@/app/types";
import type { OmniRushEditorGitFile, OmniRushEditorGitStatus, OmniRushServerClient } from "@/app/lib/omnirush-server";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { onFilesRewound } from "@/app/lib/files-rewound";
import { editorDocuments, type EditorDocuments, type FileDoc } from "./editor-models";
import { editorWorkspaceState, tabId, useEditorStore, type EditorSideView, type EditorTab, type ReviewScope } from "./editor-store";
import { EditorSurface, type SurfaceDoc } from "./editor-surface";
import { acceptHunk, hunkCounts, rejectHunk, type LineHunk } from "./hunk-ops";
import { languageForPath, setupMonaco, type Monaco } from "./monaco";
import { QuickOpen } from "./quick-open";
import { baselinesForTurns, turnFileChange, type TurnFileChange } from "./review";
import "./editor.css";

export type EditorPanelProps = {
  client: OmniRushServerClient;
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string | null;
  sessionBusy: boolean;
  opencodeClient: Client | null;
  terminal: ReactNode | null;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  /** IDE layout slots: the header's left (mode toggle, workspace switch) and right (chat panel button), and the rail's foot (app destinations). */
  headerStart?: ReactNode;
  headerEnd?: ReactNode;
  railFoot?: ReactNode;
};

const MAX_REVIEW_FILES = 60;
const MAX_REVIEW_TURNS = 30;
const EMPTY_FILES: string[] = [];

type ReviewFile = TurnFileChange & {
  /** The file before the reviewed turns; null when the turns created it; undefined when it could not be worked out. */
  baseline: string | null | undefined;
  /** The file on disk when the review loaded (null: not there), for files without an open document. */
  current: string | null;
};

type ReviewData = { key: string; turns: number; files: ReviewFile[] };

/** The engine's per-turn changes for the chat, oldest first, with each file's text before them. */
async function loadAgentChanges(input: {
  opencodeClient: Client;
  sessionId: string;
  directory: string;
  scope: ReviewScope;
  docs: EditorDocuments;
  workspaceRoot: string;
}): Promise<ReviewData> {
  const { opencodeClient, sessionId, directory, scope, docs } = input;
  const messagesResult = await opencodeClient.session.messages({ sessionID: sessionId, directory });
  const messages = (messagesResult.data ?? []) as Array<{ info: { id: string; role: string } }>;
  const userIds = messages.filter((message) => message.info.role === "user").map((message) => message.info.id);
  const root = input.workspaceRoot.replace(/[/\\]+$/, "").replace(/\\/g, "/");
  const relativeChange = (change: TurnFileChange): TurnFileChange | null => {
    let path = change.path;
    if (root && path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
    if (/^([A-Za-z]:)?\//.test(path) || path.split("/").includes("..")) return null;
    return { ...change, path };
  };
  const turns: TurnFileChange[][] = [];
  const turnIds: string[] = [];
  // Newest first until the scope is filled: the last turn that changed files, or every turn of the chat.
  for (const id of [...userIds].reverse().slice(0, MAX_REVIEW_TURNS)) {
    const result = await opencodeClient.session.diff({ sessionID: sessionId, messageID: id, directory });
    const changes = ((result.data ?? []) as unknown[])
      .map(turnFileChange)
      .filter((change): change is TurnFileChange => change !== null)
      .map(relativeChange)
      .filter((change): change is TurnFileChange => change !== null);
    if (changes.length === 0) continue;
    turns.unshift(changes);
    turnIds.unshift(id);
    if (scope === "turn") break;
  }
  const paths = [...new Set(turns.flat().map((change) => change.path))].slice(0, MAX_REVIEW_FILES);
  // "Before" is worked out from the text on disk, never from an open buffer (it may hold unsaved
  // edits, or the text from before the turn until it refreshes).
  const current = new Map<string, string | null>();
  const unreadable = new Set<string>();
  await Promise.all(paths.map(async (path) => {
    try {
      const file = await docs.client.editorReadFile(docs.workspaceId, path);
      if (file.content === null) unreadable.add(path);
      else current.set(path, file.content);
    } catch (error) {
      if ((error as { status?: number }).status === 404) current.set(path, null);
      else unreadable.add(path);
    }
  }));
  await docs.refresh(paths.filter((path) => docs.get(path)));
  const baselines = baselinesForTurns(turns, (path) => current.get(path) ?? null);
  // Binary or very large files are listed without a review diff.
  for (const path of unreadable) baselines.set(path, undefined);
  const merged = new Map<string, ReviewFile>();
  for (const turn of turns) {
    for (const change of turn) {
      if (!paths.includes(change.path)) continue;
      const previous = merged.get(change.path);
      const status = previous?.status === "added" && change.status !== "deleted" ? "added" : change.status;
      merged.set(change.path, {
        ...change,
        status,
        additions: (previous?.additions ?? 0) + change.additions,
        deletions: (previous?.deletions ?? 0) + change.deletions,
        baseline: baselines.get(change.path),
        current: current.get(change.path) ?? null,
      });
    }
  }
  return { key: `${sessionId}:${scope}:${turnIds.join(",")}`, turns: turns.length, files: [...merged.values()] };
}

const REVIEWED_KEY = "omnirush:editor:reviewed:v1";
const MAX_REVIEWED = 500;

function textHash(text: string): string {
  // FNV-1a, 32 bit, with the length: enough to tell "the text that was reviewed" from an edit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}.${hash.toString(36)}`;
}

function readReviewed(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(REVIEWED_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function isReviewed(reviewKey: string, path: string, text: string): boolean {
  return readReviewed()[`${reviewKey}|${path}`] === textHash(text);
}

function markReviewed(reviewKey: string, path: string, text: string): void {
  const all = readReviewed();
  const key = `${reviewKey}|${path}`;
  const hash = textHash(text);
  if (all[key] === hash) return;
  delete all[key];
  all[key] = hash;
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_REVIEWED))) delete all[old];
  try {
    localStorage.setItem(REVIEWED_KEY, JSON.stringify(all));
  } catch {
    // Storage full: the review just shows again after a restart.
  }
}

function gitBadge(file: OmniRushEditorGitFile, staged: boolean): string {
  const letter = staged ? file.index : file.worktree;
  return letter === "?" ? "U" : letter;
}

function treeGitStatus(status: OmniRushEditorGitStatus | undefined) {
  if (!status?.repo) return [];
  return status.files.map((file) => {
    const letter = file.worktree !== " " ? file.worktree : file.index;
    const kind = letter === "?" ? "untracked" : letter === "A" ? "added" : letter === "D" ? "deleted" : letter === "R" ? "renamed" : "modified";
    return { path: file.path, status: kind as "untracked" | "added" | "deleted" | "renamed" | "modified" };
  });
}

const TREE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 11%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 6%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

function FilesView(props: {
  files: string[];
  truncated: boolean;
  git: OmniRushEditorGitStatus | undefined;
  selected: string | null;
  loading: boolean;
  error: boolean;
  onOpen: (path: string) => void;
  onRefresh: () => void;
}) {
  const onOpenRef = useRef(props.onOpen);
  onOpenRef.current = props.onOpen;
  const fileSet = useMemo(() => new Set(props.files), [props.files]);
  const fileSetRef = useRef(fileSet);
  fileSetRef.current = fileSet;
  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    onSelectionChange: (paths) => {
      const path = paths.at(-1);
      if (path && fileSetRef.current.has(path)) onOpenRef.current(path);
    },
    paths: [],
    search: false,
    unsafeCSS: TREE_CSS,
  });
  const search = useFileTreeSearch(model);
  useEffect(() => {
    model.resetPaths(props.files);
  }, [model, props.files]);
  useEffect(() => {
    model.setGitStatus(treeGitStatus(props.git));
  }, [model, props.git, props.files]);
  useEffect(() => {
    if (!props.selected) return;
    const item = model.getItem(props.selected);
    if (!item) return;
    for (const path of model.getSelectedPaths()) if (path !== props.selected) model.getItem(path)?.deselect();
    item.select();
  }, [model, props.files, props.selected]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-editor-files={props.files.length}>
      <div className="flex h-9 shrink-0 items-center gap-1 px-1.5">
        <InputGroup className="h-7 min-w-0 flex-1 bg-background">
          <InputGroupAddon align="inline-start"><Search /></InputGroupAddon>
          <InputGroupInput
            aria-label="Filter files"
            placeholder="Filter files"
            value={search.value}
            onChange={(event) => {
              const value = event.target.value;
              if (value.trim()) search.setValue(value);
              else search.close();
            }}
          />
        </InputGroup>
        <Button variant="ghost" size="icon-xs" aria-label="Refresh files" onClick={props.onRefresh}>
          <RefreshCw className={cn(props.loading && "animate-spin")} />
        </Button>
      </div>
      {props.error ? (
        <p className="p-3 text-xs text-destructive">Could not list this folder.</p>
      ) : (
        <FileTree
          model={model}
          aria-label="Project files"
          className="min-h-0 flex-1 overflow-hidden"
          style={{ ["--trees-fg-override" as string]: "var(--foreground)" }}
        />
      )}
      {props.truncated ? (
        <p className="border-t border-border px-2 py-1 text-[10px] text-muted-foreground">Showing the first 200,000 files.</p>
      ) : null}
    </div>
  );
}

function ChangesView(props: {
  data: ReviewData | undefined;
  loading: boolean;
  error: string | null;
  scope: ReviewScope;
  available: boolean;
  pending: (file: ReviewFile) => boolean;
  selected: string | null;
  onScope: (scope: ReviewScope) => void;
  onOpen: (file: ReviewFile) => void;
  onAcceptAll: (files: ReviewFile[]) => void;
  onRejectAll: (files: ReviewFile[]) => void;
  onRefresh: () => void;
}) {
  const files = props.data?.files ?? [];
  const pending = files.filter((file) => file.baseline !== undefined && props.pending(file));
  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-editor-changes={files.length}>
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <div className="flex rounded-lg bg-muted p-0.5">
          {(["turn", "chat"] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              onClick={() => props.onScope(scope)}
              className={cn("whitespace-nowrap rounded-md px-1.5 py-0.5", props.scope === scope ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}
            >
              {scope === "turn" ? "Last turn" : "All turns"}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <Button variant="ghost" size="icon-xs" aria-label="Refresh changes" onClick={props.onRefresh}>
          <RefreshCw className={cn(props.loading && "animate-spin")} />
        </Button>
      </div>
      {!props.available ? (
        <p className="px-3 py-2 text-muted-foreground">Open a chat to review the agent's changes.</p>
      ) : props.error ? (
        <p className="px-3 py-2 text-destructive">{props.error}</p>
      ) : props.loading && !props.data ? (
        <p className="px-3 py-2 text-muted-foreground">Loading changes…</p>
      ) : files.length === 0 ? (
        <p className="px-3 py-2 text-muted-foreground">The agent has not changed any files in this chat yet.</p>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-1">
            {files.map((file) => {
              const isPending = file.baseline !== undefined && props.pending(file);
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => props.onOpen(file)}
                  data-editor-change={file.path}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-muted",
                    props.selected === file.path && "bg-muted",
                  )}
                  title={file.baseline === undefined ? "Changed again since the agent's turn: shown without a review diff" : file.path}
                >
                  {isPending ? <CircleDot className="size-3 shrink-0 text-primary" /> : <Check className="size-3 shrink-0 text-muted-foreground" />}
                  <span className={cn("min-w-0 flex-1 truncate", !isPending && "text-muted-foreground")}>
                    {file.path.split("/").pop()}
                    <span className="ms-1.5 text-[10.5px] text-muted-foreground">{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-red-600 dark:text-red-400">−{file.deletions}</span>
                </button>
              );
            })}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 border-t border-border p-2">
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-muted-foreground">{pending.length ? `${pending.length} left` : "Done"}</span>
            <Button size="xs" disabled={pending.length === 0} onClick={() => props.onAcceptAll(pending)}>Accept all</Button>
            <Button size="xs" variant="outline" disabled={pending.length === 0} onClick={() => props.onRejectAll(pending)}>Reject all</Button>
          </div>
        </>
      )}
    </div>
  );
}

function GitView(props: {
  status: OmniRushEditorGitStatus | undefined;
  loading: boolean;
  error: string | null;
  busy: boolean;
  selected: string | null;
  onOpen: (file: OmniRushEditorGitFile, staged: boolean) => void;
  onStage: (paths: string[], stage: boolean) => void;
  onCommit: (message: string) => Promise<boolean>;
  onRefresh: () => void;
}) {
  const [message, setMessage] = useState("");
  const status = props.status;
  const staged = status?.files.filter((file) => file.index !== " " && file.index !== "?") ?? [];
  const unstaged = status?.files.filter((file) => file.worktree !== " ") ?? [];
  const commit = async () => {
    if (!message.trim() || staged.length === 0) return;
    if (await props.onCommit(message)) setMessage("");
  };
  const row = (file: OmniRushEditorGitFile, isStaged: boolean) => (
    <div
      key={`${isStaged ? "s" : "u"}:${file.path}`}
      className={cn("group flex items-center gap-1.5 rounded-md px-2 py-0.5 hover:bg-muted", props.selected === file.path && "bg-muted")}
      data-editor-git-file={file.path}
      data-editor-git-staged={isStaged ? "1" : "0"}
    >
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-start" onClick={() => props.onOpen(file, isStaged)}>
        <span className="min-w-0 truncate">{file.path.split("/").pop()}</span>
        <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}</span>
      </button>
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-60 group-hover:opacity-100"
              aria-label={isStaged ? `Unstage ${file.path}` : `Stage ${file.path}`}
              disabled={props.busy}
              onClick={() => props.onStage(isStaged && file.from ? [file.path, file.from] : [file.path], !isStaged)}
            >
              {isStaged ? <Minus /> : <Plus />}
            </Button>
          )}
        />
        <TooltipContent>{isStaged ? "Unstage" : "Stage"}</TooltipContent>
      </Tooltip>
      <span className={cn(
        "w-3 shrink-0 text-center font-mono text-[10.5px]",
        gitBadge(file, isStaged) === "U" || gitBadge(file, isStaged) === "A" ? "text-emerald-600 dark:text-emerald-400" : gitBadge(file, isStaged) === "D" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400",
      )}>
        {gitBadge(file, isStaged)}
      </span>
    </div>
  );
  if (props.error) return <p className="p-3 text-xs text-destructive">{props.error}</p>;
  if (!status) return <p className="p-3 text-xs text-muted-foreground">{props.loading ? "Reading git status…" : ""}</p>;
  if (!status.repo) return <p className="p-3 text-xs text-muted-foreground">This folder is not a git repository.</p>;
  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-editor-git>
      <div className="flex h-9 shrink-0 items-center gap-1.5 px-2">
        <GitBranch className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium" data-editor-branch>{status.branch ?? "detached HEAD"}</span>
        {status.ahead || status.behind ? <span className="text-muted-foreground">↑{status.ahead} ↓{status.behind}</span> : null}
        <Button variant="ghost" size="icon-xs" aria-label="Refresh git status" onClick={props.onRefresh}>
          <RefreshCw className={cn(props.loading && "animate-spin")} />
        </Button>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 px-2 pb-2">
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void commit();
            }
          }}
          placeholder={staged.length ? "Commit message (Cmd/Ctrl+Enter)" : "Stage changes to commit"}
          aria-label="Commit message"
          rows={2}
          className="w-full resize-none rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button size="xs" disabled={props.busy || staged.length === 0 || !message.trim()} onClick={() => void commit()}>
          <GitCommitHorizontal /> Commit {staged.length ? `${staged.length} file${staged.length === 1 ? "" : "s"}` : ""}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        <div className="flex items-center px-2 pt-1 pb-0.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
          <span className="flex-1">Staged ({staged.length})</span>
          {staged.length ? <button type="button" className="hover:text-foreground" onClick={() => props.onStage(staged.flatMap((file) => (file.from ? [file.path, file.from] : [file.path])), false)}>Unstage all</button> : null}
        </div>
        {staged.map((file) => row(file, true))}
        <div className="flex items-center px-2 pt-2 pb-0.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
          <span className="flex-1">Changes ({unstaged.length})</span>
          {unstaged.length ? <button type="button" className="hover:text-foreground" onClick={() => props.onStage(unstaged.map((file) => file.path), true)}>Stage all</button> : null}
        </div>
        {unstaged.map((file) => row(file, false))}
        {staged.length === 0 && unstaged.length === 0 ? <p className="px-2 py-1 text-muted-foreground">No changes.</p> : null}
      </div>
    </div>
  );
}

/**
 * A file with unsaved changes changed on disk (an undo, the agent, another
 * program): Reload (the disk text) is the first choice; Overwrite writes
 * the editor's text over it.
 */
function showConflict(path: string, input: { reload: () => void; overwrite: () => void; reason: "save" | "undo" }) {
  const message = input.reason === "undo"
    ? `${path} changed on disk (undo or redo). Your unsaved changes are still in the editor.`
    : `${path} changed on disk since you opened it.`;
  toast.warning(message, {
    id: `editor-conflict:${path}`,
    duration: 20_000,
    action: { label: "Reload", onClick: input.reload },
    cancel: { label: "Overwrite", onClick: input.overwrite },
  });
}

export default function EditorPanel(props: EditorPanelProps) {
  const { client, workspaceId, workspaceRoot, sessionId, sessionBusy, opencodeClient } = props;
  const monaco = useMemo<Monaco>(() => setupMonaco(), []);
  const docs = useMemo(() => editorDocuments(monaco, client, workspaceId), [monaco, client, workspaceId]);
  const queryClient = useQueryClient();
  const state = useEditorStore((store) => editorWorkspaceState(store, workspaceId));
  const dirty = useEditorStore((store) => store.dirty[workspaceId]);
  const quickOpen = useEditorStore((store) => store.quickOpen);
  const reviewScope = useEditorStore((store) => store.reviewScope);
  const sideOpen = useEditorStore((store) => store.sideOpen);
  const activeTab = state.tabs.find((tab) => tab.id === state.activeId) ?? null;
  const [surface, setSurface] = useState<SurfaceDoc | null>(null);
  const [tabError, setTabError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null);
  const [hunks, setHunks] = useState<LineHunk[]>([]);
  const [navigate, setNavigate] = useState<{ direction: 1 | -1; nonce: number } | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [reviewTick, setReviewTick] = useState(0);
  // Bumped after open documents were read again (a file may have been deleted under its tab).
  const [docsTick, setDocsTick] = useState(0);
  const recentRef = useRef<string[]>([]);

  // ── data ───────────────────────────────────────────────────────────────
  const treeQuery = useQuery({
    queryKey: ["editor-tree", workspaceId] as const,
    queryFn: () => client.editorTree(workspaceId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const gitQuery = useQuery({
    queryKey: ["editor-git", workspaceId] as const,
    queryFn: () => client.editorGitStatus(workspaceId),
    staleTime: 3_000,
    refetchOnWindowFocus: true,
    refetchInterval: state.view === "git" ? 10_000 : false,
  });
  const changesQuery = useQuery({
    queryKey: ["editor-changes", workspaceId, sessionId, reviewScope] as const,
    queryFn: () => loadAgentChanges({ opencodeClient: opencodeClient!, sessionId: sessionId!, directory: workspaceRoot, scope: reviewScope, docs, workspaceRoot }),
    enabled: Boolean(opencodeClient && sessionId && !sessionBusy),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const review = changesQuery.data;
  const reviewFiles = review?.files ?? [];
  const files = treeQuery.data?.files ?? EMPTY_FILES;

  // A turn ended: the agent may have changed files.
  const wasBusy = useRef(sessionBusy);
  useEffect(() => {
    if (wasBusy.current && !sessionBusy) {
      void docs.refresh().then(() => setDocsTick((value) => value + 1));
      void queryClient.invalidateQueries({ queryKey: ["editor-tree", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["editor-git", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["editor-changes", workspaceId] });
    }
    wasBusy.current = sessionBusy;
  }, [docs, queryClient, sessionBusy, workspaceId]);

  // An undo or redo changed files: open files without unsaved changes take the disk text; one with
  // unsaved changes is flagged and Reload is offered first (an Overwrite would take the undo back).
  useEffect(() => {
    docs.shown += 1;
    const unsubscribe = onFilesRewound(() => {
      void docs.refreshAfterRewind().then((conflicts) => {
        setDocsTick((value) => value + 1);
        for (const path of conflicts) {
          showConflict(path, {
            reload: () => void docs.revert(path).then(() => setDocsTick((value) => value + 1)),
            overwrite: () => void docs.save(path, { sessionId, source: "editor", force: true }).then((result) => {
              if (!result.ok) toast.error(result.message);
              void queryClient.invalidateQueries({ queryKey: ["editor-git", workspaceId] });
            }),
            reason: "undo",
          });
        }
      }).catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: ["editor-tree", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["editor-git", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["editor-changes", workspaceId] });
    });
    return () => {
      docs.shown -= 1;
      unsubscribe();
    };
  }, [docs, queryClient, sessionId, workspaceId]);

  // Back in the window: files may have changed outside the app.
  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      // At most every 5 s: switching windows quickly must not re-read every open file each time.
      if (Date.now() - last < 5_000) return;
      last = Date.now();
      void docs.refresh().then(() => setDocsTick((value) => value + 1));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [docs]);

  // ── review state ───────────────────────────────────────────────────────
  const reviewKey = review?.key ?? null;
  // Older reviews' "before" models and documents nobody shows are let go when a new review loads.
  const recentReviewKeys = useRef<string[]>([]);
  useEffect(() => {
    if (!reviewKey) return;
    recentReviewKeys.current = [reviewKey, ...recentReviewKeys.current.filter((key) => key !== reviewKey)].slice(0, 2);
    docs.disposeReviewModels(new Set(recentReviewKeys.current));
    const keep = new Set<string>([
      ...useEditorStore.getState().byWorkspace[workspaceId]?.tabs.map((tab) => tab.path) ?? [],
      ...(review?.files.map((file) => file.path) ?? []),
    ]);
    docs.evict(keep);
  }, [docs, review, reviewKey, workspaceId]);
  const baselineModel = useCallback((file: ReviewFile) => {
    // Created once per review (key + path): accepting a hunk edits it, and a refetch must not undo that.
    const uri = docs.uri(`review/${reviewKey}/${file.path}`, "omnirush-base");
    const existing = monaco.editor.getModel(uri);
    if (existing) return existing;
    // A file fully reviewed before a restart stays reviewed while its text is the one that was reviewed.
    const current = docs.get(file.path)?.model.getValue() ?? file.current;
    const reviewed = current !== null && reviewKey !== null && isReviewed(reviewKey, file.path, current);
    return monaco.editor.createModel(reviewed ? current : file.baseline ?? "", languageForPath(file.path), uri);
  }, [docs, monaco, reviewKey]);
  const modifiedFor = useCallback((file: ReviewFile): FileDoc => {
    return docs.get(file.path) ?? docs.openMissing(file.path);
  }, [docs]);
  /** The file's document, read from disk first when it is not open yet (an agent deletion: an empty one). */
  const loadModified = useCallback(async (file: ReviewFile): Promise<FileDoc | null> => {
    const existing = docs.get(file.path);
    if (existing) return existing;
    if (file.current === null) return docs.openMissing(file.path);
    const opened = await docs.open(file.path);
    if (opened.ok) return opened.doc;
    toast.error(opened.message);
    return null;
  }, [docs]);
  /** The file's text now: its document when open, else the disk text the review loaded with. */
  const textNow = useCallback((file: ReviewFile) => docs.get(file.path)?.model.getValue() ?? file.current ?? "", [docs]);
  const isPending = useCallback((file: ReviewFile) => {
    if (file.baseline === undefined) return false;
    const base = baselineModel(file).getValue();
    return base !== textNow(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baselineModel, textNow, reviewTick]);

  // Remembers files whose review is finished (before === now), so a restart does not ask again.
  useEffect(() => {
    if (!reviewKey) return;
    for (const file of reviewFiles) {
      if (file.baseline === undefined) continue;
      const uri = docs.uri(`review/${reviewKey}/${file.path}`, "omnirush-base");
      const base = monaco.editor.getModel(uri)?.getValue();
      const now = docs.get(file.path)?.model.getValue() ?? file.current ?? "";
      if (base !== undefined && base === now) markReviewed(reviewKey, file.path, now);
    }
  }, [docs, monaco, reviewFiles, reviewKey, reviewTick]);

  const reportReview = useCallback((path: string, decision: "accept" | "reject", counts: { added: number; removed: number }, scope: "hunk" | "file") => {
    if (!sessionId) return;
    void client.editorReview(workspaceId, { sessionId, path, decision, scope, ...counts }).catch(() => undefined);
  }, [client, sessionId, workspaceId]);

  const writeReviewed = useCallback(async (file: ReviewFile, doc: FileDoc) => {
    // A file the agent created that is empty after rejecting goes away again.
    const result = file.baseline === null && doc.model.getValue() === ""
      ? await docs.remove(file.path, { sessionId, source: "review" })
      : await docs.save(file.path, { sessionId, source: "review" });
    if (!result.ok) toast.error(result.message);
    void queryClient.invalidateQueries({ queryKey: ["editor-git", workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ["editor-tree", workspaceId] });
  }, [docs, queryClient, sessionId, workspaceId]);

  const setLines = (model: import("monaco-editor/editor/editor.api.js").editor.ITextModel, lines: string[], undoable: boolean) => {
    const text = lines.join(model.getEOL());
    if (undoable) model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    else model.setValue(text);
  };

  const acceptOne = useCallback((file: ReviewFile, hunk: LineHunk) => {
    const base = baselineModel(file);
    const doc = modifiedFor(file);
    setLines(base, acceptHunk(base.getLinesContent(), doc.model.getLinesContent(), hunk), false);
    reportReview(file.path, "accept", hunkCounts(hunk), "hunk");
    setReviewTick((value) => value + 1);
    return true;
  }, [baselineModel, modifiedFor, reportReview]);

  /** Rejecting writes the file: not while the agent works on it, and not over the user's unsaved edits. */
  const canReject = useCallback((doc: FileDoc) => {
    if (sessionBusy) {
      toast("Wait for the agent's turn to finish before rejecting changes.");
      return false;
    }
    if (docs.isDirty(doc)) {
      toast(`${doc.path} has unsaved edits: save or discard them first.`);
      return false;
    }
    return true;
  }, [docs, sessionBusy]);

  const rejectOne = useCallback((file: ReviewFile, hunk: LineHunk) => {
    const base = baselineModel(file);
    const doc = modifiedFor(file);
    if (!canReject(doc)) return false;
    setLines(doc.model, rejectHunk(base.getLinesContent(), doc.model.getLinesContent(), hunk), true);
    reportReview(file.path, "reject", hunkCounts(hunk), "hunk");
    setReviewTick((value) => value + 1);
    void writeReviewed(file, doc);
    return true;
  }, [baselineModel, canReject, modifiedFor, reportReview, writeReviewed]);

  const acceptFiles = useCallback(async (list: ReviewFile[]) => {
    for (const file of list) {
      const doc = await loadModified(file);
      if (!doc) return;
      const base = baselineModel(file);
      base.setValue(doc.model.getValue());
      reportReview(file.path, "accept", { added: file.additions, removed: file.deletions }, "file");
    }
    setReviewTick((value) => value + 1);
  }, [baselineModel, loadModified, reportReview]);

  const rejectFiles = useCallback(async (list: ReviewFile[]) => {
    for (const file of list) {
      const doc = await loadModified(file);
      if (!doc || !canReject(doc)) return;
      doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: baselineModel(file).getValue() }], () => null);
      reportReview(file.path, "reject", { added: file.additions, removed: file.deletions }, "file");
      await writeReviewed(file, doc);
    }
    setReviewTick((value) => value + 1);
  }, [baselineModel, canReject, loadModified, reportReview, writeReviewed]);

  const reviewFilesRef = useRef(reviewFiles);
  reviewFilesRef.current = reviewFiles;
  const acceptRef = useRef(acceptOne);
  acceptRef.current = acceptOne;
  const rejectRef = useRef(rejectOne);
  rejectRef.current = rejectOne;

  // ── tabs ───────────────────────────────────────────────────────────────
  const openFile = useCallback((path: string) => {
    useEditorStore.getState().openTab(workspaceId, { id: tabId({ kind: "file", path }), kind: "file", path });
    recentRef.current = [path, ...recentRef.current.filter((item) => item !== path)].slice(0, 30);
  }, [workspaceId]);
  const openReview = useCallback((file: ReviewFile) => {
    if (file.baseline === undefined) {
      openFile(file.path);
      return;
    }
    useEditorStore.getState().openTab(workspaceId, { id: tabId({ kind: "review", path: file.path }), kind: "review", path: file.path });
  }, [openFile, workspaceId]);
  const openGit = useCallback((file: OmniRushEditorGitFile, staged: boolean) => {
    const ref = staged ? "HEAD" : "index";
    useEditorStore.getState().openTab(workspaceId, { id: tabId({ kind: "git", path: file.path, ref }), kind: "git", path: file.path, ref });
  }, [workspaceId]);

  const closeTab = useCallback((tab: EditorTab) => {
    const doc = tab.kind === "file" ? docs.get(tab.path) : null;
    if (doc && docs.isDirty(doc) && !window.confirm(`${tab.path} has unsaved changes. Close it anyway? The changes stay until you reopen the file.`)) return;
    useEditorStore.getState().closeTab(workspaceId, tab.id);
  }, [docs, workspaceId]);

  // The active tab's document.
  useEffect(() => {
    let cancelled = false;
    setTabError(null);
    if (!activeTab) {
      setSurface(null);
      return;
    }
    const key = `${workspaceId}|${activeTab.id}`;
    void (async () => {
      if (activeTab.kind === "file") {
        const opened = await docs.open(activeTab.path);
        if (cancelled) return;
        if (!opened.ok) {
          setSurface(null);
          setTabError(opened.message);
          return;
        }
        if (opened.doc.missing && !docs.isDirty(opened.doc)) {
          setSurface(null);
          setTabError("This file was deleted.");
          return;
        }
        setSurface({ kind: "file", key, doc: opened.doc });
        return;
      }
      if (activeTab.kind === "review") {
        const file = reviewFiles.find((item) => item.path === activeTab.path);
        if (!file || file.baseline === undefined) {
          if (!changesQuery.isFetching && review) {
            setSurface(null);
            setTabError("This change is no longer in the review. Open the file from the Files view.");
          }
          return;
        }
        const opened = file.status === "deleted" ? null : await docs.open(file.path);
        if (cancelled) return;
        const doc = opened && opened.ok ? opened.doc : docs.openMissing(file.path);
        const path = file.path;
        // Through refs: the bars outlive this render, and must act on the newest review data.
        const current = () => reviewFilesRef.current.find((item) => item.path === path) ?? file;
        setSurface({
          kind: "diff",
          key: `${key}:${reviewKey}`,
          original: baselineModel(file),
          modified: doc.model,
          review: { onAccept: (hunk) => acceptRef.current(current(), hunk), onReject: (hunk) => rejectRef.current(current(), hunk) },
        });
        return;
      }
      // Git: the file against HEAD (staged view) or the index (working-tree view).
      const [original, opened] = await Promise.all([
        client.editorGitOriginal(workspaceId, activeTab.path, activeTab.ref).catch(() => null),
        docs.open(activeTab.path),
      ]);
      if (cancelled) return;
      if (original?.binary || original?.tooLarge) {
        setSurface(null);
        setTabError("This file cannot be shown as a text diff.");
        return;
      }
      const base = docs.baseline(`git-${activeTab.ref}`, activeTab.path, original?.content ?? "");
      const doc = opened.ok ? opened.doc : docs.openMissing(activeTab.path);
      setSurface({ kind: "diff", key, original: base, modified: doc.model });
    })();
    return () => {
      cancelled = true;
    };
    // reviewFiles changes identity per fetch; the key carries what matters.
  }, [activeTab, docs, client, workspaceId, reviewKey, changesQuery.isFetching, docsTick]);

  // ── save ───────────────────────────────────────────────────────────────
  const save = useCallback(async (options: { force?: boolean } = {}) => {
    if (!activeTab) return;
    const path = activeTab.path;
    const doc = docs.get(path);
    if (!doc) return;
    const result = await docs.save(path, { sessionId, source: "editor", force: options.force });
    if (result.ok) {
      void queryClient.invalidateQueries({ queryKey: ["editor-git", workspaceId] });
      if (!files.includes(path)) void queryClient.invalidateQueries({ queryKey: ["editor-tree", workspaceId] });
      return;
    }
    if (result.conflict) {
      showConflict(path, { reload: () => void docs.revert(path), overwrite: () => void save({ force: true }), reason: "save" });
      return;
    }
    toast.error(result.message);
  }, [activeTab, docs, files, queryClient, sessionId, workspaceId]);

  // ── git ────────────────────────────────────────────────────────────────
  const stage = useCallback(async (paths: string[], doStage: boolean) => {
    setGitBusy(true);
    try {
      const status = await client.editorGitStage(workspaceId, paths, doStage);
      queryClient.setQueryData(["editor-git", workspaceId], status);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Git failed.");
    } finally {
      setGitBusy(false);
    }
  }, [client, queryClient, workspaceId]);
  const commit = useCallback(async (message: string) => {
    setGitBusy(true);
    try {
      const result = await client.editorGitCommit(workspaceId, message);
      queryClient.setQueryData(["editor-git", workspaceId], result.status);
      toast.success(`Committed ${result.commit}`);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Commit failed.");
      return false;
    } finally {
      setGitBusy(false);
    }
  }, [client, queryClient, workspaceId]);

  // ── keys ───────────────────────────────────────────────────────────────
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = /Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      // Cmd/Ctrl+S outside Monaco (tab strip, tree) still saves the active file.
      const inMonaco = event.target instanceof Element && Boolean(event.target.closest(".monaco-editor"));
      if (key === "s" && !event.shiftKey && !inMonaco && panelRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [save]);

  useEffect(() => {
    if (!state.activeId) return;
    panelRef.current?.querySelector(`[data-editor-tab="${CSS.escape(state.activeId)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.activeId]);

  const activePath = activeTab?.path ?? null;
  const activeDirty = activeTab && dirty?.[activeTab.path];
  const activeDoc = activePath ? docs.get(activePath) : null;
  const pendingCount = reviewFiles.filter((file) => isPending(file)).length;
  const branch = gitQuery.data?.repo ? gitQuery.data.branch : null;
  const setView = (view: EditorSideView) => {
    if (state.view === view && sideOpen) useEditorStore.getState().setSideOpen(false);
    else useEditorStore.getState().setView(workspaceId, view);
  };

  const side = (
    <div className="flex h-full min-h-0 flex-col border-e border-border bg-muted/20">
      {state.view === "files" ? (
        <FilesView
          files={files}
          truncated={Boolean(treeQuery.data?.truncated)}
          git={gitQuery.data}
          selected={activePath}
          loading={treeQuery.isFetching}
          error={treeQuery.isError}
          onOpen={openFile}
          onRefresh={() => void treeQuery.refetch()}
        />
      ) : state.view === "changes" ? (
        <ChangesView
          data={review}
          loading={changesQuery.isFetching}
          error={changesQuery.isError ? (changesQuery.error instanceof Error ? changesQuery.error.message : "Could not load the agent's changes.") : null}
          scope={reviewScope}
          available={Boolean(opencodeClient && sessionId)}
          pending={isPending}
          selected={activeTab?.kind === "review" ? activeTab.path : null}
          onScope={(scope) => useEditorStore.getState().setReviewScope(scope)}
          onOpen={openReview}
          onAcceptAll={(list) => void acceptFiles(list)}
          onRejectAll={(list) => void rejectFiles(list)}
          onRefresh={() => void changesQuery.refetch()}
        />
      ) : (
        <GitView
          status={gitQuery.data}
          loading={gitQuery.isFetching}
          error={gitQuery.isError ? (gitQuery.error instanceof Error ? gitQuery.error.message : "Could not read git status.") : null}
          busy={gitBusy}
          selected={activeTab?.kind === "git" ? activeTab.path : null}
          onOpen={openGit}
          onStage={(paths, doStage) => void stage(paths, doStage)}
          onCommit={commit}
          onRefresh={() => void gitQuery.refetch()}
        />
      )}
    </div>
  );

  const main = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border [scrollbar-width:none]" role="tablist" data-editor-tabs>
        {state.tabs.map((tab) => {
          const active = tab.id === state.activeId;
          const name = tab.path.split("/").pop() ?? tab.path;
          const isDirty = tab.kind === "file" && dirty?.[tab.path];
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              title={tab.path}
              data-editor-tab={tab.id}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  closeTab(tab);
                }
              }}
              className={cn(
                "group flex max-w-48 shrink-0 cursor-pointer items-center gap-1.5 border-e border-border ps-3 pe-1.5 text-xs",
                active ? "bg-background text-foreground shadow-[inset_0_-2px_0_var(--primary)]" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => useEditorStore.getState().selectTab(workspaceId, tab.id)}
            >
              {tab.kind === "review" ? <CircleDot className="size-3 shrink-0 text-primary" /> : tab.kind === "git" ? <GitBranch className="size-3 shrink-0" /> : null}
              <span className="truncate">{name}{tab.kind === "git" ? ` (${tab.ref === "HEAD" ? "staged" : "working"})` : ""}</span>
              <button
                type="button"
                aria-label={`Close ${name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab);
                }}
                className="flex size-4 items-center justify-center rounded hover:bg-muted"
              >
                {isDirty ? <span className="size-2 rounded-full bg-foreground group-hover:hidden" /> : null}
                <X className={cn("size-3", isDirty && "hidden group-hover:block")} />
              </button>
            </div>
          );
        })}
      </div>
      {activeTab?.kind === "review" ? (
        <div className="flex h-8 shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-border bg-primary/5 px-3 text-xs" data-editor-review-bar>
          <span className="min-w-0 truncate font-medium">{hunks.length ? `${hunks.length} to review` : "All reviewed"}</span>
          <span className="flex-1" />
          <Button variant="ghost" size="xs" disabled={!hunks.length} onClick={() => setNavigate({ direction: -1, nonce: Date.now() })}><ChevronUp /> Prev</Button>
          <Button variant="ghost" size="xs" disabled={!hunks.length} onClick={() => setNavigate({ direction: 1, nonce: Date.now() })}><ChevronDown /> Next</Button>
        </div>
      ) : activePath ? (
        <div className="flex h-6 shrink-0 items-center gap-1 border-b border-border px-3 text-[11px] text-muted-foreground" data-editor-breadcrumb>
          {activePath.split("/").map((part, index, parts) => (
            <span key={`${index}:${part}`} className={cn(index === parts.length - 1 && "text-foreground")}>
              {part}{index < parts.length - 1 ? <span className="mx-1 opacity-60">›</span> : null}
            </span>
          ))}
          {activeDoc?.conflict ? (
            <button type="button" className="ms-auto flex items-center gap-1 text-amber-600 hover:underline dark:text-amber-400" onClick={() => void docs.revert(activePath)}>
              <Undo2 className="size-3" /> Changed on disk: reload
            </button>
          ) : null}
        </div>
      ) : null}
      {tabError ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">{tabError}</div>
      ) : null}
      <div className={cn("flex min-h-0 flex-1 flex-col", tabError && "hidden")}>
        {state.tabs.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground" data-editor-empty>
            <FileCode2 className="size-8 opacity-40" />
            <p>Open a file from the tree, or press <kbd className="rounded border border-border px-1 text-xs">{/Mac/i.test(navigator.platform) ? "⌘" : "Ctrl"} P</kbd> to find one.</p>
            {pendingCount ? (
              <Button size="sm" variant="outline" onClick={() => useEditorStore.getState().setView(workspaceId, "changes")}>Review {pendingCount} changed file{pendingCount === 1 ? "" : "s"}</Button>
            ) : null}
          </div>
        ) : null}
        <div className={cn("flex min-h-0 flex-1", state.tabs.length === 0 && "hidden")}>
          <EditorSurface
            monaco={monaco}
            surface={surface}
            onSave={() => void save()}
            onCursor={setCursor}
            onHunks={setHunks}
            navigate={navigate}
          />
        </div>
      </div>
      <div className="flex h-6 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-border px-3 text-[11px] text-muted-foreground" data-editor-status>
        {branch ? <span className="flex min-w-0 items-center gap-1 truncate"><GitBranch className="size-3 shrink-0" />{branch}</span> : null}
        {gitQuery.data?.repo ? <span className="shrink-0">{gitQuery.data.files.length} changed</span> : null}
        <span className="flex-1" />
        {cursor && activeTab ? <span className="shrink-0 max-[1100px]:hidden">Ln {cursor.line}, Col {cursor.column}</span> : null}
        {activePath ? <span className="shrink-0 max-[1250px]:hidden">{languageForPath(activePath)}</span> : null}
        {activeTab?.kind === "file" ? <span className="shrink-0" data-editor-saved={activeDirty ? "0" : "1"}>{activeDirty ? "Unsaved" : "Saved"}</span> : null}
      </div>
    </div>
  );

  const mac = /Mac/i.test(navigator.platform);
  const railItem = (view: EditorSideView, label: string, icon: ReactNode, shortcut: string | null, badge?: number) => {
    const active = state.view === view && sideOpen;
    return (
      <Tooltip>
        <TooltipTrigger
          render={(
            <button
              type="button"
              onClick={() => setView(view)}
              data-editor-view={view}
              aria-label={label}
              aria-pressed={active}
              className={cn(
                "relative flex size-9 items-center justify-center rounded-lg transition-colors [&_svg]:size-[18px]",
                active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {icon}
              {badge ? (
                <span className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-primary px-1 text-center text-[9px] font-semibold leading-3.5 text-primary-foreground">
                  {badge > 99 ? "99+" : badge}
                </span>
              ) : null}
            </button>
          )}
        />
        <TooltipContent side="right">{label}{shortcut ? ` (${shortcut})` : ""}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 bg-background" data-editor-panel data-editor-layout="ide">
      {/* The activity rail: the side views, quick open, and the app's own destinations at its foot. */}
      <nav aria-label="Editor views" className="flex w-12 shrink-0 flex-col items-center gap-1 border-e border-border py-2 mac:pt-10" data-editor-rail-views>
        {railItem("files", "Files", <Files />, mac ? "⌘⇧E" : "Ctrl+Shift+E")}
        {railItem("changes", "Agent changes", <FileDiff />, null, pendingCount)}
        {railItem("git", "Git", <GitBranch />, null, gitQuery.data?.repo ? gitQuery.data.files.length : undefined)}
        <Tooltip>
          <TooltipTrigger
            render={(
              <button
                type="button"
                aria-label="Go to file"
                onClick={() => useEditorStore.getState().setQuickOpen(true)}
                className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-[18px]"
              >
                <Search />
              </button>
            )}
          />
          <TooltipContent side="right">Go to file ({mac ? "⌘P" : "Ctrl+P"})</TooltipContent>
        </Tooltip>
        <span className="flex-1" />
        {props.railFoot}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2 mac:titlebar-drag mac:ps-6 [&_button]:mac:titlebar-no-drag" data-editor-header>
        {props.headerStart}
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button variant="ghost" size="icon-sm" aria-label={sideOpen ? "Hide side bar" : "Show side bar"} onClick={() => useEditorStore.getState().setSideOpen(!sideOpen)}>
                {sideOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
              </Button>
            )}
          />
          <TooltipContent>{sideOpen ? "Hide side bar" : "Show side bar"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={props.terminalOpen ? "Hide terminal" : "Show terminal"}
                aria-pressed={props.terminalOpen}
                className={cn(props.terminalOpen && "bg-muted text-foreground")}
                onClick={props.onToggleTerminal}
              >
                <SquareTerminal />
              </Button>
            )}
          />
          <TooltipContent>Terminal ({mac ? "⌘J" : "Ctrl+J"})</TooltipContent>
        </Tooltip>
        {props.headerEnd}
      </div>
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel minSize="160px" className="min-h-0">
          <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0">
            {sideOpen ? (
              <>
                <ResizablePanel defaultSize="230px" minSize="160px" maxSize="50%" className="min-h-0">
                  {side}
                </ResizablePanel>
                <ResizableHandle />
              </>
            ) : null}
            <ResizablePanel minSize="240px" className="min-h-0 min-w-0">
              {main}
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        {props.terminalOpen && props.terminal ? (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize="220px" minSize="120px" maxSize="70%" className="min-h-0" data-editor-terminal>
              {props.terminal}
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
      </div>
      {quickOpen ? (
        <QuickOpen
          files={files}
          recent={recentRef.current}
          onOpen={(path) => {
            useEditorStore.getState().setQuickOpen(false);
            openFile(path);
          }}
          onClose={() => useEditorStore.getState().setQuickOpen(false)}
        />
      ) : null}
    </div>
  );
}
