import { beforeEach, describe, expect, test } from "bun:test";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { localStorage: new MemoryStorage(), addEventListener: () => undefined },
});
type Inspector = { events: (limit?: number) => Array<{ name: string; data: unknown }>; clearEvents: () => void };
const inspector = () => (window as unknown as { __omnirush: Inspector }).__omnirush;

const { ensureInspectorInstalled } = await import("../src/app/lib/app-inspector");
const { trackThemeChanged, customThemeFromPreset } = await import("../src/react-app/domains/settings/appearance/theme-state");
const { findPreset } = await import("../src/app/themes/palette");

describe("theme_changed", () => {
  beforeEach(() => {
    ensureInspectorInstalled();
    inspector().clearEvents();
  });

  test("preset picks carry kind, preset id and mode only", () => {
    trackThemeChanged({ kind: "preset", preset: "fjord", mode: "light" });
    const event = inspector().events(10).find((entry) => entry.name === "analytics.theme_changed")!;
    expect(event.data).toEqual({ kind: "preset", preset: "fjord", mode: "light" });
  });

  test("custom themes never send colours or the theme name", () => {
    trackThemeChanged({ kind: "custom", mode: "dark" });
    const event = inspector().events(10).find((entry) => entry.name === "analytics.theme_changed")!;
    expect(event.data).toEqual({ kind: "custom", mode: "dark" });
    expect(JSON.stringify(event.data)).not.toMatch(/#[0-9a-f]{6}/i);
  });

  test("a new custom theme copies the preset's versions", () => {
    const midnight = customThemeFromPreset(findPreset("midnight")!);
    expect(midnight.modes).toEqual(["dark"]);
    expect(midnight.dark).toEqual(findPreset("midnight")!.variants.dark!);
    expect(midnight.dark).not.toBe(findPreset("midnight")!.variants.dark!);
    expect(midnight.name).toBe("My theme");
  });
});
