/**
 * Code editor (Monaco) and terminal (xterm) colours for the active theme.
 * Pure: monaco.ts and terminal-runtime.ts apply the results.
 */
import { fixContrast, hexToRgb, isDarkColour, rgbToHex } from "./contrast";
import type { ActiveTheme } from "./palette";
import { ANSI_KEYS, type AnsiKey } from "./types";

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

const alpha = (hex: string, a: string) => `${hex}${a}`;
const bare = (hex: string) => hex.replace(/^#/, "");

export type MonacoThemeData = {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: Array<{ token: string; foreground?: string; fontStyle?: string }>;
  colors: Record<string, string>;
};

/** Monaco's own menus and widgets (right-click menu, hover, suggest, peek) in the theme's surfaces. */
function widgetColours(w: { surface: string; text: string; border: string; selection: string; accent: string; peekEditor: string; peekList: string }): Record<string, string> {
  return {
    "menu.background": w.surface,
    "menu.foreground": w.text,
    "menu.selectionBackground": w.selection,
    "menu.selectionForeground": w.text,
    "menu.separatorBackground": w.border,
    "menu.border": w.border,
    "editorHoverWidget.background": w.surface,
    "editorHoverWidget.border": w.border,
    "editorSuggestWidget.background": w.surface,
    "editorSuggestWidget.border": w.border,
    "peekView.border": w.accent,
    "peekViewEditor.background": w.peekEditor,
    "peekViewResult.background": w.peekList,
    "peekViewTitle.background": w.peekList,
  };
}

/** Today's editor look (Default preset): background/foreground from the app stylesheet. */
export function legacyMonacoTheme(dark: boolean, background: string, foreground: string): MonacoThemeData {
  return {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": background,
      "editor.foreground": foreground,
      "editorLineNumber.foreground": dark ? "#5a6169" : "#a0a5ad",
      "editorLineNumber.activeForeground": dark ? "#b0b4ba" : "#60646c",
      "editor.lineHighlightBackground": dark ? "#18191b" : "#f5f5f7",
      "editor.lineHighlightBorder": "#00000000",
      "editorGutter.background": background,
      "editorWidget.background": dark ? "#18191b" : "#ffffff",
      "editorWidget.border": dark ? "#2e3135" : "#e0e1e6",
      "diffEditor.insertedLineBackground": dark ? "#3dd68c1f" : "#30a46c1c",
      "diffEditor.removedLineBackground": dark ? "#ff95921f" : "#e5484d1a",
      "diffEditor.insertedTextBackground": dark ? "#3dd68c33" : "#30a46c33",
      "diffEditor.removedTextBackground": dark ? "#ff959233" : "#e5484d33",
      "scrollbarSlider.background": dark ? "#ffffff1a" : "#0000001a",
      "scrollbarSlider.hoverBackground": dark ? "#ffffff29" : "#00000029",
      ...widgetColours({
        surface: dark ? "#18191b" : "#ffffff",
        text: dark ? "#edeef0" : "#1c2024",
        border: dark ? "#2e3135" : "#e0e1e6",
        selection: dark ? "#2e3135" : "#f0f0f3",
        accent: dark ? "#3b9eff" : "#0090ff",
        peekEditor: dark ? "#111113" : "#f9fbff",
        peekList: dark ? "#18191b" : "#f9f9fb",
      }),
    },
  };
}

/** Editor theme from a preset or custom theme's code, border and status colours. */
export function monacoThemeFor(active: Pick<ActiveTheme, "variant" | "mode">): MonacoThemeData {
  const v = active.variant;
  const c = v.code;
  const dark = active.mode === "dark";
  const rule = (token: string, colour: string, fontStyle?: string) => ({
    token,
    foreground: bare(colour),
    ...(fontStyle ? { fontStyle } : {}),
  });
  return {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      rule("", c.fg),
      rule("comment", c.comment, "italic"),
      rule("comment.doc", c.comment, "italic"),
      rule("keyword", c.keyword),
      rule("keyword.flow", c.keyword),
      rule("storage", c.keyword),
      rule("string", c.string),
      rule("string.escape", c.number),
      rule("regexp", c.string),
      rule("number", c.number),
      rule("number.hex", c.number),
      rule("constant", c.number),
      rule("type", c.type),
      rule("type.identifier", c.type),
      rule("tag", c.type),
      rule("attribute.name", c.function),
      rule("attribute.value", c.string),
      rule("predefined", c.function),
      rule("function", c.function),
      rule("identifier", c.variable),
      rule("variable", c.variable),
      rule("variable.predefined", c.function),
      rule("delimiter", c.punctuation),
      rule("delimiter.bracket", c.punctuation),
      rule("operator", c.punctuation),
      rule("metatag", c.keyword),
      rule("annotation", c.function),
    ],
    colors: {
      "editor.background": c.bg,
      "editor.foreground": c.fg,
      "editorCursor.foreground": v.accent,
      "editorLineNumber.foreground": mix(c.bg, v.textMuted, 0.75),
      "editorLineNumber.activeForeground": c.fg,
      "editor.lineHighlightBackground": mix(c.bg, c.fg, 0.06),
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": alpha(v.accent, "40"),
      "editor.inactiveSelectionBackground": alpha(v.accent, "26"),
      "editorGutter.background": c.bg,
      "editorWidget.background": v.surfaceRaised,
      "editorWidget.border": v.border,
      "editorIndentGuide.background1": alpha(c.fg, "1a"),
      "diffEditor.insertedLineBackground": alpha(v.success, "1f"),
      "diffEditor.removedLineBackground": alpha(v.danger, "1f"),
      "diffEditor.insertedTextBackground": alpha(v.success, "33"),
      "diffEditor.removedTextBackground": alpha(v.danger, "33"),
      "scrollbarSlider.background": alpha(c.fg, "1a"),
      "scrollbarSlider.hoverBackground": alpha(c.fg, "29"),
      ...widgetColours({
        surface: v.surfaceRaised,
        text: v.text,
        border: v.border,
        selection: mix(v.surfaceRaised, v.text, 0.1),
        accent: v.accent,
        peekEditor: c.bg,
        peekList: v.surface,
      }),
    },
  };
}

export type XtermTheme = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent?: string;
  selectionBackground: string;
} & Partial<Record<AnsiKey, string>>;

/** Today's terminal look (Default preset). */
export const LEGACY_XTERM_THEME: XtermTheme = {
  background: "#0b0d12",
  foreground: "#d7dde8",
  cursor: "#ffffff",
  selectionBackground: "#334155",
};

export function xtermThemeFor(active: Pick<ActiveTheme, "variant" | "legacy">): XtermTheme {
  if (active.legacy) return LEGACY_XTERM_THEME;
  const t = active.variant.terminal;
  const theme: XtermTheme = {
    background: t.bg,
    foreground: t.fg,
    cursor: t.cursor,
    cursorAccent: t.bg,
    selectionBackground: mix(t.bg, t.fg, 0.25),
  };
  for (const key of ANSI_KEYS) theme[key] = t[key];
  // On a light terminal, "white" text must still be visible (3:1).
  if (!isDarkColour(t.bg)) {
    theme.white = fixContrast(t.white, t.bg, 3);
    theme.brightWhite = fixContrast(t.brightWhite, t.bg, 3);
  }
  return theme;
}
