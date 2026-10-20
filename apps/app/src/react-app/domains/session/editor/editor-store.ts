import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * The desktop editor's open tabs and side view, per workspace. Tabs are
 * remembered across restarts (paths only); file text lives in Monaco models
 * (editor-panel.tsx) and is read again on open.
 */
export type EditorTab =
  | { id: string; kind: "file"; path: string }
  /** The agent's change to one file, for review (accept/reject per hunk). */
  | { id: string; kind: "review"; path: string }
  /** A file against git (HEAD or the index), from the git panel. */
  | { id: string; kind: "git"; path: string; ref: "HEAD" | "index" }
  /** A Markdown file rendered (read-only, follows the file's text as you type). */
  | { id: string; kind: "preview"; path: string };

/** The second editor group (split editor): its own tabs, files and previews only. */
export type EditorGroup2 = { tabs: EditorTab[]; activeId: string | null };

export type EditorSideView = "files" | "changes" | "git" | "search";
/** The window layout: Chat (sessions sidebar + chat) or IDE (files, editor and terminal, chat docked right). */
export type LayoutMode = "chat" | "ide";
export type ReviewScope = "turn" | "chat";

type WorkspaceEditorState = {
  tabs: EditorTab[];
  activeId: string | null;
  view: EditorSideView;
  /** The split editor's second group, when open (remembered per project). */
  group2?: EditorGroup2 | null;
};

type EditorStore = {
  byWorkspace: Record<string, WorkspaceEditorState>;
  /** Paths with unsaved changes, per workspace (not persisted). */
  dirty: Record<string, Record<string, true>>;
  quickOpen: boolean;
  /** One-shot request to show the editor (Cmd/Ctrl+P while it is closed). */
  showRequest: number;
  /** One-shot request to toggle the editor (Cmd/Ctrl+Shift+E). */
  toggleRequest: number;
  reviewScope: ReviewScope;
  sideOpen: boolean;
  /** The layout per workspace (remembered); Chat when never set. */
  modeByWorkspace: Record<string, LayoutMode>;
  /** IDE mode: the chat panel folded away, and its width when open. */
  ideChatCollapsed: boolean;
  ideChatWidth: number;
  /** One-shot requests from shortcuts: switch Chat/IDE (Cmd/Ctrl+Shift+Y), fold the chat (Cmd/Ctrl+Shift+H). */
  modeToggleRequest: number;
  chatToggleRequest: number;
  /** The bottom panel: Problems shown, and which tab is in front (the terminal opens through its own switch). */
  problemsOpen: boolean;
  bottomTab: "problems" | "terminal";
  /** Language features in the editor (problems, hover, go to, rename, outline) from the project's language servers. */
  languageFeatures: boolean;
  openTab: (workspaceId: string, tab: EditorTab, options?: { preview?: boolean }) => void;
  closeTab: (workspaceId: string, id: string) => void;
  selectTab: (workspaceId: string, id: string) => void;
  setView: (workspaceId: string, view: EditorSideView) => void;
  setDirty: (workspaceId: string, path: string, dirty: boolean) => void;
  setQuickOpen: (open: boolean) => void;
  requestShow: () => void;
  requestToggle: () => void;
  setReviewScope: (scope: ReviewScope) => void;
  setSideOpen: (open: boolean) => void;
  setMode: (workspaceId: string, mode: LayoutMode) => void;
  setIdeChatCollapsed: (collapsed: boolean) => void;
  setIdeChatWidth: (width: number) => void;
  requestModeToggle: () => void;
  requestChatToggle: () => void;
  setProblemsOpen: (open: boolean) => void;
  setBottomTab: (tab: "problems" | "terminal") => void;
  setLanguageFeatures: (on: boolean) => void;
  /** Which editor group has the keyboard (1 = the main one). */
  focusedGroup: 1 | 2;
  setFocusedGroup: (group: 1 | 2) => void;
  openTab2: (workspaceId: string, tab: EditorTab) => void;
  selectTab2: (workspaceId: string, id: string) => void;
  closeTab2: (workspaceId: string, id: string) => void;
  /** Closes the second group; its tabs move into the main one (folds the split away). */
  foldGroup2: (workspaceId: string) => void;
};

export const DEFAULT_IDE_CHAT_WIDTH = 420;

const EMPTY: WorkspaceEditorState = { tabs: [], activeId: null, view: "files" };
const MAX_TABS = 20;

export function tabId(tab: { kind: EditorTab["kind"]; path: string; ref?: "HEAD" | "index" }): string {
  if (tab.kind === "preview") return `preview:${tab.path}`;
  return tab.kind === "git" ? `git:${tab.ref ?? "HEAD"}:${tab.path}` : `${tab.kind}:${tab.path}`;
}

export function editorWorkspaceState(state: EditorStore, workspaceId: string): WorkspaceEditorState {
  return state.byWorkspace[workspaceId] ?? EMPTY;
}

export const useEditorStore = create<EditorStore>()(
  persist(
    (set) => ({
      byWorkspace: {},
      dirty: {},
      quickOpen: false,
      showRequest: 0,
      toggleRequest: 0,
      reviewScope: "turn",
      sideOpen: true,
      modeByWorkspace: {},
      ideChatCollapsed: false,
      ideChatWidth: DEFAULT_IDE_CHAT_WIDTH,
      modeToggleRequest: 0,
      chatToggleRequest: 0,
      problemsOpen: false,
      bottomTab: "terminal",
      languageFeatures: true,
      openTab: (workspaceId, tab) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? EMPTY;
          const exists = current.tabs.some((item) => item.id === tab.id);
          let tabs = exists ? current.tabs : [...current.tabs, tab];
          if (tabs.length > MAX_TABS) {
            // Drop the oldest tab that has no unsaved changes.
            const dirty = state.dirty[workspaceId] ?? {};
            const drop = tabs.find((item) => item.id !== tab.id && !(item.kind === "file" && dirty[item.path]));
            if (drop) tabs = tabs.filter((item) => item !== drop);
          }
          return { byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...current, tabs, activeId: tab.id } } };
        }),
      closeTab: (workspaceId, id) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? EMPTY;
          const index = current.tabs.findIndex((item) => item.id === id);
          if (index < 0) return state;
          const tabs = current.tabs.filter((item) => item.id !== id);
          const activeId = current.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : current.activeId;
          return { byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...current, tabs, activeId } } };
        }),
      selectTab: (workspaceId, id) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? EMPTY;
          if (!current.tabs.some((item) => item.id === id) || current.activeId === id) return state;
          return { byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...current, activeId: id } } };
        }),
      setView: (workspaceId, view) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? EMPTY;
          return { byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...current, view } }, sideOpen: true };
        }),
      setDirty: (workspaceId, path, dirty) =>
        set((state) => {
          const current = state.dirty[workspaceId] ?? {};
          if (Boolean(current[path]) === dirty) return state;
          const next = { ...current };
          if (dirty) next[path] = true;
          else delete next[path];
          return { dirty: { ...state.dirty, [workspaceId]: next } };
        }),
      setQuickOpen: (quickOpen) => set({ quickOpen }),
      requestShow: () => set((state) => ({ showRequest: state.showRequest + 1 })),
      requestToggle: () => set((state) => ({ toggleRequest: state.toggleRequest + 1 })),
      setReviewScope: (reviewScope) => set({ reviewScope }),
      setSideOpen: (sideOpen) => set({ sideOpen }),
      setMode: (workspaceId, mode) =>
        set((state) => (state.modeByWorkspace[workspaceId] === mode ? state : { modeByWorkspace: { ...state.modeByWorkspace, [workspaceId]: mode } })),
      setIdeChatCollapsed: (ideChatCollapsed) => set({ ideChatCollapsed }),
      setIdeChatWidth: (width) => set({ ideChatWidth: Math.round(Math.min(Math.max(width, 320), 1200)) }),
      requestModeToggle: () => set((state) => ({ modeToggleRequest: state.modeToggleRequest + 1 })),
      requestChatToggle: () => set((state) => ({ chatToggleRequest: state.chatToggleRequest + 1 })),
      setProblemsOpen: (problemsOpen) => set(problemsOpen ? { problemsOpen, bottomTab: "problems" } : { problemsOpen }),
      setBottomTab: (bottomTab) => set({ bottomTab }),
      setLanguageFeatures: (languageFeatures) => set({ languageFeatures }),
      focusedGroup: 1,
      setFocusedGroup: (focusedGroup) => set((state) => (state.focusedGroup === focusedGroup ? state : { focusedGroup })),
      openTab2: (workspaceId, tab) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? EMPTY;
          const group = current.group2 ?? { tabs: [], activeId: null };
          const tabs = group.tabs.some((item) => item.id === tab.id) ? group.tabs : [...group.tabs, tab].slice(-MAX_TABS);
          return { focusedGroup: 2, byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...current, group2: { tabs, activeId: tab.id } } } };
        }),
      selectTab2: (workspaceId, id) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? EMPTY;
          const group = current.group2;
          if (!group || !group.tabs.some((item) => item.id === id)) return state;
          return { focusedGroup: 2, byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...current, group2: { ...group, activeId: id } } } };
        }),
      closeTab2: (workspaceId, id) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? EMPTY;
          const group = current.group2;
          if (!group) return state;
          const index = group.tabs.findIndex((item) => item.id === id);
          if (index < 0) return state;
          const tabs = group.tabs.filter((item) => item.id !== id);
          // The last tab closed: the group goes.
          if (!tabs.length) return { focusedGroup: 1, byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...current, group2: null } } };
          const activeId = group.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : group.activeId;
          return { byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...current, group2: { tabs, activeId } } } };
        }),
      foldGroup2: (workspaceId) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? EMPTY;
          const group = current.group2;
          if (!group) return state;
          const known = new Set(current.tabs.map((item) => item.id));
          const tabs = [...current.tabs, ...group.tabs.filter((item) => !known.has(item.id))].slice(-MAX_TABS);
          return { focusedGroup: 1, byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...current, tabs, activeId: current.activeId ?? group.activeId, group2: null } } };
        }),
    }),
    {
      name: "omnirush:editor:v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        byWorkspace: state.byWorkspace,
        reviewScope: state.reviewScope,
        sideOpen: state.sideOpen,
        modeByWorkspace: state.modeByWorkspace,
        ideChatCollapsed: state.ideChatCollapsed,
        ideChatWidth: state.ideChatWidth,
        languageFeatures: state.languageFeatures,
      }),
    },
  ),
);
