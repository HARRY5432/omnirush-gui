// Cmd/Ctrl+Z for the chat: undo the last turn (Shift: redo), only with focus in the chat itself.

type KeyTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
  ownerDocument?: { querySelector?: (selector: string) => unknown } | null;
};

/**
 * A key press Cmd/Ctrl+Z may take for the chat. Never from an editable element (its own undo), never a held
 * key's auto-repeat (one press is one turn), and only with focus inside the chat pane, or on the page itself
 * while no code editor is on screen: Cmd/Ctrl+Z in the IDE's file tree, tabs, search or problems lists means
 * the editor's undo to the person, and taking a chat turn (and its file changes) back from there loses work.
 */
export function chatUndoKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target" | "defaultPrevented"> & { repeat?: boolean }, mac: boolean): "undo" | "redo" | null {
  if (event.defaultPrevented || event.altKey || event.repeat) return null;
  if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return null;
  if (event.key?.toLowerCase() !== "z") return null;
  const target = event.target as KeyTarget | null;
  if (target && typeof target === "object" && "tagName" in target) {
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return null;
    if (target.isContentEditable) return null;
    if (target.tagName === "BODY" || target.tagName === "HTML") {
      // Nothing focused: the chat's, unless a code editor shares the window (IDE layout).
      const editorOnScreen = target.ownerDocument?.querySelector?.("[data-editor-panel]");
      if (editorOnScreen) return null;
    } else {
      if (typeof target.closest !== "function") return null;
      if (target.closest("[contenteditable], .monaco-editor, .xterm, .cm-editor")) return null;
      if (!target.closest("[data-session-pane]")) return null;
    }
  }
  return event.shiftKey ? "redo" : "undo";
}
