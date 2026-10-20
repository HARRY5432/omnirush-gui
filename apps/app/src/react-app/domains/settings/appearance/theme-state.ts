import { useSyncExternalStore } from "react";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import {
  getActiveTheme,
  getCustomTheme,
  getThemeSelection,
  subscribeToTheme,
  type ThemeMode,
} from "@/app/theme";
import { findPreset, presetModes } from "@/app/themes/palette";
import { DEFAULT_FONT_SIZE_PX, DEFAULT_RADIUS_PX, type CustomTheme, type ThemePreset } from "@/app/themes/types";

export function useActiveTheme() {
  return useSyncExternalStore(subscribeToTheme, getActiveTheme, getActiveTheme);
}

export function useThemeSelection() {
  return useSyncExternalStore(subscribeToTheme, getThemeSelection, getThemeSelection);
}

export function useSavedCustomTheme() {
  return useSyncExternalStore(subscribeToTheme, getCustomTheme, getCustomTheme);
}

/**
 * theme_changed: sent on a preset pick or when a custom theme is applied/kept.
 * Never carries colours or the custom theme's name.
 */
export function trackThemeChanged(
  input: { kind: "preset"; preset: string; mode: ThemeMode } | { kind: "custom"; mode: ThemeMode },
) {
  if (input.kind === "preset") {
    captureAnalyticsEvent("theme_changed", { kind: "preset", preset: input.preset, mode: input.mode });
  } else {
    captureAnalyticsEvent("theme_changed", { kind: "custom", mode: input.mode });
  }
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A new custom theme ("My theme") starting from a preset's versions. */
export function customThemeFromPreset(preset: ThemePreset, name = "My theme"): CustomTheme {
  const modes = presetModes(preset);
  const theme: CustomTheme = { v: 1, name, modes, radiusPx: DEFAULT_RADIUS_PX, fontSizePx: DEFAULT_FONT_SIZE_PX };
  for (const mode of modes) theme[mode] = clone(preset.variants[mode]!);
  return theme;
}

export function presetName(id: string): string {
  return findPreset(id)?.name ?? id;
}

export const cloneTheme = clone;
