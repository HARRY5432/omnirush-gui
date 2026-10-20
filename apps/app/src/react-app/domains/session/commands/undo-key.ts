// Cmd/Ctrl+Z for the chat: undo the last turn (Shift: redo), only with focus outside any editable element.

/** A key press Cmd/Ctrl+Z may take for the chat: never from an editable element (its own undo). */
export function chatUndoKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target" | "defaultPrevented">, mac: boolean): "undo" | "redo" | null {
  if (event.defaultPrevented || event.altKey) return null;
  if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return null;
  if (event.key?.toLowerCase() !== "z") return null;
  // Only with focus outside every editable element: a text field (the composer too, even empty),
  // a code editor or a terminal keeps its own undo.
  const target = event.target as HTMLElement | null;
  if (target && typeof target === "object" && "tagName" in target) {
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return null;
    if (target.isContentEditable) return null;
    if (typeof target.closest === "function" && target.closest("[contenteditable], .monaco-editor, .xterm, .cm-editor")) return null;
  }
  return event.shiftKey ? "redo" : "undo";
}

