/**
 * The code editor's settings (Settings → Editor): text, saving and keys. One set for every project on this
 * computer, kept in localStorage. Language features stay in the editor store (`languageFeatures`).
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type AutoSave = "off" | "afterDelay" | "onFocusChange";

export type EditorSettings = {
  fontSize: number;
  /** Used when a file shows no indentation of its own. */
  tabSize: 2 | 4 | 8;
  wordWrap: boolean;
  minimap: boolean;
  stickyScroll: boolean;
  autoSave: AutoSave;
  formatOnSave: boolean;
};

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 13,
  tabSize: 4,
  wordWrap: false,
  minimap: false,
  stickyScroll: true,
  autoSave: "off",
  formatOnSave: false,
};

export const EDITOR_FONT_SIZES = [12, 13, 14, 15, 16, 18, 20, 22, 24] as const;
/** "After a delay": this long after the last keystroke. */
export const AUTO_SAVE_DELAY_MS = 1000;

type EditorSettingsStore = EditorSettings & {
  set: <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => void;
  reset: () => void;
};

export const useEditorSettings = create<EditorSettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_EDITOR_SETTINGS,
      set: (key, value) => set({ [key]: value } as Pick<EditorSettings, typeof key>),
      reset: () => set(DEFAULT_EDITOR_SETTINGS),
    }),
    {
      name: "omnirush:editor-settings:v1",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ fontSize, tabSize, wordWrap, minimap, stickyScroll, autoSave, formatOnSave }) => ({
        fontSize, tabSize, wordWrap, minimap, stickyScroll, autoSave, formatOnSave,
      }),
    },
  ),
);

/** Monaco options for the current settings (editor-level; tab size applies per model). */
export function monacoOptionsFor(settings: EditorSettings) {
  return {
    fontSize: settings.fontSize,
    lineHeight: Math.round(settings.fontSize * 1.5),
    wordWrap: settings.wordWrap ? ("on" as const) : ("off" as const),
    minimap: { enabled: settings.minimap },
    stickyScroll: { enabled: settings.stickyScroll, maxLineCount: 3, defaultModel: "indentationModel" as const },
  };
}

/** The editor keys, VS Code's defaults (the Keys list in Settings → Editor). */
export const EDITOR_SHORTCUTS: Array<{ keys: string; action: string }> = [
  { keys: "Cmd/Ctrl+P", action: "Go to file" },
  { keys: "Cmd/Ctrl+Shift+P", action: "Command palette" },
  { keys: "Cmd/Ctrl+Shift+F", action: "Search in files" },
  { keys: "Cmd/Ctrl+Shift+O", action: "Go to symbol in file" },
  { keys: "F12 / Cmd/Ctrl+click", action: "Go to definition" },
  { keys: "Shift+F12", action: "Find references" },
  { keys: "F2", action: "Rename symbol" },
  { keys: "F8", action: "Next problem" },
  { keys: "Cmd/Ctrl+S", action: "Save" },
  { keys: "Cmd/Ctrl+\\", action: "Split editor" },
  { keys: "Cmd/Ctrl+K Cmd/Ctrl+Left / Right", action: "Focus the other editor group" },
  { keys: "Cmd/Ctrl+K V", action: "Markdown preview in the other group" },
  { keys: "Cmd/Ctrl+Shift+V", action: "Markdown preview in this group" },
  { keys: "Cmd/Ctrl+L", action: "Ask about selection" },
  { keys: "Cmd/Ctrl+J", action: "Show or hide the bottom panel" },
  { keys: "Ctrl+`", action: "Terminal" },
  { keys: "Cmd/Ctrl+F / Cmd/Ctrl+H", action: "Find / replace in file" },
  { keys: "Cmd/Ctrl+/", action: "Toggle line comment" },
  { keys: "Alt+Up / Alt+Down", action: "Move line" },
];
