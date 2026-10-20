export type ThemeVariantMode = "light" | "dark";

export const SYNTAX_KEYS = [
  "keyword",
  "string",
  "number",
  "function",
  "type",
  "variable",
  "comment",
  "punctuation",
] as const;
export type SyntaxKey = (typeof SYNTAX_KEYS)[number];

export const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;
export type AnsiKey = (typeof ANSI_KEYS)[number];

export const BASE_COLOUR_KEYS = [
  "background",
  "surface",
  "surfaceRaised",
  "border",
  "text",
  "textMuted",
  "accent",
  "accentText",
  "success",
  "warn",
  "danger",
] as const;
export type BaseColourKey = (typeof BASE_COLOUR_KEYS)[number];

export const CODE_KEYS = ["bg", "fg", ...SYNTAX_KEYS] as const;
export type CodeKey = (typeof CODE_KEYS)[number];

export const TERMINAL_KEYS = ["bg", "fg", "cursor", ...ANSI_KEYS] as const;
export type TerminalKey = (typeof TERMINAL_KEYS)[number];

/** One full colour set (light or dark) of a theme. Every colour is #rrggbb. */
export type ThemeVariant = Record<BaseColourKey, string> & {
  code: Record<CodeKey, string>;
  terminal: Record<TerminalKey, string>;
  /** Decorative highlight (usage bar, connected dot). Optional. */
  highlight?: string;
};

export type ThemePreset = {
  id: string;
  name: string;
  description: string;
  target: "AA" | "AAA";
  variants: Partial<Record<ThemeVariantMode, ThemeVariant>>;
};

/** A custom theme as stored and shared (schema 1). */
export type CustomTheme = {
  v: 1;
  name: string;
  modes: ThemeVariantMode[];
  light?: ThemeVariant;
  dark?: ThemeVariant;
  radiusPx: number;
  fontSizePx: number;
};

export const RADIUS_RANGE = { min: 0, max: 16 } as const;
export const FONT_SIZE_RANGE = { min: 12, max: 16 } as const;
/** Today's corner radius (0.45rem) and body text size. */
export const DEFAULT_RADIUS_PX = 7.2;
export const DEFAULT_FONT_SIZE_PX = 13;
