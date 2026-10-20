/** @jsxImportSource react */
import { cn } from "@/lib/utils";
import { textSafeAccent } from "@/app/themes/contrast";
import type { ThemeVariant } from "@/app/themes/types";

/**
 * Small picture of a theme variant for the preset cards: sidebar lines, a
 * message line, a code line and swatches. Colours come from validated theme
 * data and are set through React style props only.
 */
export function ThemeVariantThumb(props: { variant: ThemeVariant; className?: string; swatches?: string[] }) {
  const v = props.variant;
  const swatches = props.swatches ?? [v.accent, v.surface, v.code.string, v.code.function];
  return (
    <div
      aria-hidden="true"
      className={cn("flex h-full min-h-14 flex-col justify-between p-2", props.className)}
      style={{ backgroundColor: v.background }}
    >
      <div className="flex flex-col gap-1">
        <span className="block h-1 w-3/5 rounded-full" style={{ backgroundColor: v.text }} />
        <span className="block h-1 w-2/5 rounded-full" style={{ backgroundColor: v.textMuted }} />
      </div>
      <div className="flex items-center gap-1">
        {swatches.map((colour, index) => (
          <span
            key={index}
            className="block size-2.5 rounded-[3px]"
            style={{ backgroundColor: colour, boxShadow: `inset 0 0 0 1px ${v.border}` }}
          />
        ))}
      </div>
    </div>
  );
}

/** The labelled, non-interactive sample shown next to the custom theme editor. */
export function ThemeLivePreview(props: { variant: ThemeVariant; radiusPx: number; fontSizePx: number }) {
  const v = props.variant;
  const c = v.code;
  const t = v.terminal;
  const radius = `${props.radiusPx}px`;
  const box = { borderRadius: radius, border: `1px solid ${v.border}` };
  return (
    <figure
      aria-label="Live preview (sample, not clickable)"
      className="m-0 overflow-hidden text-left"
      style={{ ...box, backgroundColor: v.background, color: v.text, fontSize: `${props.fontSizePx}px` }}
      data-testid="theme-live-preview"
    >
      <figcaption
        className="flex items-center justify-between px-3 py-2 text-xs"
        style={{ borderBottom: `1px solid ${v.border}`, backgroundColor: v.surface }}
      >
        <span style={{ color: v.text }}>Live preview</span>
        <span style={{ color: v.textMuted }}>sample · not clickable</span>
      </figcaption>
      <div inert className="flex select-none flex-col gap-2.5 p-3">
        <div className="self-end px-3 py-1.5" style={{ ...box, backgroundColor: v.surfaceRaised }}>
          Add a retry to the request?
        </div>
        <div>
          Done: three tries with backoff. <span style={{ color: v.textMuted }}>Tests pass.</span>
        </div>
        <pre
          className="m-0 overflow-hidden px-3 py-2 font-mono text-[0.85em] leading-relaxed"
          style={{ ...box, backgroundColor: c.bg, color: c.fg }}
        >
          <span style={{ color: c.comment, fontStyle: "italic" }}>{"// retry with backoff"}</span>
          {"\n"}
          <span style={{ color: c.keyword }}>for</span>
          <span style={{ color: c.punctuation }}>{" ("}</span>
          <span style={{ color: c.keyword }}>let</span>
          <span style={{ color: c.variable }}> i </span>
          <span style={{ color: c.punctuation }}>= </span>
          <span style={{ color: c.number }}>0</span>
          <span style={{ color: c.punctuation }}>; i &lt; </span>
          <span style={{ color: c.number }}>3</span>
          <span style={{ color: c.punctuation }}>{"; i++) {"}</span>
          {"\n  "}
          <span style={{ color: c.keyword }}>if</span>
          <span style={{ color: c.punctuation }}>{" ("}</span>
          <span style={{ color: c.keyword }}>await </span>
          <span style={{ color: c.function }}>send</span>
          <span style={{ color: c.punctuation }}>(</span>
          <span style={{ color: c.type }}>file</span>
          <span style={{ color: c.punctuation }}>)) </span>
          <span style={{ color: c.keyword }}>return </span>
          <span style={{ color: c.string }}>"ok"</span>
          <span style={{ color: c.punctuation }}>;</span>
          {"\n"}
          <span style={{ color: c.punctuation }}>{"}"}</span>
        </pre>
        <pre
          className="m-0 overflow-hidden px-3 py-2 font-mono text-[0.85em] leading-relaxed"
          style={{ ...box, backgroundColor: t.bg, color: t.fg }}
        >
          <span style={{ color: t.brightBlack }}>$ </span>pnpm test
          {"\n"}
          <span style={{ color: t.green }}>✓ 42 passed</span>
          <span style={{ color: t.yellow }}> ! 1 skipped</span>
          <span style={{ color: t.red }}> ✗ 0 failed</span>
          {"\n"}
          <span style={{ color: t.blue }}>info</span>
          <span style={{ color: t.magenta }}> watch</span>
          <span style={{ color: t.cyan }}> src/api </span>
          <span className="inline-block h-[1em] w-[0.5em] align-text-bottom" style={{ backgroundColor: t.cursor }} />
        </pre>
        <div className="text-[0.75em] uppercase tracking-wide" style={{ color: v.textMuted }}>
          Sample controls
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="px-3 py-1" style={{ borderRadius: radius, backgroundColor: v.accent, color: v.accentText }}>
            Primary
          </span>
          <span className="px-3 py-1" style={{ ...box, backgroundColor: v.surface, color: v.text }}>
            Secondary
          </span>
          <span
            className="ml-auto px-2 py-0.5 text-[0.8em] font-semibold"
            style={{ borderRadius: radius, border: `1px solid ${v.border}`, backgroundColor: v.surfaceRaised }}
          >
            Badge
          </span>
        </div>
        <div className="flex flex-wrap gap-3 text-[0.85em]">
          <span style={{ color: v.success }}>● Success</span>
          <span style={{ color: v.warn }}>● Warning</span>
          <span style={{ color: v.danger }}>● Error</span>
          <span style={{ color: textSafeAccent(v) }}>Link</span>
        </div>
      </div>
    </figure>
  );
}
