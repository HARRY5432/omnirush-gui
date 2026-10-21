// The first window's size: the preferred size, never larger than the screen
// area left by the taskbar or dock. An 820 px tall window on a 768 px laptop
// (or 1080 px at 150 % scaling) opened with the composer below the screen.
export const PREFERRED_WINDOW_SIZE = Object.freeze({ width: 1180, height: 820 });

export function initialWindowSize(workArea, preferred = PREFERRED_WINDOW_SIZE) {
  const width = Math.floor(Number(workArea?.width));
  const height = Math.floor(Number(workArea?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ...preferred };
  }
  return { width: Math.min(preferred.width, width), height: Math.min(preferred.height, height) };
}
