/**
 * WCAG contrast maths for theme colours, and the "use this colour instead"
 * suggestion shown by the theme editor (same hue and saturation, lightness
 * moved away from the background until the pair passes).
 */
import { ANSI_KEYS, SYNTAX_KEYS, type ThemeVariant } from "./types";

export const TEXT_TARGET = 4.5;
export const UI_TARGET = 3;
export const AAA_TEXT_TARGET = 7;

type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace(/^#/, "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
}

export function rgbToHex(r: number, g: number, b: number): string {
  const part = (c: number) => Math.max(0, Math.min(255, Math.round(c * 255))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function luminance(hex: string): number {
  const ch = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = hexToRgb(hex).map(ch) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** A background is "dark" below this luminance (same threshold as the preset generator). */
export function isDarkColour(hex: string): boolean {
  return luminance(hex) < 0.18;
}

// HLS conversions matching Python's colorsys, so suggestions equal the generator's.
function rgbToHls(r: number, g: number, b: number): [number, number, number] {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sumc = maxc + minc;
  const rangec = maxc - minc;
  const l = sumc / 2;
  if (minc === maxc) return [0, l, 0];
  const s = l <= 0.5 ? rangec / sumc : rangec / (2 - maxc - minc);
  const rc = (maxc - r) / rangec;
  const gc = (maxc - g) / rangec;
  const bc = (maxc - b) / rangec;
  let h: number;
  if (r === maxc) h = bc - gc;
  else if (g === maxc) h = 2 + rc - bc;
  else h = 4 + gc - rc;
  h = (((h / 6) % 1) + 1) % 1;
  return [h, l, s];
}

function hlsToRgb(h: number, l: number, s: number): Rgb {
  if (s === 0) return [l, l, l];
  const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s;
  const m1 = 2 * l - m2;
  const v = (hue: number) => {
    const x = ((hue % 1) + 1) % 1;
    if (x < 1 / 6) return m1 + (m2 - m1) * x * 6;
    if (x < 0.5) return m2;
    if (x < 2 / 3) return m1 + (m2 - m1) * (2 / 3 - x) * 6;
    return m1;
  };
  return [v(h + 1 / 3), v(h), v(h - 1 / 3)];
}

/** Moves fg's lightness away from bg (hue and saturation kept) until the pair reaches target. */
export function fixContrast(fg: string, bg: string, target: number): string {
  if (contrastRatio(fg, bg) >= target) return fg;
  const [r, g, b] = hexToRgb(fg);
  const [h, l0, s] = rgbToHls(r, g, b);
  const step = luminance(bg) > 0.18 ? -0.005 : 0.005;
  let l = l0;
  while (l >= 0 && l <= 1) {
    l += step;
    const c = rgbToHex(...hlsToRgb(h, Math.max(0, Math.min(1, l)), s));
    if (contrastRatio(c, bg) >= target) return c;
  }
  return step < 0 ? "#000000" : "#ffffff";
}

/** A colour close to fg that passes target on every background given (or the best effort). */
export function suggestColour(fg: string, backgrounds: readonly string[], target: number): string {
  let current = fg;
  for (let pass = 0; pass < 6; pass += 1) {
    let changed = false;
    for (const bg of backgrounds) {
      if (contrastRatio(current, bg) < target) {
        current = fixContrast(current, bg, target);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return current;
}

export function worstRatio(fg: string, backgrounds: readonly string[]): number {
  return Math.min(...backgrounds.map((bg) => contrastRatio(fg, bg)));
}

/** The four backgrounds body text is drawn on. */
export function textBackgrounds(v: ThemeVariant): string[] {
  return [v.background, v.surface, v.surfaceRaised, v.code.bg];
}

/**
 * Accent colour safe to use as text (links, counts): the accent itself when it
 * reaches 4.5:1 on all four backgrounds, otherwise the nearest colour that does.
 */
export function textSafeAccent(v: ThemeVariant): string {
  return suggestColour(v.accent, textBackgrounds(v), TEXT_TARGET);
}

export type ContrastCheck = {
  label: string;
  fg: string;
  bg: string;
  target: number;
};

export type ContrastRow = ContrastCheck & {
  fgColour: string;
  bgColour: string;
  ratio: number;
  pass: boolean;
};

export function readPath(v: ThemeVariant, path: string): string {
  const [head, tail] = path.split(".") as [string, string | undefined];
  const value = tail ? (v as unknown as Record<string, Record<string, string>>)[head]?.[tail] : (v as unknown as Record<string, string>)[head];
  return typeof value === "string" ? value : "#000000";
}

/** The pairs every variant must pass (port of the preset generator's list). */
export function contrastChecks(v: ThemeVariant, aaa = false): ContrastCheck[] {
  const body = aaa ? AAA_TEXT_TARGET : TEXT_TARGET;
  const dark = isDarkColour(v.background);
  const out: ContrastCheck[] = [
    { label: "text / background", fg: "text", bg: "background", target: body },
    { label: "text / surface", fg: "text", bg: "surface", target: body },
    { label: "text / surface-raised", fg: "text", bg: "surfaceRaised", target: body },
    { label: "text-muted / background", fg: "textMuted", bg: "background", target: TEXT_TARGET },
    { label: "text-muted / surface", fg: "textMuted", bg: "surface", target: TEXT_TARGET },
    { label: "text-muted / surface-raised", fg: "textMuted", bg: "surfaceRaised", target: TEXT_TARGET },
    { label: "text-muted / code bg", fg: "textMuted", bg: "code.bg", target: TEXT_TARGET },
    { label: "text / code bg", fg: "text", bg: "code.bg", target: body },
    { label: "accent-text / accent", fg: "accentText", bg: "accent", target: TEXT_TARGET },
    { label: "accent / background (UI)", fg: "accent", bg: "background", target: UI_TARGET },
    { label: "accent / surface-raised (UI)", fg: "accent", bg: "surfaceRaised", target: UI_TARGET },
    { label: "accent / code bg (UI)", fg: "accent", bg: "code.bg", target: UI_TARGET },
  ];
  for (const key of ["success", "warn", "danger"] as const) {
    for (const [name, bg] of [
      ["background", "background"],
      ["surface", "surface"],
      ["surface-raised", "surfaceRaised"],
      ["code bg", "code.bg"],
    ] as const) {
      out.push({ label: `${key} / ${name}`, fg: key, bg, target: TEXT_TARGET });
    }
  }
  out.push(
    { label: "code fg / code bg", fg: "code.fg", bg: "code.bg", target: body },
    { label: "terminal fg / terminal bg", fg: "terminal.fg", bg: "terminal.bg", target: body },
    { label: "terminal cursor / terminal bg (UI)", fg: "terminal.cursor", bg: "terminal.bg", target: UI_TARGET },
  );
  for (const key of SYNTAX_KEYS) {
    out.push({ label: `syntax ${key} / code bg`, fg: `code.${key}`, bg: "code.bg", target: TEXT_TARGET });
  }
  // The ANSI colour meant to sit on the background side is exempt (black on dark, white on light).
  const exempt = new Set<string>(dark ? ["black"] : ["white", "brightWhite"]);
  for (const key of ANSI_KEYS) {
    if (exempt.has(key)) continue;
    out.push({ label: `ansi ${key} / terminal bg`, fg: `terminal.${key}`, bg: "terminal.bg", target: TEXT_TARGET });
  }
  return out;
}

export function contrastRows(v: ThemeVariant, aaa = false): ContrastRow[] {
  return contrastChecks(v, aaa).map((check) => {
    const fgColour = readPath(v, check.fg);
    const bgColour = readPath(v, check.bg);
    const ratio = contrastRatio(fgColour, bgColour);
    return { ...check, fgColour, bgColour, ratio, pass: ratio >= check.target };
  });
}

export type ContrastWarning = {
  /** Token the suggestion changes (the accent fill for the text-on-accent pair). */
  token: string;
  current: string;
  suggestion: string;
  worst: number;
  target: number;
  rows: ContrastRow[];
};

/**
 * Failing pairs grouped by the token to change, each with one suggested colour
 * that passes on every background that token is checked against.
 */
export function contrastWarnings(v: ThemeVariant, aaa = false): ContrastWarning[] {
  const rows = contrastRows(v, aaa);
  const failing = rows.filter((row) => !row.pass);
  const byToken = new Map<string, ContrastRow[]>();
  for (const row of failing) {
    const token = row.fg === "accentText" ? "accent" : row.fg;
    byToken.set(token, [...(byToken.get(token) ?? []), row]);
  }
  const warnings: ContrastWarning[] = [];
  for (const [token, tokenRows] of byToken) {
    const current = readPath(v, token);
    const target = Math.max(...tokenRows.map((row) => row.target));
    if (token === "accent") {
      // Fix the accent fill against its text colour first, then keep it visible as a UI colour.
      const accentTextRow = tokenRows.find((row) => row.fg === "accentText");
      const allAccentRows = rows.filter((row) => row.fg === "accent");
      let suggestion = accentTextRow ? fixContrast(current, v.accentText, TEXT_TARGET) : current;
      suggestion = suggestColour(suggestion, allAccentRows.map((row) => row.bgColour), UI_TARGET);
      warnings.push({
        token,
        current,
        suggestion,
        worst: Math.min(...tokenRows.map((row) => row.ratio)),
        target,
        rows: tokenRows,
      });
      continue;
    }
    const backgrounds = rows.filter((row) => row.fg === token).map((row) => row.bgColour);
    const suggestion = suggestColour(current, backgrounds, target);
    warnings.push({
      token,
      current,
      suggestion,
      worst: Math.min(...tokenRows.map((row) => row.ratio)),
      target,
      rows: tokenRows,
    });
  }
  return warnings;
}
