/** @jsxImportSource react */
/**
 * The editor's Monaco host: one code editor for file tabs and one diff
 * editor for review and git tabs, created once and switched between
 * documents (each tab keeps its scroll and cursor). In a review tab every
 * hunk gets an Accept / Reject bar above it.
 */
import { useEffect, useRef, useState } from "react";
import type * as MonacoApi from "monaco-editor/editor/editor.api.js";

import { subscribeToTheme } from "@/app/theme";
import { addGroupKeys, applyMonacoTheme, monacoThemeName, type Monaco } from "./monaco";
import type { FileDoc } from "./editor-models";
import { hunkCounts, type LineHunk } from "./hunk-ops";
import { monacoOptionsFor, useEditorSettings } from "./editor-settings";

export type SurfaceDoc =
  | { kind: "file"; key: string; doc: FileDoc }
  | {
    kind: "diff";
    key: string;
    original: MonacoApi.editor.ITextModel;
    modified: MonacoApi.editor.ITextModel;
    /** Review tabs: per-hunk decisions. Git tabs have none. */
    review?: {
      /** Applies the decision; false when it was refused (nothing changed). */
      onAccept: (hunk: LineHunk) => boolean;
      onReject: (hunk: LineHunk) => boolean;
    };
    readOnlyModified?: boolean;
  };

type EditorSurfaceProps = {
  monaco: Monaco;
  surface: SurfaceDoc | null;
  onSave: () => void;
  onCursor: (position: { line: number; column: number } | null) => void;
  onHunks: (hunks: LineHunk[]) => void;
  /** Bumped to jump to the next / previous hunk. */
  navigate: { direction: 1 | -1; nonce: number } | null;
  /** The editor's agent actions (right-click menu, Cmd/Ctrl+L): the editor they ran in. */
  onAgentAction?: (action: AgentAction, editor: MonacoApi.editor.ICodeEditor) => void;
  /** A handle to reveal a position in the visible editor and to read it. */
  onReady?: (handle: SurfaceHandle | null) => void;
};

export type AgentAction = "ask" | "explain" | "refactor" | "tests";
export type SurfaceHandle = {
  reveal: (line: number, column: number, endColumn?: number) => void;
  activeEditor: () => MonacoApi.editor.ICodeEditor | null;
};

const BASE_OPTIONS: MonacoApi.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  scrollBeyondLastLine: false,
  renderLineHighlight: "line",
  smoothScrolling: false,
  padding: { top: 6, bottom: 6 },
  // Font size, wrap, minimap and sticky scroll come from Settings → Editor (editor-settings.ts). Sticky scroll uses
  // indentation, not the outline: the outline would ask the language servers for symbols as soon as a file opens.
  // Large files stay responsive: no tokenisation past 20k chars per line, no word-based suggestions on huge files.
  maxTokenizationLineLength: 20_000,
  wordBasedSuggestions: "currentDocument",
  fixedOverflowWidgets: true,
};

function hunkBar(
  hunk: LineHunk,
  index: number,
  total: number,
  review: NonNullable<Extract<SurfaceDoc, { kind: "diff" }>["review"]>,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "omnirush-hunk-bar";
  bar.dataset.editorHunk = String(index);
  const button = (text: string, primary: boolean, run: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = text;
    element.className = primary ? "omnirush-hunk-btn omnirush-hunk-btn-primary" : "omnirush-hunk-btn";
    element.dataset.editorHunkAction = text.toLowerCase();
    element.addEventListener("mousedown", (event) => event.stopPropagation());
    element.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      run();
    });
    return element;
  };
  // Buttons first: they stay in view however narrow the panel or long the lines.
  bar.appendChild(button("Accept", true, () => review.onAccept(hunk)));
  bar.appendChild(button("Reject", false, () => review.onReject(hunk)));
  const { added, removed } = hunkCounts(hunk);
  const label = document.createElement("span");
  label.className = "omnirush-hunk-label";
  label.textContent = `Change ${index + 1} of ${total} · +${added} −${removed}`;
  bar.appendChild(label);
  return bar;
}

const VIEW_STATES = new Map<string, MonacoApi.editor.ICodeEditorViewState | MonacoApi.editor.IDiffEditorViewState | null>();

export function EditorSurface({ monaco, surface, onSave, onCursor, onHunks, navigate, onAgentAction, onReady }: EditorSurfaceProps) {
  const onAgentRef = useRef(onAgentAction);
  onAgentRef.current = onAgentAction;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const codeHostRef = useRef<HTMLDivElement | null>(null);
  const diffHostRef = useRef<HTMLDivElement | null>(null);
  const codeRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | null>(null);
  const diffRef = useRef<MonacoApi.editor.IStandaloneDiffEditor | null>(null);
  // Module-wide: a tab keeps its scroll and cursor when the editor unmounts (switching to Chat and back).
  const viewStates = useRef(VIEW_STATES);
  const currentKey = useRef<string | null>(null);
  const zoneIds = useRef<string[]>([]);
  const overlays = useRef<MonacoApi.editor.IOverlayWidget[]>([]);
  const hunksRef = useRef<LineHunk[]>([]);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const onHunksRef = useRef(onHunks);
  onHunksRef.current = onHunks;
  const [mode, setMode] = useState<"file" | "diff" | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // The editors, once.
  useEffect(() => {
    if (!codeHostRef.current || !diffHostRef.current) return;
    const themeName = monacoThemeName();
    const settingsOptions = monacoOptionsFor(useEditorSettings.getState());
    const code = monaco.editor.create(codeHostRef.current, { ...BASE_OPTIONS, ...settingsOptions, model: null, theme: themeName });
    const diff = monaco.editor.createDiffEditor(diffHostRef.current, {
      ...BASE_OPTIONS,
      ...settingsOptions,
      theme: themeName,
      renderSideBySide: false,
      useInlineViewWhenSpaceIsLimited: true,
      renderMarginRevertIcon: false,
      renderOverviewRuler: false,
      ignoreTrimWhitespace: false,
      originalEditable: false,
      hideUnchangedRegions: { enabled: false },
    });
    const save = () => onSaveRef.current();
    code.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
    diff.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
    const cursor = (editor: MonacoApi.editor.ICodeEditor) => editor.onDidChangeCursorPosition((event) => {
      onCursorRef.current({ line: event.position.lineNumber, column: event.position.column });
    });
    const disposables = [cursor(code), cursor(diff.getModifiedEditor())];
    // The agent in the editor: first in the right-click menu, and Cmd/Ctrl+L to ask. Monaco always sorts its
    // "navigation" group first, so the agent items join it with orders below Go to Definition (1.1).
    const agentActions = (editor: MonacoApi.editor.IStandaloneCodeEditor) => ([
      { id: "omnirush.agent.ask", label: "Ask about selection", action: "ask" as const, keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL], order: 1 },
      { id: "omnirush.agent.explain", label: "Explain with agent", action: "explain" as const, keybindings: [], order: 2 },
      { id: "omnirush.agent.refactor", label: "Refactor with agent…", action: "refactor" as const, keybindings: [], order: 3 },
      { id: "omnirush.agent.tests", label: "Write tests with agent", action: "tests" as const, keybindings: [], order: 4 },
    ]).map((item) => editor.addAction({
      id: item.id,
      label: item.label,
      keybindings: item.keybindings,
      contextMenuGroupId: "navigation",
      contextMenuOrder: item.order / 10,
      run: (target: MonacoApi.editor.ICodeEditor) => onAgentRef.current?.(item.action, target),
    }));
    disposables.push(...agentActions(code), ...agentActions(diff.getModifiedEditor() as MonacoApi.editor.IStandaloneCodeEditor));
    addGroupKeys(monaco, code);
    addGroupKeys(monaco, diff.getModifiedEditor() as MonacoApi.editor.IStandaloneCodeEditor);
    codeRef.current = code;
    diffRef.current = diff;
    onReadyRef.current?.({
      reveal: (line, column, endColumn) => {
        const editor = modeRef.current === "diff" ? diff.getModifiedEditor() : code;
        const selection = { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: endColumn ?? column };
        editor.setSelection(selection);
        editor.revealRangeInCenterIfOutsideViewport(selection);
        editor.focus();
      },
      activeEditor: () => (modeRef.current === "diff" ? diff.getModifiedEditor() : modeRef.current === "file" ? code : null),
    });
    // Auto save "when focus leaves": the panel listens for this.
    const blurEvent = () => window.dispatchEvent(new Event("omnirush:editor-blur"));
    disposables.push(code.onDidBlurEditorWidget(blurEvent), diff.getModifiedEditor().onDidBlurEditorWidget(blurEvent));
    // Settings → Editor, live.
    const unsubscribeSettings = useEditorSettings.subscribe((settings, previous) => {
      const next = monacoOptionsFor(settings);
      if (JSON.stringify(next) === JSON.stringify(monacoOptionsFor(previous))) return;
      code.updateOptions(next);
      diff.updateOptions(next);
    });
    // Follows the app theme: light/dark, presets and custom themes (app/theme.ts).
    const unsubscribeTheme = subscribeToTheme(() => {
      applyMonacoTheme();
      // Repaint now: a composited editor layer can otherwise keep the old background until it scrolls.
      code.render(true);
      diff.getModifiedEditor().render(true);
      diff.getOriginalEditor().render(true);
    });
    return () => {
      const key = currentKey.current;
      if (key) VIEW_STATES.set(key, modeRef.current === "diff" ? diff.saveViewState() : code.saveViewState());
      onReadyRef.current?.(null);
      unsubscribeTheme();
      unsubscribeSettings();
      for (const disposable of disposables) disposable.dispose();
      code.dispose();
      diff.dispose();
      codeRef.current = null;
      diffRef.current = null;
    };
  }, [monaco]);

  // Switching documents.
  useEffect(() => {
    const code = codeRef.current;
    const diff = diffRef.current;
    if (!code || !diff) return;
    const previous = currentKey.current;
    if (previous) {
      viewStates.current.set(previous, mode === "diff" ? diff.saveViewState() : code.saveViewState());
    }
    currentKey.current = surface?.key ?? null;
    if (!surface) {
      code.setModel(null);
      setMode(null);
      onCursorRef.current(null);
      onHunksRef.current([]);
      return;
    }
    if (surface.kind === "file") {
      code.setModel(surface.doc.model);
      code.updateOptions({ readOnly: false });
      const state = viewStates.current.get(surface.key);
      if (state) code.restoreViewState(state as MonacoApi.editor.ICodeEditorViewState);
      setMode("file");
      onHunksRef.current([]);
      requestAnimationFrame(() => code.focus());
      return;
    }
    diff.setModel({ original: surface.original, modified: surface.modified });
    diff.getModifiedEditor().updateOptions({ readOnly: Boolean(surface.readOnlyModified) });
    const state = viewStates.current.get(surface.key);
    if (state) diff.restoreViewState(state as MonacoApi.editor.IDiffEditorViewState);
    setMode("diff");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface]);

  // Hunk bars (review tabs) and the hunk list, after every diff update.
  useEffect(() => {
    const diff = diffRef.current;
    if (!diff || !surface || surface.kind !== "diff") return;
    const modifiedEditor = diff.getModifiedEditor();
    // After a decision the bars' line numbers are stale until the diff is computed again:
    // they take no clicks until then, and a hunk is applied only if the diff still has it.
    let locked = false;
    let unlockTimer: ReturnType<typeof setTimeout> | null = null;
    const setLocked = (value: boolean) => {
      locked = value;
      for (const widget of overlays.current) widget.getDomNode().classList.toggle("omnirush-hunk-bar-busy", value);
    };
    const decide = (apply: (hunk: LineHunk) => boolean) => (hunk: LineHunk) => {
      if (locked) return false;
      const still = (diff.getLineChanges() ?? []).some((change) =>
        change.originalStartLineNumber === hunk.originalStartLineNumber
        && change.originalEndLineNumber === hunk.originalEndLineNumber
        && change.modifiedStartLineNumber === hunk.modifiedStartLineNumber
        && change.modifiedEndLineNumber === hunk.modifiedEndLineNumber);
      if (!still) return false;
      setLocked(true);
      const applied = apply(hunk);
      if (!applied) setLocked(false);
      else {
        if (unlockTimer) clearTimeout(unlockTimer);
        unlockTimer = setTimeout(() => setLocked(false), 3_000);
      }
      return applied;
    };
    const review = surface.review
      ? { onAccept: decide(surface.review.onAccept), onReject: decide(surface.review.onReject) }
      : null;
    const render = (fromDiff: boolean) => {
      // Only a recomputed diff makes the bars' line numbers current again.
      if (fromDiff) setLocked(false);
      const changes = (diff.getLineChanges() ?? []).map((change) => ({
        originalStartLineNumber: change.originalStartLineNumber,
        originalEndLineNumber: change.originalEndLineNumber,
        modifiedStartLineNumber: change.modifiedStartLineNumber,
        modifiedEndLineNumber: change.modifiedEndLineNumber,
      }));
      hunksRef.current = changes;
      onHunksRef.current(changes);
      // Each bar is an overlay widget (above the text layer, so it takes clicks) kept on top of
      // an empty view zone that makes room for it between the lines.
      for (const widget of overlays.current) modifiedEditor.removeOverlayWidget(widget);
      overlays.current = [];
      modifiedEditor.changeViewZones((accessor) => {
        for (const id of zoneIds.current) accessor.removeZone(id);
        zoneIds.current = [];
        if (!review) return;
        const layout = modifiedEditor.getLayoutInfo();
        const left = layout.contentLeft;
        const width = Math.max(120, layout.width - layout.contentLeft - layout.verticalScrollbarWidth - 8);
        changes.forEach((hunk, index) => {
          const after = hunk.modifiedEndLineNumber === 0 ? hunk.modifiedStartLineNumber : hunk.modifiedStartLineNumber - 1;
          const bar = hunkBar(hunk, index, changes.length, review);
          bar.style.position = "absolute";
          bar.style.left = `${left}px`;
          bar.style.width = `${width}px`;
          bar.style.top = "0px";
          bar.style.visibility = "hidden";
          const widget: MonacoApi.editor.IOverlayWidget = {
            getId: () => `omnirush.hunk.${index}`,
            getDomNode: () => bar,
            getPosition: () => null,
          };
          if (locked) bar.classList.add("omnirush-hunk-bar-busy");
          modifiedEditor.addOverlayWidget(widget);
          overlays.current.push(widget);
          const spacer = document.createElement("div");
          zoneIds.current.push(accessor.addZone({
            afterLineNumber: after,
            heightInPx: 26,
            ordinal: -1,
            domNode: spacer,
            onDomNodeTop: (top) => {
              bar.style.top = `${top}px`;
              bar.style.visibility = "visible";
            },
            onComputedHeight: (height) => {
              bar.style.display = height > 0 ? "flex" : "none";
            },
          }));
        });
      });
    };
    const subscription = diff.onDidUpdateDiff(() => render(true));
    // A bar whose zone scrolled out of view is hidden until the zone is drawn again.
    const scroll = modifiedEditor.onDidScrollChange(() => {
      for (const widget of overlays.current) widget.getDomNode().style.visibility = "hidden";
    });
    const layout = modifiedEditor.onDidLayoutChange(() => render(false));
    render(true);
    return () => {
      if (unlockTimer) clearTimeout(unlockTimer);
      subscription.dispose();
      scroll.dispose();
      layout.dispose();
      modifiedEditor.changeViewZones((accessor) => {
        for (const id of zoneIds.current) accessor.removeZone(id);
      });
      zoneIds.current = [];
      for (const widget of overlays.current) modifiedEditor.removeOverlayWidget(widget);
      overlays.current = [];
    };
  }, [surface]);

  // Next / previous hunk.
  useEffect(() => {
    const diff = diffRef.current;
    if (!navigate || !diff || mode !== "diff") return;
    const editor = diff.getModifiedEditor();
    const line = editor.getPosition()?.lineNumber ?? 0;
    const starts = hunksRef.current.map((hunk) => Math.max(1, hunk.modifiedStartLineNumber));
    if (starts.length === 0) return;
    const target = navigate.direction === 1
      ? starts.find((start) => start > line) ?? starts[0]!
      : [...starts].reverse().find((start) => start < line) ?? starts[starts.length - 1]!;
    editor.setPosition({ lineNumber: target, column: 1 });
    editor.revealLineInCenter(target);
    editor.focus();
  }, [navigate, mode]);

  return (
    <div className="relative min-h-0 flex-1" data-editor-surface={mode ?? "empty"}>
      {/* display:none, not visibility: Monaco's layers set their own visibility and would show through. */}
      <div ref={codeHostRef} className="monaco-component absolute inset-0" style={{ display: mode === "file" ? "block" : "none" }} />
      <div ref={diffHostRef} className="monaco-component absolute inset-0" style={{ display: mode === "diff" ? "block" : "none" }} />
    </div>
  );
}
