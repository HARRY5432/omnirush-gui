/** @jsxImportSource react */
import { AlertTriangle, Check } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  contrastRatio,
  contrastWarnings,
  readPath,
  textBackgrounds,
  worstRatio,
  type ContrastWarning,
} from "@/app/themes/contrast";
import {
  ANSI_KEYS,
  FONT_SIZE_RANGE,
  RADIUS_RANGE,
  SYNTAX_KEYS,
  type CustomTheme,
  type ThemeVariant,
  type ThemeVariantMode,
} from "@/app/themes/types";
import { MAX_NAME_LENGTH } from "@/app/themes/share";
import { ThemeLivePreview } from "./theme-preview";
import { cloneTheme } from "./theme-state";

const HEX = /^#?([0-9a-fA-F]{6})$/;

const TOKEN_LABELS: Record<string, string> = {
  accent: "Accent",
  accentText: "Text on accent",
  background: "Background",
  surface: "Surface",
  surfaceRaised: "Raised surface",
  border: "Border",
  text: "Text",
  textMuted: "Muted text",
  success: "Success",
  warn: "Warning",
  danger: "Error",
  "code.bg": "Code background",
  "code.fg": "Code text",
  "terminal.bg": "Terminal background",
  "terminal.fg": "Terminal text",
  "terminal.cursor": "Terminal cursor",
};

const SYNTAX_LABELS: Record<string, string> = {
  keyword: "keyword",
  string: "string",
  number: "number",
  function: "function",
  type: "type",
  variable: "variable",
  comment: "comment",
  punctuation: "punct.",
};

function labelFor(token: string): string {
  if (TOKEN_LABELS[token]) return TOKEN_LABELS[token]!;
  const [group, key] = token.split(".");
  if (group === "code") return `Syntax ${key}`;
  if (group === "terminal") return `Terminal ${key?.replace(/^bright([A-Z])/, (_, c: string) => `bright ${c.toLowerCase()}`)}`;
  return token;
}

function writePath(v: ThemeVariant, path: string, value: string): ThemeVariant {
  const next = cloneTheme(v);
  const [head, tail] = path.split(".") as [string, string | undefined];
  if (tail) (next as unknown as Record<string, Record<string, string>>)[head]![tail] = value;
  else (next as unknown as Record<string, string>)[head] = value;
  return next;
}

function countChanged(a: ThemeVariant | undefined, b: ThemeVariant | undefined): number {
  if (!a || !b) return 0;
  const flat = (v: ThemeVariant) => {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string") out[k] = val;
      else for (const [kk, vv] of Object.entries(val as Record<string, string>)) out[`${k}.${kk}`] = vv;
    }
    return out;
  };
  const fa = flat(a);
  const fb = flat(b);
  return Object.keys({ ...fa, ...fb }).filter((key) => fa[key] !== fb[key]).length;
}

/** Native colour picker behind a swatch, plus a hex field. */
function ColourInput(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
  testId?: string;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  const commit = (raw: string) => {
    const match = HEX.exec(raw.trim());
    if (match) props.onChange(`#${match[1]!.toLowerCase()}`);
    else setText(props.value);
  };
  const swatch = (
    <label
      className={cn(
        "relative block shrink-0 cursor-pointer overflow-hidden rounded-md border border-border",
        props.compact ? "size-6" : "size-5",
      )}
      style={{ backgroundColor: props.value }}
      title={`${props.label} ${props.value}`}
    >
      <input
        type="color"
        aria-label={`${props.label} colour`}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value.toLowerCase())}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
        data-testid={props.testId ? `${props.testId}-picker` : undefined}
      />
    </label>
  );
  if (props.compact) return swatch;
  return (
    <div className="flex w-36 items-center gap-2 rounded-lg border border-border bg-background px-2 py-1">
      {swatch}
      <input
        aria-label={`${props.label} hex`}
        value={text}
        spellCheck={false}
        maxLength={7}
        onChange={(event) => {
          setText(event.target.value);
          if (HEX.test(event.target.value.trim())) commit(event.target.value);
        }}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit((event.target as HTMLInputElement).value);
        }}
        className="w-full min-w-0 bg-transparent font-mono text-xs text-foreground outline-none"
        data-testid={props.testId}
      />
    </div>
  );
}

function RatioNote(props: { ratio: number; target: number; text: string }) {
  const pass = props.ratio >= props.target;
  return (
    <span className={cn("flex items-center gap-1 text-xs", pass ? "text-muted-foreground" : "text-warning")}>
      {pass ? <Check className="size-3" /> : <AlertTriangle className="size-3" />}
      {props.ratio.toFixed(1)}:1{pass ? ` ${props.text}` : ""}
    </span>
  );
}

function WarningBox(props: { warning: ContrastWarning; onUse: (token: string, colour: string) => void }) {
  const w = props.warning;
  const lowest = w.rows.reduce((min, row) => (row.ratio < min.ratio ? row : min), w.rows[0]!);
  const isUi = w.target < 4.5;
  return (
    <div
      role="alert"
      data-testid={`theme-contrast-warning-${w.token}`}
      className="flex gap-2 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-foreground"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <div>
        <b>
          {labelFor(w.token)} on {lowest.label.split(" / ")[1]?.replace(" (UI)", "")} is {lowest.ratio.toFixed(1)}:1, below{" "}
          {w.target}:1.
        </b>{" "}
        {isUi ? "It will be hard to see." : "Small text will be hard to read."}{" "}
        <button
          type="button"
          className="font-medium text-foreground underline underline-offset-2"
          onClick={() => props.onUse(w.token, w.suggestion)}
          data-testid={`theme-contrast-use-${w.token}`}
        >
          Use {w.suggestion}
        </button>
        : same hue, passes on {w.token === "accent" ? "its text and backgrounds" : "every background it is used on"}.
      </div>
    </div>
  );
}

function Row(props: { label: string; children: ReactNode; note?: ReactNode; sub?: string }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] items-center gap-3 border-b border-border/60 py-2 last:border-b-0">
      <div className="text-sm text-foreground">
        {props.label}
        {props.sub ? <div className="text-xs text-muted-foreground">{props.sub}</div> : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {props.children}
        {props.note}
      </div>
    </div>
  );
}

export type CustomThemeEditorProps = {
  /** The theme being edited (saved custom theme, a preset copy or an imported theme). */
  initial: CustomTheme;
  /** What it started from, shown in the header ("Rose", "a theme code"). */
  startedFrom: string;
  /** Whether Apply should be enabled without edits (new or imported theme). */
  unsavedFromStart: boolean;
  /** Applying replaces an existing custom theme (one slot). */
  replaces?: boolean;
  preferredMode: ThemeVariantMode;
  onPreview: (theme: CustomTheme) => void;
  onApply: (theme: CustomTheme) => void;
  onRevert: () => void;
};

export function CustomThemeEditor(props: CustomThemeEditorProps) {
  const [draft, setDraft] = useState<CustomTheme>(() => cloneTheme(props.initial));
  const [mode, setMode] = useState<ThemeVariantMode>(() =>
    props.initial.modes.includes(props.preferredMode) ? props.preferredMode : props.initial.modes[0]!,
  );
  const nameId = useId();
  const variant = draft[mode]!;

  const update = (next: CustomTheme) => {
    setDraft(next);
    props.onPreview(next);
  };
  const setColour = (path: string, value: string) => update({ ...draft, [mode]: writePath(variant, path, value) });

  const warnings = useMemo(() => contrastWarnings(variant), [variant]);
  const warningFor = (token: string) => warnings.find((w) => w.token === token);
  const changed = countChanged(props.initial[mode], variant);
  const otherMode: ThemeVariantMode = mode === "light" ? "dark" : "light";
  const changedOther = countChanged(props.initial[otherMode], draft[otherMode]);
  const metaChanged =
    draft.name !== props.initial.name ||
    draft.radiusPx !== props.initial.radiusPx ||
    draft.fontSizePx !== props.initial.fontSizePx;
  const dirty = props.unsavedFromStart || changed > 0 || changedOther > 0 || metaChanged;
  const allWarnings = draft.modes.reduce((sum, m) => sum + contrastWarnings(draft[m]!).length, 0);

  const field = (token: string, note?: ReactNode) => {
    const warning = warningFor(token);
    return (
      <div key={token}>
        <Row label={labelFor(token)} note={note}>
          <ColourInput
            label={labelFor(token)}
            value={readPath(variant, token)}
            onChange={(value) => setColour(token, value)}
            testId={`theme-field-${token}`}
          />
        </Row>
        {warning ? (
          <div className="pb-2 pl-[9.25rem]">
            <WarningBox warning={warning} onUse={setColour} />
          </div>
        ) : null}
      </div>
    );
  };

  const rowTokens = new Set([
    "accent",
    "accentText",
    "background",
    "surface",
    "surfaceRaised",
    "border",
    "text",
    "textMuted",
    "code.bg",
  ]);
  const syntaxWarnings = warnings.filter((w) => w.token.startsWith("code.") && w.token !== "code.bg");
  const terminalWarnings = warnings.filter((w) => w.token.startsWith("terminal."));
  const otherWarnings = warnings.filter(
    (w) => !rowTokens.has(w.token) && !w.token.startsWith("code.") && !w.token.startsWith("terminal."),
  );

  return (
    <section aria-label="Custom theme editor" className="flex flex-col gap-4" data-testid="custom-theme-editor">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-foreground">Custom theme · {draft.name}</h4>
          <p className="max-w-xl text-sm text-muted-foreground">
            Started from {props.startedFrom}. Editing the <b>{mode}</b> version. Changes show live in this window and are
            saved only when you press Apply.
          </p>
        </div>
        {draft.modes.length > 1 ? (
          <div role="tablist" aria-label="Version" className="flex rounded-lg border border-border p-0.5 text-sm">
            {draft.modes.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                data-testid={`theme-edit-${m}`}
                className={cn(
                  "rounded-md px-3 py-1 text-muted-foreground",
                  mode === m && "bg-muted text-foreground",
                )}
              >
                {m === "light" ? "Light version" : "Dark version"}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid gap-6 @3xl/settings:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0">
          <Row label="Name">
            <input
              id={nameId}
              aria-label="Theme name"
              value={draft.name}
              maxLength={MAX_NAME_LENGTH}
              onChange={(event) => update({ ...draft, name: event.target.value.replace(/[\p{C}]/gu, "") })}
              onBlur={() => {
                if (!draft.name.trim()) update({ ...draft, name: "My theme" });
              }}
              className="w-56 rounded-lg border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="theme-field-name"
            />
          </Row>
          {field("accent", <RatioNote ratio={contrastRatio(variant.accentText, variant.accent)} target={4.5} text="text on accent" />)}
          {field("accentText")}
          {field("background")}
          {field("surface")}
          {field("surfaceRaised")}
          {field("border")}
          {field("text", <RatioNote ratio={worstRatio(variant.text, textBackgrounds(variant))} target={4.5} text="lowest of 4 backgrounds" />)}
          {field("textMuted", <RatioNote ratio={worstRatio(variant.textMuted, textBackgrounds(variant))} target={4.5} text="lowest of 4 backgrounds" />)}
          {field("code.bg", <RatioNote ratio={contrastRatio(variant.code.fg, variant.code.bg)} target={4.5} text="code text" />)}
          <Row label="Syntax">
            <div className="flex flex-wrap gap-2">
              {SYNTAX_KEYS.map((key) => (
                <div key={key} className="flex w-12 flex-col items-center gap-0.5 text-[10px] text-muted-foreground">
                  <ColourInput compact label={`Syntax ${key}`} value={variant.code[key]} onChange={(value) => setColour(`code.${key}`, value)} testId={`theme-field-code.${key}`} />
                  {SYNTAX_LABELS[key]}
                </div>
              ))}
            </div>
          </Row>
          {syntaxWarnings.map((w) => (
            <div key={w.token} className="pb-2 pl-[9.25rem]">
              <WarningBox warning={w} onUse={setColour} />
            </div>
          ))}
          <Row label="Terminal" sub="normal / bright">
            <div className="grid grid-cols-8 gap-2">
              {ANSI_KEYS.map((key) => (
                <div key={key} className="flex w-11 flex-col items-center gap-0.5 text-[10px] text-muted-foreground">
                  <ColourInput compact label={`Terminal ${key}`} value={variant.terminal[key]} onChange={(value) => setColour(`terminal.${key}`, value)} testId={`theme-field-terminal.${key}`} />
                  {key.replace(/^bright/, "").toLowerCase()}
                </div>
              ))}
            </div>
          </Row>
          <Row label="Terminal text">
            <div className="flex gap-2">
              {(["fg", "bg", "cursor"] as const).map((key) => (
                <div key={key} className="flex w-11 flex-col items-center gap-0.5 text-[10px] text-muted-foreground">
                  <ColourInput compact label={`Terminal ${key}`} value={variant.terminal[key]} onChange={(value) => setColour(`terminal.${key}`, value)} testId={`theme-field-terminal.${key}`} />
                  {key}
                </div>
              ))}
            </div>
          </Row>
          {terminalWarnings.map((w) => (
            <div key={w.token} className="pb-2 pl-[9.25rem]">
              <WarningBox warning={w} onUse={setColour} />
            </div>
          ))}
          {otherWarnings.map((w) => (
            <div key={w.token} className="pb-2 pl-[9.25rem]">
              <WarningBox warning={w} onUse={setColour} />
            </div>
          ))}
          <Row label="Corner radius">
            <input
              type="range"
              aria-label="Corner radius"
              min={RADIUS_RANGE.min}
              max={RADIUS_RANGE.max}
              step={1}
              value={draft.radiusPx}
              onChange={(event) => update({ ...draft, radiusPx: Number(event.target.value) })}
              className="w-40 accent-foreground"
              data-testid="theme-field-radius"
            />
            <span className="font-mono text-xs text-muted-foreground">
              {Math.round(draft.radiusPx)} px ({RADIUS_RANGE.min}–{RADIUS_RANGE.max})
            </span>
          </Row>
          <Row label="Font size">
            <input
              type="range"
              aria-label="Font size"
              min={FONT_SIZE_RANGE.min}
              max={FONT_SIZE_RANGE.max}
              step={1}
              value={draft.fontSizePx}
              onChange={(event) => update({ ...draft, fontSizePx: Number(event.target.value) })}
              className="w-40 accent-foreground"
              data-testid="theme-field-font-size"
            />
            <span className="font-mono text-xs text-muted-foreground">
              {draft.fontSizePx} px ({FONT_SIZE_RANGE.min}–{FONT_SIZE_RANGE.max})
            </span>
          </Row>
        </div>
        <div className="@3xl/settings:sticky @3xl/settings:top-4 self-start">
          <ThemeLivePreview variant={variant} radiusPx={draft.radiusPx} fontSizePx={draft.fontSizePx} />
        </div>
      </div>

      <div
        className="sticky bottom-2 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-popover px-4 py-2.5 text-sm shadow-sm"
        data-testid="theme-unsaved-bar"
      >
        <span className={cn("size-2 rounded-full", dirty ? "bg-warning" : "bg-muted-foreground/40")} />
        <span className="min-w-0 flex-1 text-muted-foreground">
          <b className="text-foreground">{dirty ? "Unsaved changes" : "No changes"}</b>
          {changed > 0 ? ` · ${changed} colour${changed === 1 ? "" : "s"} changed in the ${mode} version` : ""}
          {changedOther > 0 ? ` · ${changedOther} in the ${otherMode} version` : ""}
          {allWarnings > 0 ? ` · ${allWarnings} contrast warning${allWarnings === 1 ? "" : "s"}` : ""}
          {props.replaces ? " · Apply replaces your current custom theme" : ""}
        </span>
        <Button variant="outline" size="sm" onClick={props.onRevert} data-testid="theme-revert">
          Revert
        </Button>
        <Button
          size="sm"
          disabled={!dirty}
          onClick={() => props.onApply({ ...draft, name: draft.name.trim() || "My theme" })}
          data-testid="theme-apply"
        >
          Apply
        </Button>
      </div>
    </section>
  );
}
