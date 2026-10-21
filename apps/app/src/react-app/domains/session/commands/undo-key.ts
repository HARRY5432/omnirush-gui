// Cmd/Ctrl+Z for the chat: undo the last turn (Shift: redo), only with focus in the chat transcript itself.

type KeyTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => { getAttribute?: (name: string) => string | null } | null;
};

/** Anything with a key meaning of its own: fields, editors, terminals, buttons, links, lists, trees, menus. */
const OWN_KEYS = [
  "input", "textarea", "select", "button", "a[href]", "[contenteditable]", ".monaco-editor", ".xterm", ".cm-editor",
  "[role=button]", "[role=textbox]", "[role=tree]", "[role=treeitem]", "[role=listbox]", "[role=option]", "[role=menu]",
  "[role=menuitem]", "[role=searchbox]", "[role=tab]", "[data-composer-shell]", "[data-editor-panel]",
].join(", ");

/**
 * A key press Cmd/Ctrl+Z may take for the chat. Only with focus explicitly inside the chat transcript
 * (`[data-chat-transcript]`, focused by a click in it), never from anything with its own keys (a field,
 * the composer, a code editor, the IDE's file tree, tabs, search or problems lists, a button), never from
 * the page itself (nothing focused), and never a held key's auto-repeat: one press is one turn at most.
 * With `sessionId`, only this chat's own transcript (a split view shows a second chat beside it).
 */
export function chatUndoKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target" | "defaultPrevented"> & { repeat?: boolean }, mac: boolean, sessionId?: string): "undo" | "redo" | null {
  if (event.defaultPrevented || event.altKey || event.repeat) return null;
  if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return null;
  if (event.key?.toLowerCase() !== "z") return null;
  const target = event.target as KeyTarget | null;
  if (!target || typeof target !== "object" || typeof target.closest !== "function") return null;
  if (target.isContentEditable) return null;
  if (target.closest(OWN_KEYS)) return null;
  if (!target.closest("[data-chat-transcript]")) return null;
  if (sessionId !== undefined && target.closest("[data-session-surface-id]")?.getAttribute?.("data-session-surface-id") !== sessionId) return null;
  return event.shiftKey ? "redo" : "undo";
}
