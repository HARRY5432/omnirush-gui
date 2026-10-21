// Chromium switches that keep pages rendering while the app is behind other
// windows. Windows' native occlusion tracking marks a covered window hidden
// and stops its frames even when backgroundThrottling is off, so the built-in
// browser stalls (no animation frames, observers or screenshots) until the
// user comes back to the app.

export const WINDOWS_OCCLUSION_FEATURE = "CalculateNativeWinOcclusion";

/** Add features to a comma-separated --disable-features value without duplicates. */
export function mergeFeatureList(existing, features) {
  const list = String(existing ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const feature of features) {
    if (!list.includes(feature)) list.push(feature);
  }
  return list.join(",");
}

/**
 * Apply the switches before `ready`. `commandLine` is `app.commandLine`.
 * Merges with a --disable-features value set earlier (launch arguments), since
 * Chromium reads only one value for the switch.
 */
export function applyBackgroundRenderingSwitches(commandLine, platform = process.platform) {
  if (platform !== "win32") return null;
  const value = mergeFeatureList(commandLine.getSwitchValue("disable-features"), [WINDOWS_OCCLUSION_FEATURE]);
  commandLine.appendSwitch("disable-features", value);
  return value;
}
