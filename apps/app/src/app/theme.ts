import {
  CUSTOM_THEME_ID,
  DEFAULT_PRESET_ID,
  applyPaletteVars,
  findPreset,
  isSafeVar,
  paletteVars,
  resolveActiveTheme,
  type ActiveTheme,
  type ThemeSelection,
} from "./themes/palette";
import { parseThemeJson, serializeTheme } from "./themes/share";
import type { CustomTheme, ThemeVariantMode } from "./themes/types";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedThemeMode = "light" | "dark";
export type { ActiveTheme, ThemeSelection } from "./themes/palette";

const THEME_PREF_KEY = "omnirush.react.settings.theme-mode";
const LEGACY_THEME_PREF_KEYS = ["omnirush.themePref"];
export const THEME_PRESET_KEY = "omnirush.react.settings.theme-preset";
export const THEME_CUSTOM_KEY = "omnirush.react.settings.theme-custom";
/** Variables for both modes, read by the inline script in index.html before the bundle loads. */
export const THEME_BOOT_KEY = "omnirush.react.settings.theme-boot";

const mediaQuery = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();
let currentMode: ThemeMode | null = null;
let currentSelection: ThemeSelection | null = null;
let customTheme: CustomTheme | null | undefined;
let previewTheme: CustomTheme | null = null;
let activeTheme: ActiveTheme | null = null;
let systemThemeCleanup: (() => void) | null = null;

const getMediaQueryList = () =>
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia(mediaQuery);

const isThemeMode = (value: string | null): value is ThemeMode =>
  value === "light" || value === "dark" || value === "system";

const storage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const readStoredMode = (): ThemeMode => {
  const store = storage();
  if (!store) return "system";
  try {
    const stored = store.getItem(THEME_PREF_KEY);
    if (isThemeMode(stored)) {
      return stored;
    }

    for (const key of LEGACY_THEME_PREF_KEYS) {
      const legacyStored = store.getItem(key);
      if (isThemeMode(legacyStored)) {
        store.setItem(THEME_PREF_KEY, legacyStored);
        return legacyStored;
      }
    }
  } catch {
    // ignore
  }
  return "system";
};

const readStoredSelection = (): ThemeSelection => {
  try {
    const stored = storage()?.getItem(THEME_PRESET_KEY);
    if (stored === CUSTOM_THEME_ID) return { kind: "custom" };
    if (stored && findPreset(stored)) return { kind: "preset", id: stored };
  } catch {
    // ignore
  }
  return { kind: "preset", id: DEFAULT_PRESET_ID };
};

const readStoredCustomTheme = (): CustomTheme | null => {
  try {
    const stored = storage()?.getItem(THEME_CUSTOM_KEY);
    if (!stored) return null;
    const parsed = parseThemeJson(stored);
    return parsed.ok ? parsed.theme : null;
  } catch {
    return null;
  }
};

const resolveMode = (mode: ThemeMode): ResolvedThemeMode => {
  if (mode !== "system") return mode;
  return getMediaQueryList()?.matches ? "dark" : "light";
};

const getCurrentMode = () => {
  if (currentMode === null) {
    currentMode = readStoredMode();
  }
  return currentMode;
};

const getCurrentSelection = () => {
  if (currentSelection === null) currentSelection = readStoredSelection();
  return currentSelection;
};

export const getCustomTheme = (): CustomTheme | null => {
  if (customTheme === undefined) customTheme = readStoredCustomTheme();
  return customTheme;
};

/** The theme to show: the preview being edited/imported, else the saved choice. */
const computeActiveTheme = (wanted: ResolvedThemeMode): ActiveTheme => {
  if (previewTheme) return resolveActiveTheme({ kind: "custom" }, wanted, previewTheme);
  return resolveActiveTheme(getCurrentSelection(), wanted, getCustomTheme());
};

const darkVariantOf = (active: ActiveTheme) => {
  if (active.selection.kind === "custom") return (previewTheme ?? getCustomTheme())?.dark ?? null;
  return findPreset(active.selection.id)?.variants.dark ?? null;
};

/** Saves both modes' variables so the next start can paint them before the bundle runs. */
const persistBootVars = () => {
  if (previewTheme) return;
  const store = storage();
  if (!store) return;
  try {
    const light = computeActiveTheme("light");
    const dark = computeActiveTheme("dark");
    const only = light.mode === dark.mode ? light.mode : null;
    const boot = {
      only,
      light: paletteVars(light, darkVariantOf(light)),
      dark: paletteVars(dark, darkVariantOf(dark)),
    };
    store.setItem(THEME_BOOT_KEY, JSON.stringify(boot));
  } catch {
    // ignore
  }
};

const applyTheme = (mode: ThemeMode) => {
  const active = computeActiveTheme(resolveMode(mode));
  activeTheme = active;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = active.mode;
  root.style.colorScheme = active.mode;
  if (active.legacy) delete root.dataset.omnirushPalette;
  else root.dataset.omnirushPalette = active.selection.kind === "custom" ? CUSTOM_THEME_ID : active.selection.id;
  applyPaletteVars(root.style, paletteVars(active, darkVariantOf(active)));
  syncThemeColorMeta(active);
};

/** The browser/OS chrome colour (<meta name="theme-color">) follows the theme; Default keeps index.html's. */
const syncThemeColorMeta = (active: ActiveTheme) => {
  if (typeof document.querySelectorAll !== "function") return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (meta.dataset.omnirushDefault === undefined) meta.dataset.omnirushDefault = meta.content;
    meta.content = active.legacy ? meta.dataset.omnirushDefault : active.variant.background;
  }
};

const emitThemeChange = () => {
  for (const listener of listeners) {
    listener();
  }
};

const syncNativeTheme = (mode: ThemeMode) => {
  if (typeof window === "undefined") return;
  // A dark-only theme (Midnight) keeps native chrome dark even when the mode says light.
  const active = activeTheme;
  const native: ThemeMode = active && active.mode !== resolveMode(mode) ? active.mode : mode;
  void window.__OMNIRUSH_ELECTRON__?.invokeDesktop?.("__setNativeTheme", native);
};

const handleSystemThemeChange = () => {
  if (getCurrentMode() !== "system") return;
  applyTheme("system");
  syncNativeTheme("system");
  emitThemeChange();
};

const ensureSystemThemeSubscription = () => {
  if (systemThemeCleanup || typeof window === "undefined") return;

  const list = getMediaQueryList();
  if (!list) return;

  list.addEventListener("change", handleSystemThemeChange);
  systemThemeCleanup = () => list.removeEventListener("change", handleSystemThemeChange);
};

const reapply = () => {
  const mode = getCurrentMode();
  applyTheme(mode);
  syncNativeTheme(mode);
  emitThemeChange();
};

export const bootstrapTheme = () => {
  const mode = getCurrentMode();
  applyTheme(mode);
  syncNativeTheme(mode);
  ensureSystemThemeSubscription();
  // Once per start: the early script's copy of the colours matches this build's presets.
  persistBootVars();
};

export const getInitialThemeMode = () => getCurrentMode();

/** The light/dark the window shows (a dark-only theme reports dark). */
export const getResolvedThemeMode = (): ResolvedThemeMode => getActiveTheme().mode;

export const getActiveTheme = (): ActiveTheme => {
  if (!activeTheme) activeTheme = computeActiveTheme(resolveMode(getCurrentMode()));
  return activeTheme;
};

export const getThemeSelection = (): ThemeSelection => getCurrentSelection();

export const isThemePreviewActive = () => previewTheme !== null;

const persistThemeMode = (mode: ThemeMode) => {
  try {
    storage()?.setItem(THEME_PREF_KEY, mode);
  } catch {
    // ignore
  }
};

export const subscribeToTheme = (onChange: () => void) => {
  ensureSystemThemeSubscription();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
};

export const setThemeMode = (mode: ThemeMode) => {
  currentMode = mode;
  persistThemeMode(mode);
  ensureSystemThemeSubscription();
  reapply();
  persistBootVars();
};

/** Picks a preset or the saved custom theme. */
export const setThemeSelection = (selection: ThemeSelection) => {
  const next: ThemeSelection =
    selection.kind === "preset" && !findPreset(selection.id) ? { kind: "preset", id: DEFAULT_PRESET_ID } : selection;
  currentSelection = next;
  try {
    storage()?.setItem(THEME_PRESET_KEY, next.kind === "custom" ? CUSTOM_THEME_ID : next.id);
  } catch {
    // ignore
  }
  reapply();
  persistBootVars();
};

/** Stores the custom theme ("My theme"). Callers select it with setThemeSelection. */
export const saveCustomTheme = (theme: CustomTheme) => {
  const checked = parseThemeJson(serializeTheme(theme));
  if (!checked.ok) throw new Error(checked.error);
  customTheme = checked.theme;
  try {
    storage()?.setItem(THEME_CUSTOM_KEY, serializeTheme(checked.theme));
  } catch {
    // ignore
  }
  reapply();
  persistBootVars();
};

/** Shows a theme in the whole window without saving it (editor and import preview). Null ends it. */
export const setThemePreview = (theme: CustomTheme | null) => {
  previewTheme = theme;
  reapply();
};

/**
 * A preset or custom theme that only has a dark (or light) version cannot
 * follow the chosen mode; picking it switches the mode instead of silently
 * falling back. Returns the mode to switch to, or null.
 */
export const modeSwitchFor = (
  available: readonly ThemeVariantMode[],
  mode: ThemeMode,
): ResolvedThemeMode | null => {
  if (available.length !== 1) return null;
  const only = available[0]!;
  if (mode === "system") return null;
  return mode === only ? null : only;
};

/** Values for the early inline script; exported for tests. */
export const readBootVars = (raw: string | null, resolved: ResolvedThemeMode) => {
  if (!raw) return null;
  try {
    const boot = JSON.parse(raw) as { only?: unknown; light?: unknown; dark?: unknown };
    const mode: ResolvedThemeMode = boot.only === "dark" || boot.only === "light" ? boot.only : resolved;
    const vars = boot[mode];
    if (!vars || typeof vars !== "object") return { mode, vars: {} };
    const safe: Record<string, string> = {};
    for (const [name, value] of Object.entries(vars as Record<string, unknown>)) {
      if (typeof value === "string" && isSafeVar(name, value)) safe[name] = value;
    }
    return { mode, vars: safe };
  } catch {
    return null;
  }
};

export const resetThemeStateForTests = () => {
  currentMode = null;
  currentSelection = null;
  customTheme = undefined;
  previewTheme = null;
  activeTheme = null;
  listeners.clear();
};
