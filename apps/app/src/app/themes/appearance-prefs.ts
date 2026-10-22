/**
 * Per-device appearance choices that sit on top of any theme: accent colour,
 * fonts, density, corner radius, text size and the wallpaper look. Stored in
 * localStorage as JSON; every field is validated on read, so a hand-edited or
 * damaged value falls back to the default instead of reaching CSS.
 */
import { contrastRatio, suggestColour, TEXT_TARGET, UI_TARGET } from "./contrast";
import { FONT_SIZE_RANGE, RADIUS_RANGE, type ThemeVariant } from "./types";

export const APPEARANCE_PREFS_KEY = "omnirush.react.settings.appearance";
export const MAX_PREFS_BYTES = 4 * 1024;

const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

/** Interface fonts. Font stacks are fixed strings; stored prefs only ever hold an id. */
export const UI_FONTS = [
  { id: "system", label: "System default", stack: null },
  { id: "geist", label: "Geist", stack: '"Geist Variable", system-ui, sans-serif' },
  { id: "plex", label: "IBM Plex Sans", stack: '"IBM Plex Sans Variable", system-ui, sans-serif' },
  { id: "humanist", label: "Verdana / DejaVu Sans", stack: 'Verdana, "DejaVu Sans", "Bitstream Vera Sans", sans-serif' },
  { id: "serif", label: "Serif (Charter / Georgia)", stack: 'Charter, "Bitstream Charter", Georgia, "Times New Roman", serif' },
  { id: "mono", label: "Same as code font", stack: null },
] as const;

/** Code fonts. Named ones are used when installed; the system monospace font fills in otherwise. */
export const CODE_FONTS = [
  { id: "system", label: "System monospace", stack: SYSTEM_MONO },
  { id: "jetbrains", label: "JetBrains Mono", stack: `"JetBrains Mono", ${SYSTEM_MONO}` },
  { id: "fira", label: "Fira Code", stack: `"Fira Code", "Fira Mono", ${SYSTEM_MONO}` },
  { id: "cascadia", label: "Cascadia Code", stack: `"Cascadia Code", "Cascadia Mono", ${SYSTEM_MONO}` },
  { id: "sf", label: "SF Mono / Menlo", stack: `"SF Mono", Menlo, Monaco, ${SYSTEM_MONO}` },
  { id: "courier", label: "Courier / Liberation Mono", stack: `"Courier New", Courier, "Liberation Mono", monospace` },
] as const;

export type UiFontId = (typeof UI_FONTS)[number]["id"];
export type CodeFontId = (typeof CODE_FONTS)[number]["id"];
export type Density = "comfortable" | "compact";

/** Accent swatches offered next to the custom colour field. */
export const ACCENT_SWATCHES = [
  { name: "Blue", hex: "#3b6fe0" },
  { name: "Violet", hex: "#7c4ddb" },
  { name: "Pink", hex: "#d52d86" },
  { name: "Red", hex: "#d83737" },
  { name: "Orange", hex: "#ba5a0d" },
  { name: "Green", hex: "#208459" },
  { name: "Teal", hex: "#13808c" },
  { name: "Graphite", hex: "#55595f" },
] as const;

export const WALLPAPER_DIM_RANGE = { min: 0, max: 80 } as const;
/** Panels never go below 55% so text over a busy picture stays readable. */
export const PANEL_OPACITY_RANGE = { min: 55, max: 100 } as const;
export const PANEL_BLUR_RANGE = { min: 0, max: 24 } as const;

export type AppearancePrefs = {
  /** #rrggbb, or null for the theme's own accent. */
  accent: string | null;
  uiFont: UiFontId;
  codeFont: CodeFontId;
  density: Density;
  /** Null follows the theme. */
  radiusPx: number | null;
  /** Null follows the theme. */
  fontSizePx: number | null;
  /** A wallpaper image is stored on this device (IndexedDB). */
  wallpaper: boolean;
  wallpaperDim: number;
  panelOpacity: number;
  panelBlur: number;
};

export const DEFAULT_APPEARANCE_PREFS: Readonly<AppearancePrefs> = Object.freeze({
  accent: null,
  uiFont: "system",
  codeFont: "system",
  density: "comfortable",
  radiusPx: null,
  fontSizePx: null,
  wallpaper: false,
  wallpaperDim: 30,
  panelOpacity: 82,
  panelBlur: 12,
});

const HEX = /^#[0-9a-f]{6}$/;

export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim().toLowerCase();
  if (!text.startsWith("#")) text = `#${text}`;
  if (/^#[0-9a-f]{3}$/.test(text)) text = `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  return HEX.test(text) ? text : null;
}

const clampInt = (value: unknown, range: { min: number; max: number }, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, Math.round(value))) : fallback;

const nullableInRange = (value: unknown, range: { min: number; max: number }) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : null;

const oneOf = <T extends string>(value: unknown, ids: readonly { id: T }[], fallback: T): T =>
  ids.some((item) => item.id === value) ? (value as T) : fallback;

/** Field-by-field read: unknown keys are dropped, bad values become defaults. */
export function sanitizeAppearancePrefs(input: unknown): AppearancePrefs {
  const d = DEFAULT_APPEARANCE_PREFS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...d };
  const raw = input as Record<string, unknown>;
  return {
    accent: normalizeHex(raw.accent),
    uiFont: oneOf(raw.uiFont, UI_FONTS, d.uiFont),
    codeFont: oneOf(raw.codeFont, CODE_FONTS, d.codeFont),
    density: raw.density === "compact" ? "compact" : "comfortable",
    radiusPx: nullableInRange(raw.radiusPx, RADIUS_RANGE),
    fontSizePx: nullableInRange(raw.fontSizePx, FONT_SIZE_RANGE),
    wallpaper: raw.wallpaper === true,
    wallpaperDim: clampInt(raw.wallpaperDim, WALLPAPER_DIM_RANGE, d.wallpaperDim),
    panelOpacity: clampInt(raw.panelOpacity, PANEL_OPACITY_RANGE, d.panelOpacity),
    panelBlur: clampInt(raw.panelBlur, PANEL_BLUR_RANGE, d.panelBlur),
  };
}

export function parseAppearancePrefs(text: string | null): AppearancePrefs {
  if (!text || text.length > MAX_PREFS_BYTES) return { ...DEFAULT_APPEARANCE_PREFS };
  try {
    return sanitizeAppearancePrefs(JSON.parse(text));
  } catch {
    return { ...DEFAULT_APPEARANCE_PREFS };
  }
}

export function uiFontStack(prefs: Pick<AppearancePrefs, "uiFont" | "codeFont">): string | null {
  if (prefs.uiFont === "mono") return codeFontStack(prefs);
  return UI_FONTS.find((font) => font.id === prefs.uiFont)?.stack ?? null;
}

export function codeFontStack(prefs: Pick<AppearancePrefs, "codeFont">): string {
  return CODE_FONTS.find((font) => font.id === prefs.codeFont)?.stack ?? SYSTEM_MONO;
}

/** Black or white text on an accent fill, whichever reads better. */
export function textOnAccent(accent: string): string {
  return contrastRatio("#ffffff", accent) >= contrastRatio("#000000", accent) ? "#ffffff" : "#000000";
}

/** The theme variant with the chosen accent (button text picked for contrast). */
export function withAccent(variant: ThemeVariant, accent: string | null): ThemeVariant {
  if (!accent) return variant;
  return { ...variant, accent, accentText: textOnAccent(accent), highlight: variant.highlight ? accent : variant.highlight };
}

export type AccentCheck = {
  /** Accent against the page and raised surfaces (UI target 3:1). */
  uiRatio: number;
  /** Button text on the accent (text target 4.5:1). */
  textRatio: number;
  ok: boolean;
  /** Nearest colour that passes both, when this one does not. */
  suggestion: string | null;
};

/** WCAG check for an accent on a theme variant: buttons, focus rings and selection must stay visible. */
export function checkAccent(variant: ThemeVariant, accent: string): AccentCheck {
  const backgrounds = [variant.background, variant.surfaceRaised];
  const uiRatio = Math.min(...backgrounds.map((bg) => contrastRatio(accent, bg)));
  const textRatio = contrastRatio(textOnAccent(accent), accent);
  const ok = uiRatio >= UI_TARGET && textRatio >= TEXT_TARGET;
  if (ok) return { uiRatio, textRatio, ok, suggestion: null };
  // Walk the visible-colour fix until the button text also reaches AA.
  let candidate = suggestColour(accent, backgrounds, UI_TARGET);
  for (let step = 0; step < 40 && contrastRatio(textOnAccent(candidate), candidate) < TEXT_TARGET; step += 1) {
    candidate = suggestColour(candidate, backgrounds, UI_TARGET + 0.25 * (step + 1));
  }
  const passes =
    Math.min(...backgrounds.map((bg) => contrastRatio(candidate, bg))) >= UI_TARGET &&
    contrastRatio(textOnAccent(candidate), candidate) >= TEXT_TARGET;
  return { uiRatio, textRatio, ok, suggestion: passes ? candidate : null };
}
