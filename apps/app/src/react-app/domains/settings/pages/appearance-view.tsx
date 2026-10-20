/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { isDesktopRuntime } from "@/app/utils";
import type { Language } from "@/i18n";
import { Separator } from "@/components/ui/separator";
import {
  modeSwitchFor,
  saveCustomTheme,
  setThemePreview,
  setThemeSelection,
} from "@/app/theme";
import { findPreset, presetModes } from "@/app/themes/palette";
import type { CustomTheme } from "@/app/themes/types";
import { CustomThemeEditor } from "../appearance/custom-theme-editor";
import { LanguageSection } from "../appearance/language-section";
import { ThemePresetsSection } from "../appearance/theme-presets-section";
import { ThemeSection } from "../appearance/theme-section";
import { ThemeShareSection } from "../appearance/theme-share-section";
import {
  customThemeFromPreset,
  presetName,
  trackThemeChanged,
  useActiveTheme,
  useSavedCustomTheme,
  useThemeSelection,
} from "../appearance/theme-state";
import { WindowSection } from "../appearance/window-section";
import { LayoutStack } from "../settings-layout";

export type AppearanceViewProps = {
  busy: boolean;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
  language: Language;
  setLanguage: (value: Language) => void;
  hideTitlebar: boolean;
  toggleHideTitlebar: () => void;
};

type EditorState = { initial: CustomTheme; startedFrom: string; unsavedFromStart: boolean; key: number };

export function AppearanceView(props: AppearanceViewProps) {
  const selection = useThemeSelection();
  const customTheme = useSavedCustomTheme();
  const active = useActiveTheme();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [importing, setImporting] = useState<{ theme: CustomTheme; source: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Leaving Appearance ends any unsaved preview.
  useEffect(() => () => setThemePreview(null), []);

  const selectedId = selection.kind === "custom" ? "custom" : selection.id;

  /** Single-mode themes (Midnight) switch Mode instead of silently showing the other mode. */
  const followModes = (name: string, modes: readonly ("light" | "dark")[]) => {
    const target = modeSwitchFor(modes, props.themeMode);
    if (target) {
      props.setThemeMode(target);
      setNote(`${name} is ${target} only, so Mode is now ${target === "dark" ? "Dark" : "Light"}.`);
      return target;
    }
    setNote(null);
    return props.themeMode;
  };

  const closeEditing = () => {
    setEditor(null);
    setImporting(null);
    setThemePreview(null);
  };

  const pickPreset = (id: string) => {
    const preset = findPreset(id);
    if (!preset) return;
    closeEditing();
    const mode = followModes(preset.name, presetModes(preset));
    setThemeSelection({ kind: "preset", id });
    trackThemeChanged({ kind: "preset", preset: id, mode });
  };

  const pickCustom = () => {
    if (!customTheme) return;
    closeEditing();
    const mode = followModes(customTheme.name, customTheme.modes);
    setThemeSelection({ kind: "custom" });
    trackThemeChanged({ kind: "custom", mode });
  };

  const openEditor = (initial: CustomTheme, startedFrom: string, unsavedFromStart: boolean) => {
    setImporting(null);
    setEditor({ initial, startedFrom, unsavedFromStart, key: Date.now() });
    setThemePreview(initial);
  };

  const editCustom = () => {
    if (customTheme) openEditor(customTheme, "your saved theme", false);
  };

  const newCustom = () => {
    if (customTheme && selection.kind === "custom") {
      editCustom();
      return;
    }
    const baseId = selection.kind === "preset" ? selection.id : "default";
    const preset = findPreset(baseId) ?? findPreset("default")!;
    openEditor(customThemeFromPreset(preset), presetName(preset.id), true);
  };

  const keepTheme = (theme: CustomTheme) => {
    saveCustomTheme(theme);
    setThemePreview(null);
    const mode = followModes(theme.name, theme.modes);
    setThemeSelection({ kind: "custom" });
    trackThemeChanged({ kind: "custom", mode });
    setEditor(null);
    setImporting(null);
  };

  return (
    <LayoutStack>
      <ThemeSection {...props} />
      <Separator />
      <ThemePresetsSection
        busy={props.busy}
        selectedId={selectedId}
        customTheme={customTheme}
        note={note}
        onPickPreset={pickPreset}
        onPickCustom={pickCustom}
        onEditCustom={editCustom}
        onNewCustom={newCustom}
      />
      {editor ? (
        <>
          <Separator />
          <CustomThemeEditor
            key={editor.key}
            initial={editor.initial}
            startedFrom={editor.startedFrom}
            unsavedFromStart={editor.unsavedFromStart}
            replaces={Boolean(customTheme) && editor.unsavedFromStart}
            preferredMode={active.mode}
            onPreview={(theme) => setThemePreview(theme)}
            onApply={keepTheme}
            onRevert={closeEditing}
          />
        </>
      ) : null}
      <Separator />
      <ThemeShareSection
        customTheme={customTheme}
        importing={importing}
        onImportPreview={(theme, source) => {
          setEditor(null);
          setImporting({ theme, source });
          setThemePreview(theme);
        }}
        onKeep={() => importing && keepTheme(importing.theme)}
        onEditFirst={() => importing && openEditor(importing.theme, importing.source, true)}
        onCancelImport={closeEditing}
      />
      <Separator />
      <LanguageSection {...props} />
      {isDesktopRuntime() ? (
        <>
          <Separator />
          <WindowSection {...props} />
        </>
      ) : null}
    </LayoutStack>
  );
}
