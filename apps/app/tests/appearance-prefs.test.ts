import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ACCENT_SWATCHES,
  DEFAULT_APPEARANCE_PREFS,
  MAX_PREFS_BYTES,
  checkAccent,
  codeFontStack,
  normalizeHex,
  parseAppearancePrefs,
  sanitizeAppearancePrefs,
  textOnAccent,
  uiFontStack,
  withAccent,
} from "../src/app/themes/appearance-prefs";
import { contrastRatio } from "../src/app/themes/contrast";
import { findPreset, presetModes, resetAppliedPaletteForTests } from "../src/app/themes/palette";
import { THEME_PRESETS } from "../src/app/themes/presets";
import type { CustomTheme } from "../src/app/themes/types";
import { checkWallpaperFile, MAX_WALLPAPER_BYTES } from "../src/app/wallpaper";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

/** A fake window/document for app/theme.ts; `reduced` answers the reduce-transparency query. */
function fakeWindow() {
  const storage = new MemoryStorage();
  const props = new Map<string, string>();
  const state = { reduced: false };
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      colorScheme: "",
      setProperty: (name: string, value: string) => void props.set(name, value),
      removeProperty: (name: string) => {
        props.delete(name);
        return "";
      },
      getPropertyValue: (name: string) => props.get(name) ?? "",
    },
  };
  const install = () => {
    storage.values.clear();
    props.clear();
    root.dataset = {};
    state.reduced = false;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        matchMedia: (query: string) => ({
          matches: query.includes("reduced-transparency") ? state.reduced : false,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }),
      },
    });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root } });
  };
  const remove = () => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
  };
  return { storage, props, root, state, install, remove };
}

describe("appearance prefs validation", () => {
  test("malformed, oversized or non-object input gives the defaults", () => {
    expect(parseAppearancePrefs(null)).toEqual({ ...DEFAULT_APPEARANCE_PREFS });
    expect(parseAppearancePrefs("{not json")).toEqual({ ...DEFAULT_APPEARANCE_PREFS });
    expect(parseAppearancePrefs("[1,2]")).toEqual({ ...DEFAULT_APPEARANCE_PREFS });
    expect(parseAppearancePrefs("null")).toEqual({ ...DEFAULT_APPEARANCE_PREFS });
    const big = JSON.stringify({ accent: "#123456", pad: "x".repeat(MAX_PREFS_BYTES) });
    expect(parseAppearancePrefs(big)).toEqual({ ...DEFAULT_APPEARANCE_PREFS });
  });

  test("each field is checked on its own; unknown keys are dropped", () => {
    const prefs = sanitizeAppearancePrefs({
      accent: "red;}body{x}",
      uiFont: "Comic Sans",
      codeFont: "jetbrains",
      density: "tiny",
      radiusPx: 99,
      fontSizePx: "14",
      wallpaper: "yes",
      wallpaperDim: -5,
      panelOpacity: 10,
      panelBlur: 1e9,
      extra: "x",
    });
    expect(prefs).toEqual({
      accent: null,
      uiFont: "system",
      codeFont: "jetbrains",
      density: "comfortable",
      radiusPx: 16,
      fontSizePx: null,
      wallpaper: false,
      wallpaperDim: 0,
      panelOpacity: 55,
      panelBlur: 24,
    });
  });

  test("hex colours are normalised", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex(" 3b6fe0 ")).toBe("#3b6fe0");
    expect(normalizeHex("#3b6fe0ff")).toBeNull();
    expect(normalizeHex("url(x)")).toBeNull();
    expect(normalizeHex(42)).toBeNull();
  });

  test("font stacks come from fixed lists only", () => {
    expect(uiFontStack({ uiFont: "system", codeFont: "system" })).toBeNull();
    expect(uiFontStack({ uiFont: "geist", codeFont: "system" })).toContain('"Geist Variable"');
    expect(uiFontStack({ uiFont: "mono", codeFont: "fira" })).toBe(codeFontStack({ codeFont: "fira" }));
    expect(codeFontStack({ codeFont: "nope" as never })).toContain("monospace");
  });
});

describe("accent contrast", () => {
  const light = findPreset("default")!.variants.light!;
  const dark = findPreset("default")!.variants.dark!;

  test("button text is whichever of black and white reads better", () => {
    expect(textOnAccent("#3b6fe0")).toBe("#ffffff");
    expect(textOnAccent("#ffe066")).toBe("#000000");
    const v = withAccent(light, "#3b6fe0");
    expect(v.accent).toBe("#3b6fe0");
    expect(v.accentText).toBe("#ffffff");
    expect(withAccent(light, null)).toBe(light);
  });

  test("every swatch passes on Default light, and its button text passes in dark", () => {
    for (const swatch of ACCENT_SWATCHES) {
      expect({ swatch: swatch.name, ok: checkAccent(light, swatch.hex).ok }).toEqual({ swatch: swatch.name, ok: true });
      expect(checkAccent(dark, swatch.hex).textRatio).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("a faint accent is flagged with a fix that passes both checks", () => {
    for (const [variant, accent] of [
      [light, "#ffe066"],
      [light, "#f0f0f0"],
      [dark, "#202022"],
      [dark, "#3a3a8a"],
    ] as const) {
      const check = checkAccent(variant, accent);
      expect(check.ok).toBe(false);
      expect(check.suggestion).not.toBeNull();
      expect(checkAccent(variant, check.suggestion!).ok).toBe(true);
      expect(contrastRatio(textOnAccent(check.suggestion!), check.suggestion!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("the fix works on every preset", () => {
    for (const preset of THEME_PRESETS) {
      for (const mode of presetModes(preset)) {
        const variant = preset.variants[mode]!;
        const check = checkAccent(variant, mode === "dark" ? "#1a1a1a" : "#fafafa");
        const fixed = check.ok || Boolean(check.suggestion && checkAccent(variant, check.suggestion).ok);
        expect({ id: `${preset.id}/${mode}`, fixed }).toEqual({ id: `${preset.id}/${mode}`, fixed: true });
      }
    }
  });
});

describe("wallpaper file check", () => {
  test("only pictures under 8 MB", () => {
    expect(checkWallpaperFile({ type: "image/png", size: 1000 })).toBeNull();
    expect(checkWallpaperFile({ type: "image/webp", size: MAX_WALLPAPER_BYTES })).toBeNull();
    expect(checkWallpaperFile({ type: "image/png", size: MAX_WALLPAPER_BYTES + 1 })).toContain("8 MB");
    expect(checkWallpaperFile({ type: "image/svg+xml", size: 10 })).not.toBeNull();
    expect(checkWallpaperFile({ type: "text/html", size: 10 })).not.toBeNull();
    expect(checkWallpaperFile({ type: "image/png", size: 0 })).not.toBeNull();
  });
});

describe("prefs applied to the window", () => {
  const fake = fakeWindow();
  const { storage, props, root } = fake;
  let theme: typeof import("../src/app/theme");

  beforeEach(async () => {
    fake.install();
    theme = await import("../src/app/theme");
    theme.resetThemeStateForTests();
    resetAppliedPaletteForTests();
  });
  afterEach(fake.remove);

  test("an accent drives buttons, focus rings and links on Default and on a preset", () => {
    theme.bootstrapTheme();
    theme.setAppearancePrefs({ accent: "#d52d86" });
    expect(props.get("--primary")).toBe("#d52d86");
    expect(props.get("--ring")).toBe("#d52d86");
    expect(props.get("--primary-foreground")).toBe("#ffffff");
    expect(theme.getActiveTheme().legacy).toBe(true);
    const link = props.get("--omnirush-link")!;
    expect(contrastRatio(link, findPreset("default")!.variants.light!.background)).toBeGreaterThanOrEqual(4.5);
    theme.setThemeSelection({ kind: "preset", id: "paper" });
    expect(props.get("--primary")).toBe("#d52d86");
    expect(theme.getActiveTheme().themeAccent).toBe(findPreset("paper")!.variants.light!.accent);
    theme.setAppearancePrefs({ accent: null });
    expect(props.get("--primary")).toBe(findPreset("paper")!.variants.light!.accent);
    expect(JSON.parse(storage.getItem("omnirush.react.settings.appearance")!).accent).toBeNull();
  });

  test("radius and text size override the theme; null follows it again", () => {
    theme.bootstrapTheme();
    theme.setAppearancePrefs({ radiusPx: 2, fontSizePx: 15 });
    expect(props.get("--radius")).toBe("2px");
    expect(props.get("--omnirush-theme-font-scale")).toBe(String(Math.round((15 / 13) * 10000) / 10000));
    theme.setAppearancePrefs({ radiusPx: null, fontSizePx: null });
    expect(props.has("--radius")).toBe(false);
    expect(props.has("--omnirush-theme-font-scale")).toBe(false);
  });

  test("density, fonts and wallpaper reach <html> and the boot copy; switching off removes them", () => {
    theme.bootstrapTheme();
    theme.setAppearancePrefs({
      density: "compact",
      uiFont: "serif",
      codeFont: "jetbrains",
      wallpaper: true,
      panelOpacity: 70,
      wallpaperDim: 40,
      panelBlur: 8,
    });
    expect(root.dataset.density).toBe("compact");
    expect(root.dataset.wallpaper).toBe("on");
    expect(props.get("--omnirush-ui-font")).toContain("Charter");
    expect(props.get("--omnirush-code-font")).toContain('"JetBrains Mono"');
    expect(props.get("--omnirush-panel-blur")).toBe("8px");
    const bg = findPreset("default")!.variants.light!.background;
    expect(props.get("--background")).toBe(`${bg}b3`);
    expect(props.get("--omnirush-wallpaper-wash")).toBe(`${bg}66`);
    const boot = theme.readBootVars(storage.getItem(theme.THEME_BOOT_KEY), "light")!;
    expect(boot.attrs).toEqual({ density: "compact", wallpaper: "on" });
    expect(boot.vars["--omnirush-code-font"]).toContain("JetBrains");
    expect(boot.vars["--background"]).toBe(`${bg}b3`);
    theme.setAppearancePrefs({ density: "comfortable", uiFont: "system", codeFont: "system", wallpaper: false });
    expect(root.dataset.density).toBeUndefined();
    expect(root.dataset.wallpaper).toBeUndefined();
    expect(props.size).toBe(0);
  });

  test("reduce transparency keeps panels solid and drops the blur", () => {
    fake.state.reduced = true;
    theme.bootstrapTheme();
    theme.setAppearancePrefs({ wallpaper: true, panelOpacity: 60 });
    const bg = findPreset("default")!.variants.light!.background;
    expect(props.get("--background")).toBe(`${bg}ff`);
    expect(props.has("--omnirush-panel-blur")).toBe(false);
  });

  test("an edit preview shows the theme as it is, without the accent override", () => {
    theme.bootstrapTheme();
    theme.setAppearancePrefs({ accent: "#21865a" });
    const custom: CustomTheme = { v: 1, name: "P", modes: ["light"], light: clone(findPreset("rose")!.variants.light!), radiusPx: 4, fontSizePx: 13 };
    theme.setThemePreview(custom);
    expect(props.get("--primary")).toBe(custom.light!.accent);
    theme.setThemePreview(null);
    expect(props.get("--primary")).toBe("#21865a");
  });

  test("boot values with anything but plain names are refused", () => {
    const raw = JSON.stringify({
      only: "light",
      light: {},
      attrs: { density: "compact", wallpaper: "on;x", theme: "dark" },
      fonts: { "--omnirush-ui-font": 'x; background: url("http://e")', "--omnirush-code-font": '"Fira Code", monospace', "--other": "Arial" },
    });
    expect(theme.readBootVars(raw, "light")).toEqual({
      mode: "light",
      vars: { "--omnirush-code-font": '"Fira Code", monospace' },
      attrs: { density: "compact" },
    });
  });
});

describe("several custom themes", () => {
  const fake = fakeWindow();
  const { storage, props, root } = fake;
  let theme: typeof import("../src/app/theme");
  const make = (name: string, from = "forest"): CustomTheme => ({
    v: 1,
    name,
    modes: ["light"],
    light: clone(findPreset(from)!.variants.light!),
    radiusPx: 6,
    fontSizePx: 13,
  });

  beforeEach(async () => {
    fake.install();
    theme = await import("../src/app/theme");
    theme.resetThemeStateForTests();
    resetAppliedPaletteForTests();
  });
  afterEach(fake.remove);

  test("named themes are kept, selected by id, updated in place and deleted", () => {
    theme.bootstrapTheme();
    const a = theme.saveCustomTheme(make("Alpha"));
    const b = theme.saveCustomTheme(make("Beta", "sol"));
    expect(a).not.toBe(b);
    theme.setThemeSelection({ kind: "custom", id: b });
    expect(storage.getItem(theme.THEME_PRESET_KEY)).toBe(`custom:${b}`);
    expect(props.get("--background")).toBe(findPreset("sol")!.variants.light!.background);
    expect(theme.saveCustomTheme(make("Beta 2", "rose"), b)).toBe(b);
    expect(theme.getCustomThemes().map((item) => item.theme.name)).toEqual(["Alpha", "Beta 2"]);
    theme.resetThemeStateForTests();
    theme.bootstrapTheme();
    expect(theme.getSelectedCustomId()).toBe(b);
    expect(theme.getCustomTheme()!.name).toBe("Beta 2");
    theme.deleteCustomTheme(b);
    expect(theme.getThemeSelection()).toEqual({ kind: "preset", id: "default" });
    expect(theme.getCustomThemes().map((item) => item.id)).toEqual([a]);
  });

  test("the limit is enforced", () => {
    for (let i = 0; i < theme.MAX_CUSTOM_THEMES; i += 1) theme.saveCustomTheme(make(`T${i}`));
    expect(() => theme.saveCustomTheme(make("one more"))).toThrow(/up to 20/);
  });

  test("the single theme of older builds becomes the first saved theme", () => {
    storage.setItem(theme.THEME_CUSTOM_KEY, JSON.stringify(make("Old")));
    storage.setItem(theme.THEME_PRESET_KEY, "custom");
    theme.bootstrapTheme();
    expect(theme.getCustomThemes()).toEqual([{ id: "custom", theme: make("Old") }]);
    expect(theme.getSelectedCustomId()).toBe("custom");
    expect(root.dataset.omnirushPalette).toBe("custom");
  });

  test("damaged entries are dropped, good ones kept", () => {
    storage.setItem(
      theme.THEME_CUSTOMS_KEY,
      JSON.stringify([
        { id: "ok", theme: make("Fine") },
        { id: "BAD ID", theme: make("Bad id") },
        { id: "ok", theme: make("Duplicate") },
        { id: "evil", theme: { ...make("Evil"), light: { ...make("Evil").light!, background: "red;}" } } },
        "junk",
      ]),
    );
    expect(theme.getCustomThemes().map((item) => item.theme.name)).toEqual(["Fine"]);
    storage.setItem(theme.THEME_CUSTOMS_KEY, "{oops");
    theme.resetThemeStateForTests();
    expect(theme.getCustomThemes()).toEqual([]);
  });
});
