/**
 * Turns a theme variant into values for the CSS custom properties the app
 * already uses (index.css, colors.css), and applies them on <html> with
 * style.setProperty. Only names from this module and only validated values
 * (#rrggbb, #rrggbbaa, "r g b", px and plain numbers) are ever written.
 */
import { contrastRatio, hexToRgb, isDarkColour, rgbToHex, textSafeAccent } from "./contrast";
import { THEME_PRESETS } from "./presets";
import {
  DEFAULT_FONT_SIZE_PX,
  DEFAULT_RADIUS_PX,
  FONT_SIZE_RANGE,
  RADIUS_RANGE,
  SYNTAX_KEYS,
  type CustomTheme,
  type ThemePreset,
  type ThemeVariant,
  type ThemeVariantMode,
} from "./types";

export const DEFAULT_PRESET_ID = "default";
export const CUSTOM_THEME_ID = "custom";

export type ThemeSelection = { kind: "preset"; id: string } | { kind: "custom" };

export type ActiveTheme = {
  selection: ThemeSelection;
  /** The light/dark the window actually shows (Midnight is always dark). */
  mode: ThemeVariantMode;
  variant: ThemeVariant;
  /**
   * Default preset: the app keeps its stylesheet colours (today's look); only
   * the contrast fixes are applied, and the editor/terminal keep their own look.
   */
  legacy: boolean;
  radiusPx: number;
  fontSizePx: number;
};

export function findPreset(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((preset) => preset.id === id);
}

export function presetModes(preset: Pick<ThemePreset, "variants">): ThemeVariantMode[] {
  return (["light", "dark"] as const).filter((mode) => Boolean(preset.variants[mode]));
}

/** The variant a preset or custom theme shows for the wanted mode (its only one when it has one). */
export function pickVariant(
  variants: Partial<Record<ThemeVariantMode, ThemeVariant>>,
  wanted: ThemeVariantMode,
): { mode: ThemeVariantMode; variant: ThemeVariant } | null {
  const exact = variants[wanted];
  if (exact) return { mode: wanted, variant: exact };
  const other: ThemeVariantMode = wanted === "light" ? "dark" : "light";
  const fallback = variants[other];
  return fallback ? { mode: other, variant: fallback } : null;
}

/** Preset x mode (x system, already resolved by the caller) -> the theme the window shows. */
export function resolveActiveTheme(
  selection: ThemeSelection,
  wanted: ThemeVariantMode,
  custom: CustomTheme | null,
): ActiveTheme {
  if (selection.kind === "custom" && custom) {
    const picked = pickVariant(custom, wanted);
    if (picked) {
      return {
        selection,
        ...picked,
        legacy: false,
        radiusPx: custom.radiusPx,
        fontSizePx: custom.fontSizePx,
      };
    }
  }
  const preset = (selection.kind === "preset" ? findPreset(selection.id) : undefined) ?? findPreset(DEFAULT_PRESET_ID)!;
  const picked = pickVariant(preset.variants, wanted)!;
  const effectiveSelection: ThemeSelection = { kind: "preset", id: preset.id };
  return {
    selection: effectiveSelection,
    ...picked,
    legacy: preset.id === DEFAULT_PRESET_ID,
    radiusPx: DEFAULT_RADIUS_PX,
    fontSizePx: DEFAULT_FONT_SIZE_PX,
  };
}

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

function withAlpha(hex: string, alpha: number): string {
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  return `${hex}${a.toString(16).padStart(2, "0")}`;
}

function rgbTriplet(hex: string): string {
  return hexToRgb(hex)
    .map((c) => Math.round(c * 255))
    .join(" ");
}

// Steps of the neutral (gray/slate) scale as a blend from background (1) to text (12),
// close to Radix slate's spacing; 2 = surface, 5 = border and 11 = muted text are exact.
const NEUTRAL_MIX = [0, 0, 0, 0, 0, 0.15, 0.2, 0.28, 0.45, 0.5, 0, 1];
const NEUTRAL_ALPHA = [0.012, 0.027, 0.06, 0.09, 0.12, 0.15, 0.2, 0.28, 0.45, 0.5, 0.62, 0.9];

function subtleFill(v: ThemeVariant, amount: number): string {
  for (let t = amount; t > 0.015; t -= 0.01) {
    const fill = mix(v.surface, v.text, t);
    if (contrastRatio(v.textMuted, fill) >= 4.5) return fill;
  }
  return v.surface;
}

function neutralScale(v: ThemeVariant): string[] {
  return NEUTRAL_MIX.map((t, index) => {
    if (index === 0) return v.background;
    if (index === 1) return v.surface;
    // Steps 3 and 4 fill subtle controls (chips, hovers, the user's message): visibly off the
    // page and the surface, while muted text on them keeps 4.5:1.
    if (index === 2) return subtleFill(v, 0.07);
    if (index === 3) return subtleFill(v, 0.11);
    if (index === 4) return v.border;
    if (index === 10) return v.textMuted;
    if (index === 11) return v.text;
    return mix(v.background, v.text, t);
  });
}

/** Contrast fixes applied on top of today's stylesheet for the Default preset. */
const DEFAULT_PRESET_FIXES: Record<ThemeVariantMode, Record<string, string>> = {
  light: {},
  // Muted text in dark mode was 4.2:1 (slate-10); the design's fix is #858991 (4.5:1+).
  dark: { "--muted-foreground": "#858991" },
};

/** CSS custom property name -> value for an active theme. */
export function paletteVars(active: Pick<ActiveTheme, "variant" | "mode" | "legacy" | "radiusPx" | "fontSizePx">, darkVariant?: ThemeVariant | null): Record<string, string> {
  if (active.legacy) return { ...DEFAULT_PRESET_FIXES[active.mode] };
  const v = active.variant;
  const dark = isDarkColour(v.background);
  const scale = neutralScale(v);
  const vars: Record<string, string> = {};
  const set = (names: string[], value: string) => {
    for (const name of names) vars[name] = value;
  };
  set(["--background", "--dls-background", "--dls-app-bg"], v.background);
  set(["--card", "--dls-surface", "--sidebar", "--dls-sidebar", "--dls-canvas"], v.surface);
  // Subtle fills must stand out from the page and from surface-coloured cards.
  set(["--secondary", "--muted"], scale[2]!);
  set(["--popover", "--dls-surface-muted"], v.surfaceRaised);
  set(["--border", "--dls-border", "--sidebar-border", "--popover-border"], v.border);
  set(["--input"], mix(v.border, v.textMuted, 0.25));
  set(
    [
      "--foreground",
      "--dls-text-primary",
      "--card-foreground",
      "--popover-foreground",
      "--secondary-foreground",
      "--accent-foreground",
      "--sidebar-foreground",
      "--sidebar-accent-foreground",
    ],
    v.text,
  );
  set(["--muted-foreground", "--dls-text-secondary"], v.textMuted);
  set(["--primary", "--dls-accent", "--sidebar-primary", "--ring", "--sidebar-ring"], v.accent);
  set(["--primary-foreground", "--dls-accent-fg", "--sidebar-primary-foreground"], v.accentText);
  set(["--dls-accent-hover"], mix(v.accent, dark ? "#ffffff" : "#000000", 0.12));
  set(["--dls-accent-rgb"], rgbTriplet(v.accent));
  set(["--dls-secondary-rgb"], rgbTriplet(v.textMuted));
  set(["--accent", "--sidebar-accent", "--dls-hover"], scale[2]!);
  set(["--dls-active"], scale[4]!);
  set(["--destructive"], v.danger);
  set(["--warning"], v.warn);
  set(["--omnirush-success"], v.success);
  set(["--omnirush-highlight"], v.highlight ?? v.accent);
  set(["--omnirush-link"], textSafeAccent(v));
  set(["--omnirush-terminal-bg"], v.terminal.bg);
  set(["--omnirush-terminal-fg"], v.terminal.fg);
  set(["--omnirush-terminal-header"], mix(v.terminal.bg, v.terminal.fg, 0.06));
  set(["--omnirush-terminal-input"], v.terminal.bg);
  set(["--omnirush-code-bg"], v.code.bg);
  set(["--omnirush-code-fg"], v.code.fg);
  for (const key of SYNTAX_KEYS) set([`--omnirush-syntax-${key}`], v.code[key]);
  if (darkVariant) set(["--omnirush-gate-bg"], darkVariant.background);
  scale.forEach((value, index) => set([`--gray-${index + 1}`, `--slate-${index + 1}`], value));
  NEUTRAL_ALPHA.forEach((alpha, index) => set([`--gray-a${index + 1}`, `--slate-a${index + 1}`], withAlpha(v.text, alpha)));
  const radius = Math.min(RADIUS_RANGE.max, Math.max(RADIUS_RANGE.min, active.radiusPx));
  if (radius !== DEFAULT_RADIUS_PX) vars["--radius"] = `${radius}px`;
  const fontSize = Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, active.fontSizePx));
  if (fontSize !== DEFAULT_FONT_SIZE_PX) vars["--omnirush-theme-font-scale"] = String(Math.round((fontSize / DEFAULT_FONT_SIZE_PX) * 10000) / 10000);
  return vars;
}

const VAR_NAME = /^--[a-z0-9-]+$/;
const VAR_VALUE = /^(#[0-9a-f]{6}([0-9a-f]{2})?|\d{1,3} \d{1,3} \d{1,3}|\d+(\.\d+)?(px)?)$/;

/** True for values this module produces; anything else is never written to CSS. */
export function isSafeVar(name: string, value: string): boolean {
  return VAR_NAME.test(name) && VAR_VALUE.test(value);
}

let appliedNames: string[] = [];

/** Writes the variables on <html>, removing ones a previous theme set. */
export function applyPaletteVars(
  style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty" | "getPropertyValue">,
  vars: Record<string, string>,
): void {
  seedFromStyle(style);
  const next = Object.entries(vars).filter(([name, value]) => isSafeVar(name, value));
  const nextNames = new Set(next.map(([name]) => name));
  for (const name of appliedNames) {
    if (!nextNames.has(name)) style.removeProperty(name);
  }
  for (const [name, value] of next) style.setProperty(name, value);
  appliedNames = [...nextNames];
}

/** Every variable name a theme can set (the early inline script may have set any of them). */
export function allPaletteVarNames(): string[] {
  const preset = findPreset("fjord")!;
  const names = Object.keys(
    paletteVars(
      { variant: preset.variants.light!, mode: "light", legacy: false, radiusPx: 0, fontSizePx: FONT_SIZE_RANGE.max },
      preset.variants.dark,
    ),
  );
  return [...new Set([...names, ...Object.keys(DEFAULT_PRESET_FIXES.dark)])];
}

let seeded = false;

/** Adopts variables the early inline script set, so a changed theme removes them. */
function seedFromStyle(style: Pick<CSSStyleDeclaration, "getPropertyValue">): void {
  if (seeded) return;
  seeded = true;
  appliedNames = allPaletteVarNames().filter((name) => style.getPropertyValue(name) !== "");
}

export function resetAppliedPaletteForTests(): void {
  seeded = false;
  appliedNames = [];
}
