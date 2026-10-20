/** @jsxImportSource react */
/**
 * The split editor's second group: one Monaco code editor (the only other one besides the main group's), showing
 * the same file models as the main group, so a file open in both shares its text, undo and unsaved state.
 */
import { useEffect, useRef } from "react";
import type * as MonacoApi from "monaco-editor/editor/editor.api.js";

import { monacoOptionsFor, useEditorSettings } from "./editor-settings";
import type { AgentAction } from "./editor-surface";
import { addGroupKeys, monacoThemeName, scopeEditor, type Monaco } from "./monaco";

export function Group2Editor(props: {
  monaco: Monaco;
  model: MonacoApi.editor.ITextModel | null;
  onSave: () => void;
  onFocus: () => void;
  onAgentAction: (action: AgentAction, editor: MonacoApi.editor.ICodeEditor) => void;
  onReady: (editor: MonacoApi.editor.IStandaloneCodeEditor | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const monaco = props.monaco;
    const editor = monaco.editor.create(host, {
      automaticLayout: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      padding: { top: 6, bottom: 6 },
      maxTokenizationLineLength: 20_000,
      wordBasedSuggestions: "currentDocument",
      fixedOverflowWidgets: true,
      ...monacoOptionsFor(useEditorSettings.getState()),
      model: null,
      theme: monacoThemeName(),
    });
    editorRef.current = editor;
    const disposables = [
      editor.onDidFocusEditorWidget(() => latest.current.onFocus()),
      editor.onDidBlurEditorWidget(() => window.dispatchEvent(new Event("omnirush:editor-blur"))),
    ];
    // Keys scoped to this editor (Monaco shares keybindings between editors; see scopeEditor).
    const context = scopeEditor(editor, "group2");
    disposables.push(
      editor.addAction({
        id: "omnirush.editor.saveGroup2",
        label: "Save",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        keybindingContext: context,
        run: () => latest.current.onSave(),
      }),
      addGroupKeys(monaco, editor, context),
    );
    const actions: Array<{ id: string; label: string; action: AgentAction; keys: number[]; order: number }> = [
      { id: "omnirush.agent.ask", label: "Ask about selection", action: "ask", keys: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL], order: 1 },
      { id: "omnirush.agent.explain", label: "Explain with agent", action: "explain", keys: [], order: 2 },
      { id: "omnirush.agent.refactor", label: "Refactor with agent…", action: "refactor", keys: [], order: 3 },
      { id: "omnirush.agent.tests", label: "Write tests with agent", action: "tests", keys: [], order: 4 },
    ];
    for (const item of actions) {
      disposables.push(editor.addAction({
        id: item.id,
        label: item.label,
        keybindings: item.keys,
        keybindingContext: context,
        contextMenuGroupId: "navigation",
        contextMenuOrder: item.order / 10,
        run: (target) => latest.current.onAgentAction(item.action, target),
      }));
    }
    const unsubscribe = useEditorSettings.subscribe((settings) => editor.updateOptions(monacoOptionsFor(settings)));
    latest.current.onReady(editor);
    return () => {
      latest.current.onReady(null);
      unsubscribe();
      for (const disposable of disposables) disposable.dispose();
      editor.setModel(null);
      editor.dispose();
      editorRef.current = null;
    };
  }, [props.monaco]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getModel() !== props.model) editor.setModel(props.model);
  }, [props.model]);

  return <div ref={hostRef} className="monaco-component min-h-0 flex-1" data-editor-group2-surface />;
}
