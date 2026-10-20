import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  contrastRatio,
  contrastRows,
  contrastWarnings,
  fixContrast,
  suggestColour,
  textBackgrounds,
  textSafeAccent,
  worstRatio,
} from "../src/app/themes/contrast";
import { LEGACY_XTERM_THEME, monacoThemeFor, xtermThemeFor } from "../src/app/themes/editor-themes";
import {
  allPaletteVarNames,
  applyPaletteVars,
  findPreset,
  isSafeVar,
  paletteVars,
  pickVariant,
  presetModes,
  resetAppliedPaletteForTests,
  resolveActiveTheme,
} from "../src/app/themes/palette";
import { THEME_PRESETS } from "../src/app/themes/presets";
import { ANSI_KEYS, type CustomTheme } from "../src/app/themes/types";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("contrast maths", () => {
  test("WCAG ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(contrastRatio("#4c6e98", "#e5e9f0")).toBeCloseTo(4.321, 3);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.478, 2);
  });

  test("fixContrast matches the preset generator", () => {
    expect(fixContrast("#777b84", "#111113", 4.5)).toBe("#787c85");
    expect(fixContrast("#218358", "#f9f9fb", 4.5)).toBe("#208157");
    expect(fixContrast("#4c6e98", "#e5e9f0", 4.5)).toBe("#496a93");
    expect(fixContrast("#b08f95", "#fff8f6", 4.5)).toBe("#93676f");
    expect(fixContrast("#ffffff", "#ffffff", 4.5)).toBe("#757575");
    expect(fixContrast("#123456", "#000000", 7)).toBe("#589adc");
    expect(fixContrast("#000000", "#ffffff", 4.5)).toBe("#000000");
  });

  test("suggestions pass on every background", () => {
    const bgs = ["#fff8f6", "#fbefec", "#ffffff", "#fbefec"];
    const suggestion = suggestColour("#b08f95", bgs, 4.5);
    expect(worstRatio(suggestion, bgs)).toBeGreaterThanOrEqual(4.5);
  });

  test("every preset variant passes every pair (AA, AAA body text for high contrast)", () => {
    for (const preset of THEME_PRESETS) {
      for (const mode of presetModes(preset)) {
        const rows = contrastRows(preset.variants[mode]!, preset.target === "AAA");
        const failing = rows.filter((row) => !row.pass).map((row) => `${preset.id}/${mode}: ${row.label} ${row.ratio.toFixed(2)}`);
        expect(failing).toEqual([]);
        expect(rows.length).toBeGreaterThanOrEqual(45);
      }
    }
  });

  test("text-safe accent fixes Fjord light links and keeps passing accents", () => {
    const fjord = findPreset("fjord")!.variants.light!;
    expect(worstRatio(fjord.accent, textBackgrounds(fjord))).toBeLessThan(4.5);
    const safe = textSafeAccent(fjord);
    expect(safe).not.toBe(fjord.accent);
    expect(worstRatio(safe, textBackgrounds(fjord))).toBeGreaterThanOrEqual(4.5);
    const midnight = findPreset("midnight")!.variants.dark!;
    expect(textSafeAccent(midnight)).toBe(midnight.accent);
  });

  test("warnings group failing pairs with a passing suggestion", () => {
    const v = clone(findPreset("rose")!.variants.light!);
    v.textMuted = "#b08f95";
    const warnings = contrastWarnings(v);
    const muted = warnings.find((w) => w.token === "textMuted")!;
    expect(muted).toBeDefined();
    expect(muted.rows.length).toBeGreaterThan(0);
    expect(worstRatio(muted.suggestion, textBackgrounds(v))).toBeGreaterThanOrEqual(4.5);
    expect(contrastWarnings(findPreset("rose")!.variants.light!)).toEqual([]);
  });

  test("text on accent failure suggests a new accent fill", () => {
    const v = clone(findPreset("default")!.variants.light!);
    v.accent = "#e0e1e6";
    const warning = contrastWarnings(v).find((w) => w.token === "accent")!;
    expect(warning).toBeDefined();
    expect(contrastRatio(v.accentText, warning.suggestion)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("preset resolution", () => {
  const custom: CustomTheme = {
    v: 1,
    name: "Mine",
    modes: ["light", "dark"],
    light: clone(findPreset("sol")!.variants.light!),
    dark: clone(findPreset("sol")!.variants.dark!),
    radiusPx: 4,
    fontSizePx: 14,
  };

  test("there are 8 presets and 15 variants with the agreed ids", () => {
    expect(THEME_PRESETS.map((p) => p.id)).toEqual([
      "default",
      "midnight",
      "fjord",
      "sol",
      "rose",
      "forest",
      "high-contrast",
      "omnirush",
    ]);
    expect(THEME_PRESETS.reduce((sum, p) => sum + presetModes(p).length, 0)).toBe(15);
    expect(presetModes(findPreset("midnight")!)).toEqual(["dark"]);
  });

  test("preset x mode picks the variant", () => {
    for (const preset of THEME_PRESETS) {
      for (const mode of ["light", "dark"] as const) {
        const active = resolveActiveTheme({ kind: "preset", id: preset.id }, mode, null);
        const expectedMode = preset.variants[mode] ? mode : "dark";
        expect(active.mode).toBe(expectedMode);
        expect(active.variant).toBe(preset.variants[expectedMode]!);
        expect(active.legacy).toBe(preset.id === "default");
      }
    }
  });

  test("Midnight in light mode shows its dark version", () => {
    const active = resolveActiveTheme({ kind: "preset", id: "midnight" }, "light", null);
    expect(active.mode).toBe("dark");
  });

  test("unknown presets and a missing custom theme fall back to Default", () => {
    expect(resolveActiveTheme({ kind: "preset", id: "nope" }, "light", null).selection).toEqual({ kind: "preset", id: "default" });
    const active = resolveActiveTheme({ kind: "custom" }, "dark", null);
    expect(active.selection).toEqual({ kind: "preset", id: "default" });
    expect(active.legacy).toBe(true);
  });

  test("custom themes resolve per mode with their radius and font size", () => {
    const light = resolveActiveTheme({ kind: "custom" }, "light", custom);
    expect(light.variant).toBe(custom.light!);
    expect([light.radiusPx, light.fontSizePx, light.legacy]).toEqual([4, 14, false]);
    const darkOnly: CustomTheme = { ...custom, modes: ["dark"], light: undefined };
    expect(resolveActiveTheme({ kind: "custom" }, "light", darkOnly).mode).toBe("dark");
  });

  test("pickVariant", () => {
    expect(pickVariant({}, "light")).toBeNull();
    const dark = findPreset("midnight")!.variants.dark!;
    expect(pickVariant({ dark }, "light")).toEqual({ mode: "dark", variant: dark });
  });
});

describe("CSS variables", () => {
  test("Default keeps today's stylesheet apart from the dark muted text fix", () => {
    const light = resolveActiveTheme({ kind: "preset", id: "default" }, "light", null);
    const dark = resolveActiveTheme({ kind: "preset", id: "default" }, "dark", null);
    expect(paletteVars(light)).toEqual({});
    expect(paletteVars(dark)).toEqual({ "--muted-foreground": "#858991" });
  });

  test("presets map tokens to the app's variables, all values safe", () => {
    for (const preset of THEME_PRESETS.filter((p) => p.id !== "default")) {
      for (const mode of presetModes(preset)) {
        const active = resolveActiveTheme({ kind: "preset", id: preset.id }, mode, null);
        const vars = paletteVars(active, preset.variants.dark);
        const v = preset.variants[mode]!;
        expect(vars["--background"]).toBe(v.background);
        expect(vars["--primary"]).toBe(v.accent);
        expect(vars["--dls-accent"]).toBe(v.accent);
        expect(vars["--primary-foreground"]).toBe(v.accentText);
        expect(vars["--muted-foreground"]).toBe(v.textMuted);
        expect(vars["--border"]).toBe(v.border);
        expect(vars["--gray-12"]).toBe(v.text);
        expect(vars["--slate-1"]).toBe(v.background);
        expect(vars["--omnirush-terminal-bg"]).toBe(v.terminal.bg);
        expect(vars["--omnirush-syntax-keyword"]).toBe(v.code.keyword);
        expect(vars["--omnirush-highlight"]).toBe(v.highlight ?? v.accent);
        expect(worstRatio(vars["--omnirush-link"]!, textBackgrounds(v))).toBeGreaterThanOrEqual(4.5);
        expect(vars["--radius"]).toBeUndefined();
        for (const [name, value] of Object.entries(vars)) expect(isSafeVar(name, value)).toBe(true);
      }
    }
  });

  test("subtle fills stand off the page and keep muted text readable", () => {
    for (const preset of THEME_PRESETS) {
      for (const mode of presetModes(preset)) {
        const active = resolveActiveTheme({ kind: "preset", id: preset.id }, mode, null);
        const vars = paletteVars({ ...active, legacy: false });
        const v = preset.variants[mode]!;
        expect(contrastRatio(v.textMuted, vars["--muted"]!)).toBeGreaterThanOrEqual(4.5);
        expect(vars["--muted"]).not.toBe(v.background);
        expect(vars["--muted"]).not.toBe(v.surface);
        expect(contrastRatio(vars["--muted"]!, v.background)).toBeGreaterThan(1.1);
      }
    }
  });

  test("custom radius and font size become variables", () => {
    const custom = resolveActiveTheme({ kind: "custom" }, "light", {
      v: 1,
      name: "x",
      modes: ["light"],
      light: findPreset("forest")!.variants.light!,
      radiusPx: 0,
      fontSizePx: 16,
    });
    const vars = paletteVars(custom);
    expect(vars["--radius"]).toBe("0px");
    expect(Number(vars["--omnirush-theme-font-scale"])).toBeCloseTo(16 / 13, 3);
  });

  test("isSafeVar only allows known shapes", () => {
    expect(isSafeVar("--background", "#aabbcc")).toBe(true);
    expect(isSafeVar("--gray-a3", "#aabbcc0f")).toBe(true);
    expect(isSafeVar("--dls-accent-rgb", "12 34 255")).toBe(true);
    expect(isSafeVar("--radius", "4px")).toBe(true);
    expect(isSafeVar("--background", "red;}body{display:none")).toBe(false);
    expect(isSafeVar("--background", "#AABBCC")).toBe(false);
    expect(isSafeVar("background", "#aabbcc")).toBe(false);
    expect(isSafeVar("--x;}", "#aabbcc")).toBe(false);
    expect(isSafeVar("--background", "url(x)")).toBe(false);
  });

  test("applyPaletteVars writes safe values and removes stale ones", () => {
    resetAppliedPaletteForTests();
    const store = new Map<string, string>([["--background", "#010101"], ["--keyboard-inset", "4px"]]);
    const style = {
      setProperty: (name: string, value: string) => void store.set(name, value),
      removeProperty: (name: string) => {
        const had = store.get(name) ?? "";
        store.delete(name);
        return had;
      },
      getPropertyValue: (name: string) => store.get(name) ?? "",
    };
    applyPaletteVars(style, { "--primary": "#123456", "--evil": "red;}body{x}" });
    // The early-script value is adopted and removed; unrelated variables stay.
    expect(store.has("--background")).toBe(false);
    expect(store.get("--keyboard-inset")).toBe("4px");
    expect(store.get("--primary")).toBe("#123456");
    expect(store.has("--evil")).toBe(false);
    applyPaletteVars(style, {});
    expect(store.has("--primary")).toBe(false);
    expect(allPaletteVarNames()).toContain("--muted-foreground");
  });
});

describe("editor and terminal colours", () => {
  test("Monaco theme uses the code colours", () => {
    const active = resolveActiveTheme({ kind: "preset", id: "midnight" }, "dark", null);
    const theme = monacoThemeFor(active);
    expect(theme.base).toBe("vs-dark");
    expect(theme.colors["editor.background"]).toBe(active.variant.code.bg);
    expect(theme.rules.find((rule) => rule.token === "keyword")?.foreground).toBe(active.variant.code.keyword.slice(1));
    expect(theme.colors["diffEditor.insertedLineBackground"]).toBe(`${active.variant.success}1f`);
    for (const value of Object.values(theme.colors)) expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
  });

  test("xterm gets all 16 ANSI colours; Default keeps today's terminal", () => {
    const fjord = resolveActiveTheme({ kind: "preset", id: "fjord" }, "light", null);
    const theme = xtermThemeFor(fjord);
    expect(theme.background).toBe(fjord.variant.terminal.bg);
    for (const key of ANSI_KEYS) expect(theme[key]).toBe(fjord.variant.terminal[key]);
    expect(xtermThemeFor(resolveActiveTheme({ kind: "preset", id: "default" }, "light", null))).toBe(LEGACY_XTERM_THEME);
  });
});

describe("theme state and persistence", () => {
  class MemoryStorage {
    values = new Map<string, string>();
    getItem(key: string) {
      return this.values.has(key) ? this.values.get(key)! : null;
    }
    setItem(key: string, value: string) {
      this.values.set(key, String(value));
    }
    removeItem(key: string) {
      this.values.delete(key);
    }
  }
  const storage = new MemoryStorage();
  let prefersDark = false;
  const props = new Map<string, string>();
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
  let theme: typeof import("../src/app/theme");

  beforeEach(async () => {
    storage.values.clear();
    props.clear();
    root.dataset = {};
    prefersDark = false;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        matchMedia: () => ({ matches: prefersDark, addEventListener: () => undefined, removeEventListener: () => undefined }),
      },
    });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root } });
    theme = await import("../src/app/theme");
    theme.resetThemeStateForTests();
    resetAppliedPaletteForTests();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
  });

  test("defaults to Default preset, system mode", () => {
    theme.bootstrapTheme();
    expect(theme.getThemeSelection()).toEqual({ kind: "preset", id: "default" });
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.omnirushPalette).toBeUndefined();
    expect(props.size).toBe(0);
  });

  test("system mode follows the OS for presets", () => {
    prefersDark = true;
    storage.setItem(theme.THEME_PRESET_KEY, "fjord");
    theme.bootstrapTheme();
    expect(root.dataset.theme).toBe("dark");
    expect(props.get("--background")).toBe(findPreset("fjord")!.variants.dark!.background);
  });

  test("a preset choice is remembered across restarts", () => {
    theme.bootstrapTheme();
    theme.setThemeMode("light");
    theme.setThemeSelection({ kind: "preset", id: "sol" });
    expect(storage.getItem(theme.THEME_PRESET_KEY)).toBe("sol");
    expect(root.dataset.omnirushPalette).toBe("sol");
    theme.resetThemeStateForTests();
    props.clear();
    theme.bootstrapTheme();
    expect(theme.getThemeSelection()).toEqual({ kind: "preset", id: "sol" });
    expect(props.get("--primary")).toBe(findPreset("sol")!.variants.light!.accent);
  });

  test("Midnight with Mode light: the window is dark and the mode switch is requested", () => {
    theme.bootstrapTheme();
    theme.setThemeMode("light");
    theme.setThemeSelection({ kind: "preset", id: "midnight" });
    expect(root.dataset.theme).toBe("dark");
    expect(theme.getResolvedThemeMode()).toBe("dark");
    expect(theme.modeSwitchFor(["dark"], "light")).toBe("dark");
    expect(theme.modeSwitchFor(["dark"], "dark")).toBeNull();
    expect(theme.modeSwitchFor(["dark"], "system")).toBeNull();
    expect(theme.modeSwitchFor(["light", "dark"], "light")).toBeNull();
    expect(theme.modeSwitchFor(["light"], "dark")).toBe("light");
  });

  test("custom theme is saved validated and survives restart; corrupt storage is ignored", () => {
    theme.bootstrapTheme();
    const custom: CustomTheme = {
      v: 1,
      name: "Mine",
      modes: ["dark"],
      dark: clone(findPreset("forest")!.variants.dark!),
      radiusPx: 12,
      fontSizePx: 13,
    };
    theme.saveCustomTheme(custom);
    theme.setThemeSelection({ kind: "custom" });
    expect(root.dataset.omnirushPalette).toBe("custom");
    expect(props.get("--radius")).toBe("12px");
    theme.resetThemeStateForTests();
    expect(theme.getCustomTheme()).toEqual(custom);
    storage.setItem(theme.THEME_CUSTOM_KEY, '{"v":1,"name":"x","modes":["light"],"light":{"background":"red;}"}}');
    theme.resetThemeStateForTests();
    expect(theme.getCustomTheme()).toBeNull();
    theme.bootstrapTheme();
    expect(theme.getActiveTheme().selection).toEqual({ kind: "preset", id: "default" });
    expect(() => theme.saveCustomTheme({ ...custom, name: "" })).toThrow();
  });

  test("preview shows a theme without saving it", () => {
    theme.bootstrapTheme();
    const custom: CustomTheme = {
      v: 1,
      name: "Preview",
      modes: ["light", "dark"],
      light: clone(findPreset("rose")!.variants.light!),
      dark: clone(findPreset("rose")!.variants.dark!),
      radiusPx: 7.2,
      fontSizePx: 13,
    };
    theme.setThemePreview(custom);
    expect(props.get("--primary")).toBe(custom.light!.accent);
    expect(storage.getItem(theme.THEME_CUSTOM_KEY)).toBeNull();
    theme.setThemePreview(null);
    expect(props.has("--primary")).toBe(false);
  });

  test("listeners hear mode and theme changes", () => {
    theme.bootstrapTheme();
    let calls = 0;
    const off = theme.subscribeToTheme(() => {
      calls += 1;
    });
    theme.setThemeMode("dark");
    theme.setThemeSelection({ kind: "preset", id: "omnirush" });
    off();
    theme.setThemeMode("light");
    expect(calls).toBe(2);
  });

  test("boot variables for the early script are stored and filtered on read", () => {
    theme.bootstrapTheme();
    theme.setThemeSelection({ kind: "preset", id: "midnight" });
    const raw = storage.getItem(theme.THEME_BOOT_KEY);
    const boot = theme.readBootVars(raw, "light")!;
    expect(boot.mode).toBe("dark");
    expect(boot.vars["--background"]).toBe(findPreset("midnight")!.variants.dark!.background);
    const tampered = JSON.stringify({ only: null, light: { "--background": "red;}body{x}", "--primary": "#123456", "x": "#ffffff" } });
    expect(theme.readBootVars(tampered, "light")).toEqual({ mode: "light", vars: { "--primary": "#123456" } });
    expect(theme.readBootVars("garbage", "light")).toBeNull();
  });
});
