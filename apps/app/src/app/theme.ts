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
import {
  APPEARANCE_PREFS_KEY,
  codeFontStack,
  parseAppearancePrefs,
  sanitizeAppearancePrefs,
  uiFontStack,
  withAccent,
  type AppearancePrefs,
} from "./themes/appearance-prefs";
import { parseThemeJson, serializeTheme } from "./themes/share";
import type { CustomTheme, ThemeVariantMode } from "./themes/types";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedThemeMode = "light" | "dark";
export type { ActiveTheme, ThemeSelection } from "./themes/palette";

const THEME_PREF_KEY = "omnirush.react.settings.theme-mode";
const LEGACY_THEME_PREF_KEYS = ["omnirush.themePref"];
export const THEME_PRESET_KEY = "omnirush.react.settings.theme-preset";
/** The single custom theme of older builds; read once to seed THEME_CUSTOMS_KEY, never written. */
export const THEME_CUSTOM_KEY = "omnirush.react.settings.theme-custom";
export const THEME_CUSTOMS_KEY = "omnirush.react.settings.theme-customs";
export const MAX_CUSTOM_THEMES = 20;
const LEGACY_CUSTOM_ID = "custom";
const CUSTOM_ID = /^[a-z0-9-]{1,40}$/;

export type SavedCustomTheme = { id: string; theme: CustomTheme };
/** Variables for both modes, read by the inline script in index.html before the bundle loads. */
export const THEME_BOOT_KEY = "omnirush.react.settings.theme-boot";

const mediaQuery = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();
let currentMode: ThemeMode | null = null;
let currentSelection: ThemeSelection | null = null;
let customThemes: SavedCustomTheme[] | undefined;
let appearancePrefs: AppearancePrefs | null = null;
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
    if (stored?.startsWith(`${CUSTOM_THEME_ID}:`)) return { kind: "custom", id: stored.slice(CUSTOM_THEME_ID.length + 1) };
    if (stored && findPreset(stored)) return { kind: "preset", id: stored };
  } catch {
    // ignore
  }
  return { kind: "preset", id: DEFAULT_PRESET_ID };
};

/** Saved custom themes; each entry is re-validated, bad ones are dropped. */
const readStoredCustomThemes = (): SavedCustomTheme[] => {
  try {
    const stored = storage()?.getItem(THEME_CUSTOMS_KEY);
    if (stored) {
      const list: unknown = JSON.parse(stored);
      if (!Array.isArray(list)) return [];
      const out: SavedCustomTheme[] = [];
      for (const entry of list.slice(0, MAX_CUSTOM_THEMES)) {
        const id = (entry as { id?: unknown })?.id;
        if (typeof id !== "string" || !CUSTOM_ID.test(id) || out.some((item) => item.id === id)) continue;
        const parsed = parseThemeJson(JSON.stringify((entry as { theme?: unknown }).theme ?? null));
        if (parsed.ok) out.push({ id, theme: parsed.theme });
      }
      return out;
    }
    const legacy = storage()?.getItem(THEME_CUSTOM_KEY);
    if (!legacy) return [];
    const parsed = parseThemeJson(legacy);
    return parsed.ok ? [{ id: LEGACY_CUSTOM_ID, theme: parsed.theme }] : [];
  } catch {
    return [];
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

export const getCustomThemes = (): SavedCustomTheme[] => {
  if (customThemes === undefined) customThemes = readStoredCustomThemes();
  return customThemes;
};

const findCustom = (id: string | undefined): SavedCustomTheme | null => {
  const list = getCustomThemes();
  return (id === undefined ? list[0] : list.find((item) => item.id === id)) ?? null;
};

/** The custom theme in use (or the first saved one when a preset is in use). */
export const getCustomTheme = (): CustomTheme | null => {
  const selection = getCurrentSelection();
  return (selection.kind === "custom" ? findCustom(selection.id) : findCustom(undefined))?.theme ?? null;
};

/** Id of the custom theme in use, or null when a preset is in use. */
export const getSelectedCustomId = (): string | null => {
  const selection = getCurrentSelection();
  return selection.kind === "custom" ? (findCustom(selection.id)?.id ?? null) : null;
};

/** Font stack for code views (Monaco, terminal), from Settings > Appearance. */
export const getCodeFontStack = () => codeFontStack(getAppearancePrefs());

export const getAppearancePrefs = (): AppearancePrefs => {
  if (!appearancePrefs) {
    let raw: string | null = null;
    try {
      raw = storage()?.getItem(APPEARANCE_PREFS_KEY) ?? null;
    } catch {
      raw = null;
    }
    appearancePrefs = parseAppearancePrefs(raw);
  }
  return appearancePrefs;
};

const matches = (query: string) => {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  } catch {
    return false;
  }
};

/** The OS asks for less transparency: panels stay solid over a wallpaper, no blur. */
const REDUCED_TRANSPARENCY = "(prefers-reduced-transparency: reduce)";

/** The user's accent, radius, text size and wallpaper on top of the theme. An edit preview shows the theme as-is. */
const withPrefs = (active: ActiveTheme, preview: boolean): ActiveTheme => {
  const prefs = getAppearancePrefs();
  const solid = matches(REDUCED_TRANSPARENCY);
  const glass = prefs.wallpaper
    ? { opacity: solid ? 1 : prefs.panelOpacity / 100, dim: prefs.wallpaperDim / 100 }
    : null;
  if (preview) return { ...active, glass };
  return {
    ...active,
    variant: withAccent(active.variant, prefs.accent),
    accentOverride: Boolean(prefs.accent),
    themeAccent: active.variant.accent,
    radiusPx: prefs.radiusPx ?? active.radiusPx,
    fontSizePx: prefs.fontSizePx ?? active.fontSizePx,
    glass,
  };
};

/** The theme to show: the preview being edited/imported, else the saved choice. */
const computeActiveTheme = (wanted: ResolvedThemeMode): ActiveTheme => {
  if (previewTheme) return withPrefs(resolveActiveTheme({ kind: "custom" }, wanted, previewTheme), true);
  return withPrefs(resolveActiveTheme(getCurrentSelection(), wanted, getCustomTheme()), false);
};

const darkVariantOf = (active: ActiveTheme) => {
  if (active.selection.kind === "custom") return (previewTheme ?? getCustomTheme())?.dark ?? null;
  return findPreset(active.selection.id)?.variants.dark ?? null;
};

/** Font, density and wallpaper switches that are not colours (data-* on <html>, fixed font stacks). */
const prefAttrs = (prefs: AppearancePrefs) => ({
  attrs: {
    density: prefs.density === "compact" ? "compact" : null,
    wallpaper: prefs.wallpaper ? "on" : null,
  },
  fonts: {
    "--omnirush-ui-font": uiFontStack(prefs),
    "--omnirush-code-font": prefs.codeFont === "system" ? null : codeFontStack(prefs),
    "--omnirush-panel-blur": prefs.wallpaper && !matches(REDUCED_TRANSPARENCY) ? `${prefs.panelBlur}px` : null,
  } as Record<string, string | null>,
});

const applyPrefAttrs = (root: HTMLElement) => {
  const { attrs, fonts } = prefAttrs(getAppearancePrefs());
  for (const [name, value] of Object.entries(attrs)) {
    if (value) root.dataset[name] = value;
    else delete root.dataset[name];
  }
  for (const [name, value] of Object.entries(fonts)) {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
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
      ...prefAttrs(getAppearancePrefs()),
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
  if (typeof root.style.removeProperty === "function") applyPrefAttrs(root);
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
  // Turning "reduce transparency" on or off in the OS updates the wallpaper look at once.
  const transparency = window.matchMedia(REDUCED_TRANSPARENCY);
  const onTransparency = () => reapply();
  transparency.addEventListener?.("change", onTransparency);
  systemThemeCleanup = () => {
    list.removeEventListener("change", handleSystemThemeChange);
    transparency.removeEventListener?.("change", onTransparency);
  };
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
    const stored = next.kind === "preset" ? next.id : next.id ? `${CUSTOM_THEME_ID}:${next.id}` : CUSTOM_THEME_ID;
    storage()?.setItem(THEME_PRESET_KEY, stored);
  } catch {
    // ignore
  }
  reapply();
  persistBootVars();
};

const persistCustomThemes = (list: SavedCustomTheme[]) => {
  customThemes = list;
  try {
    storage()?.setItem(THEME_CUSTOMS_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
  reapply();
  persistBootVars();
};

const newCustomId = () => {
  const taken = new Set(getCustomThemes().map((item) => item.id));
  let id = `t-${Date.now().toString(36)}`;
  for (let n = 2; taken.has(id); n += 1) id = `t-${Date.now().toString(36)}-${n}`;
  return id;
};

/**
 * Stores a custom theme, validated. With an id it replaces that theme, otherwise it is added
 * (up to MAX_CUSTOM_THEMES). Returns the id; callers select it with setThemeSelection.
 */
export const saveCustomTheme = (theme: CustomTheme, id?: string): string => {
  const checked = parseThemeJson(serializeTheme(theme));
  if (!checked.ok) throw new Error(checked.error);
  const list = getCustomThemes();
  const index = id === undefined ? -1 : list.findIndex((item) => item.id === id);
  if (index >= 0) {
    persistCustomThemes(list.map((item, i) => (i === index ? { id: item.id, theme: checked.theme } : item)));
    return list[index]!.id;
  }
  if (list.length >= MAX_CUSTOM_THEMES) {
    throw new Error(`You can keep up to ${MAX_CUSTOM_THEMES} custom themes. Delete one first.`);
  }
  const nextId = id !== undefined && CUSTOM_ID.test(id) ? id : newCustomId();
  persistCustomThemes([...list, { id: nextId, theme: checked.theme }]);
  return nextId;
};

/** Deletes a saved custom theme; if it was in use, Default takes over. */
export const deleteCustomTheme = (id: string) => {
  const inUse = getSelectedCustomId() === id;
  persistCustomThemes(getCustomThemes().filter((item) => item.id !== id));
  if (inUse) setThemeSelection({ kind: "preset", id: DEFAULT_PRESET_ID });
};

/** Changes accent, fonts, density, sizes or wallpaper look; applied at once and kept on this device. */
export const setAppearancePrefs = (patch: Partial<AppearancePrefs>) => {
  appearancePrefs = sanitizeAppearancePrefs({ ...getAppearancePrefs(), ...patch });
  try {
    storage()?.setItem(APPEARANCE_PREFS_KEY, JSON.stringify(appearancePrefs));
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
// Same patterns as the inline script in index.html: plain words, font names and px only (no url(), no ;).
const BOOT_ATTR = /^[a-z-]{1,20}$/;
const BOOT_FONT = /^[\w\s",.-]{1,300}$/;
const BOOT_FONT_VARS = new Set(["--omnirush-ui-font", "--omnirush-code-font", "--omnirush-panel-blur"]);

/** Values for the early inline script; exported for tests. */
export const readBootVars = (raw: string | null, resolved: ResolvedThemeMode) => {
  if (!raw) return null;
  try {
    const boot = JSON.parse(raw) as { only?: unknown; light?: unknown; dark?: unknown; attrs?: unknown; fonts?: unknown };
    const mode: ResolvedThemeMode = boot.only === "dark" || boot.only === "light" ? boot.only : resolved;
    const vars = boot[mode];
    const safe: Record<string, string> = {};
    if (vars && typeof vars === "object") {
      for (const [name, value] of Object.entries(vars as Record<string, unknown>)) {
        if (typeof value === "string" && isSafeVar(name, value)) safe[name] = value;
      }
    }
    const attrs: Record<string, string> = {};
    for (const [name, value] of Object.entries(isRecord(boot.attrs) ? boot.attrs : {})) {
      if ((name === "density" || name === "wallpaper") && typeof value === "string" && BOOT_ATTR.test(value)) attrs[name] = value;
    }
    for (const [name, value] of Object.entries(isRecord(boot.fonts) ? boot.fonts : {})) {
      if (BOOT_FONT_VARS.has(name) && typeof value === "string" && BOOT_FONT.test(value)) safe[name] = value;
    }
    return { mode, vars: safe, attrs };
  } catch {
    return null;
  }
};

export const resetThemeStateForTests = () => {
  currentMode = null;
  currentSelection = null;
  customThemes = undefined;
  appearancePrefs = null;
  previewTheme = null;
  activeTheme = null;
  listeners.clear();
};
