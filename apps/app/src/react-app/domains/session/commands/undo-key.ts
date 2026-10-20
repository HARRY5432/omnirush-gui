// Cmd/Ctrl+Z for the chat: undo the last turn (Shift: redo), never a text field's own undo.

/** A key press Cmd/Ctrl+Z may take for the chat: never from a text field that has text (its own undo). */
export function chatUndoKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target" | "defaultPrevented">, mac: boolean): "undo" | "redo" | null {
  if (event.defaultPrevented || event.altKey) return null;
  if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return null;
  if (event.key?.toLowerCase() !== "z") return null;
  const target = event.target as HTMLElement | null;
  if (target && typeof target === "object" && "tagName" in target) {
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return null;
    // Code editors and terminals keep their own undo, whatever element holds their focus.
    if (typeof target.closest === "function" && target.closest(".monaco-editor, .xterm, .cm-editor")) return null;
    if (target.isContentEditable && (target.textContent ?? "").replace(/[\u200B\uFEFF]/g, "").trim().length > 0) return null;
  }
  return event.shiftKey ? "redo" : "undo";
}

