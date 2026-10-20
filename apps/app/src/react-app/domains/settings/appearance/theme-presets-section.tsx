/** @jsxImportSource react */
import { Check, Moon, Pencil, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { THEME_PRESETS } from "@/app/themes/presets";
import { presetModes } from "@/app/themes/palette";
import type { CustomTheme, ThemeVariant } from "@/app/themes/types";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings-layout";
import { ThemeVariantThumb } from "./theme-preview";

type Props = {
  busy: boolean;
  /** Selected preset id, or "custom" for My theme. */
  selectedId: string;
  customTheme: CustomTheme | null;
  note: string | null;
  onPickPreset: (id: string) => void;
  onPickCustom: () => void;
  onEditCustom: () => void;
  onNewCustom: () => void;
};

const modesLabel = (modes: readonly string[]) =>
  modes.length === 2 ? "Light / Dark" : modes[0] === "dark" ? "Dark only" : "Light only";

function swatchesOf(v: ThemeVariant) {
  return [v.accent, v.surface, v.code.string, v.code.function];
}

function Thumbs(props: { light?: ThemeVariant; dark?: ThemeVariant }) {
  if (props.light && props.dark) {
    return (
      <div className="grid h-full grid-cols-2">
        <ThemeVariantThumb variant={props.light} swatches={swatchesOf(props.light)} />
        <ThemeVariantThumb variant={props.dark} swatches={swatchesOf(props.dark)} />
      </div>
    );
  }
  const only = (props.light ?? props.dark)!;
  return <ThemeVariantThumb variant={only} swatches={swatchesOf(only)} />;
}

function Card(props: {
  selected: boolean;
  label: string;
  meta: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
  action?: ReactNode;
  testId: string;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        role="radio"
        aria-checked={props.selected}
        disabled={props.disabled}
        onClick={props.onClick}
        data-testid={props.testId}
        className={cn(
          "group flex w-full flex-col gap-2 rounded-xl border border-border bg-card p-1.5 text-left outline-none transition-shadow hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring",
          props.selected && "border-foreground ring-1 ring-foreground",
        )}
      >
        <div className="h-16 w-full overflow-hidden rounded-lg border border-border">{props.children}</div>
        <div className="flex items-center justify-between gap-2 px-1 pb-0.5 text-xs">
          <span className="flex min-w-0 items-center gap-1 font-medium text-foreground">
            {props.selected ? <Check className="size-3 shrink-0" /> : null}
            <span className="truncate">{props.label}</span>
          </span>
          <span className="shrink-0 text-muted-foreground">{props.meta}</span>
        </div>
      </button>
      {props.action}
    </div>
  );
}

export function ThemePresetsSection(props: Props) {
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader className="w-full">
        <LayoutSectionItemTitle>Theme</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>
          Each preset has a light and a dark version (Midnight is dark only); the mode above picks which one you see.
        </LayoutSectionItemDescription>
      </LayoutSectionItemHeader>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-3 @2xl/settings:grid-cols-4">
        {THEME_PRESETS.map((preset) => (
          <Card
            key={preset.id}
            testId={`theme-preset-${preset.id}`}
            selected={props.selectedId === preset.id}
            label={preset.name}
            meta={modesLabel(presetModes(preset))}
            disabled={props.busy}
            onClick={() => props.onPickPreset(preset.id)}
          >
            <Thumbs light={preset.variants.light} dark={preset.variants.dark} />
          </Card>
        ))}
        {props.customTheme ? (
          <Card
            testId="theme-preset-custom"
            selected={props.selectedId === "custom"}
            label={props.customTheme.name}
            meta={modesLabel(props.customTheme.modes)}
            disabled={props.busy}
            onClick={props.onPickCustom}
            action={
              <button
                type="button"
                onClick={props.onEditCustom}
                aria-label="Edit custom theme"
                data-testid="theme-edit-custom"
                className="absolute right-3 top-3 flex size-6 items-center justify-center rounded-md border border-border bg-popover text-foreground shadow-xs hover:bg-muted"
              >
                <Pencil className="size-3" />
              </button>
            }
          >
            <Thumbs light={props.customTheme.light} dark={props.customTheme.dark} />
          </Card>
        ) : null}
        <button
          type="button"
          onClick={props.onNewCustom}
          disabled={props.busy}
          data-testid="theme-new-custom"
          className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-1.5 text-left text-xs text-muted-foreground outline-none hover:border-foreground/25 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex h-16 w-full items-center justify-center rounded-lg border border-dashed border-border">
            <Plus className="size-4" />
          </span>
          <span className="px-1 pb-0.5 font-medium">{props.customTheme ? "Edit custom theme" : "New custom theme"}</span>
        </button>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="theme-mode-note" role="status">
        <Moon className="size-3 shrink-0" />
        {props.note ?? "Midnight is dark only. Choosing it while Mode is Light switches Mode to Dark."}
      </p>
    </LayoutSectionItem>
  );
}
