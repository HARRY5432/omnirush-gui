/**
 * Monaco for the desktop editor, loaded on first use only (editor-panel.tsx
 * imports this module lazily): the core editor and diff editor, the editing
 * features a code editor needs, and syntax colouring for every language
 * Monaco ships (each grammar loads when a file of that language opens).
 * Language services (TypeScript, JSON, CSS, HTML workers) are left out: they
 * cost hundreds of MB on large projects and the agent already runs the
 * project's own checks. The one worker is Monaco's editor worker (diffs,
 * word completion), started on demand.
 */
import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { getActiveTheme } from "@/app/theme";
import { legacyMonacoTheme, monacoThemeFor } from "@/app/themes/editor-themes";

import "monaco-editor/features/codicon/register.js";
import "monaco-editor/features/codeEditor/register.js";
import "monaco-editor/features/diffEditor/register.js";
import "monaco-editor/features/bracketMatching/register.js";
import "monaco-editor/features/caretOperations/register.js";
import "monaco-editor/features/clipboard/register.js";
import "monaco-editor/features/comment/register.js";
import "monaco-editor/features/contextmenu/register.js";
import "monaco-editor/features/cursorUndo/register.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/features/folding/register.js";
import "monaco-editor/features/gotoLine/register.js";
import "monaco-editor/features/hover/register.js";
import "monaco-editor/features/indentation/register.js";
import "monaco-editor/features/lineSelection/register.js";
import "monaco-editor/features/linesOperations/register.js";
import "monaco-editor/features/links/register.js";
import "monaco-editor/features/multicursor/register.js";
import "monaco-editor/features/smartSelect/register.js";
import "monaco-editor/features/stickyScroll/register.js";
import "monaco-editor/features/suggest/register.js";
import "monaco-editor/features/tokenization/register.js";
import "monaco-editor/features/unicodeHighlighter/register.js";
import "monaco-editor/features/wordHighlighter/register.js";
import "monaco-editor/features/wordOperations/register.js";
import "monaco-editor/features/readOnlyMessage/register.js";
// Syntax colouring only (Monarch grammars, each loaded on first use); not languages/register.all.js,
// which also starts the CSS/HTML/JSON/TypeScript language-service workers.
import "monaco-editor/languages/definitions/abap/register.js";
import "monaco-editor/languages/definitions/apex/register.js";
import "monaco-editor/languages/definitions/azcli/register.js";
import "monaco-editor/languages/definitions/bat/register.js";
import "monaco-editor/languages/definitions/bicep/register.js";
import "monaco-editor/languages/definitions/cameligo/register.js";
import "monaco-editor/languages/definitions/clojure/register.js";
import "monaco-editor/languages/definitions/coffee/register.js";
import "monaco-editor/languages/definitions/cpp/register.js";
import "monaco-editor/languages/definitions/csharp/register.js";
import "monaco-editor/languages/definitions/csp/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/cypher/register.js";
import "monaco-editor/languages/definitions/dart/register.js";
import "monaco-editor/languages/definitions/dockerfile/register.js";
import "monaco-editor/languages/definitions/ecl/register.js";
import "monaco-editor/languages/definitions/elixir/register.js";
import "monaco-editor/languages/definitions/flow9/register.js";
import "monaco-editor/languages/definitions/freemarker2/register.js";
import "monaco-editor/languages/definitions/fsharp/register.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/graphql/register.js";
import "monaco-editor/languages/definitions/handlebars/register.js";
import "monaco-editor/languages/definitions/hcl/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/ini/register.js";
import "monaco-editor/languages/definitions/java/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/julia/register.js";
import "monaco-editor/languages/definitions/kotlin/register.js";
import "monaco-editor/languages/definitions/less/register.js";
import "monaco-editor/languages/definitions/lexon/register.js";
import "monaco-editor/languages/definitions/liquid/register.js";
import "monaco-editor/languages/definitions/lua/register.js";
import "monaco-editor/languages/definitions/m3/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/mdx/register.js";
import "monaco-editor/languages/definitions/mips/register.js";
import "monaco-editor/languages/definitions/msdax/register.js";
import "monaco-editor/languages/definitions/mysql/register.js";
import "monaco-editor/languages/definitions/objective-c/register.js";
import "monaco-editor/languages/definitions/pascal/register.js";
import "monaco-editor/languages/definitions/pascaligo/register.js";
import "monaco-editor/languages/definitions/perl/register.js";
import "monaco-editor/languages/definitions/pgsql/register.js";
import "monaco-editor/languages/definitions/php/register.js";
import "monaco-editor/languages/definitions/pla/register.js";
import "monaco-editor/languages/definitions/postiats/register.js";
import "monaco-editor/languages/definitions/powerquery/register.js";
import "monaco-editor/languages/definitions/powershell/register.js";
import "monaco-editor/languages/definitions/protobuf/register.js";
import "monaco-editor/languages/definitions/pug/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/qsharp/register.js";
import "monaco-editor/languages/definitions/r/register.js";
import "monaco-editor/languages/definitions/razor/register.js";
import "monaco-editor/languages/definitions/redis/register.js";
import "monaco-editor/languages/definitions/redshift/register.js";
import "monaco-editor/languages/definitions/restructuredtext/register.js";
import "monaco-editor/languages/definitions/ruby/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/sb/register.js";
import "monaco-editor/languages/definitions/scala/register.js";
import "monaco-editor/languages/definitions/scheme/register.js";
import "monaco-editor/languages/definitions/scss/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/solidity/register.js";
import "monaco-editor/languages/definitions/sophia/register.js";
import "monaco-editor/languages/definitions/sparql/register.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/languages/definitions/st/register.js";
import "monaco-editor/languages/definitions/swift/register.js";
import "monaco-editor/languages/definitions/systemverilog/register.js";
import "monaco-editor/languages/definitions/tcl/register.js";
import "monaco-editor/languages/definitions/twig/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/typespec/register.js";
import "monaco-editor/languages/definitions/vb/register.js";
import "monaco-editor/languages/definitions/wgsl/register.js";
import "monaco-editor/languages/definitions/xml/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";

export type Monaco = typeof monaco;

/** The app's theme: `data-theme` on <html> (app/theme.ts), or a `dark` class. */
export function appIsDark(): boolean {
  const root = document.documentElement;
  return root.dataset.theme === "dark" || root.classList.contains("dark");
}

let configured = false;
// Two fixed theme names used in turn: a change always switches name (so Monaco repaints)
// without defining a new theme per change (a colour picker drag sends many).
let currentThemeName = "";
let currentThemeKey = "";

/**
 * The editor theme from the active app theme: a preset or custom theme's code
 * colours, or (Default preset) today's look from the app's design tokens.
 */
function defineThemes(): string {
  const active = getActiveTheme();
  let data;
  if (active.legacy) {
    const css = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) => {
      const value = css.getPropertyValue(name).trim();
      return /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
    };
    const dark = appIsDark();
    data = legacyMonacoTheme(
      dark,
      token("--background", dark ? "#111113" : "#fcfcfd"),
      token("--foreground", dark ? "#edeef0" : "#1c2024"),
    );
  } else {
    data = monacoThemeFor(active);
  }
  const key = JSON.stringify(data);
  if (currentThemeName && key === currentThemeKey) return currentThemeName;
  const name = currentThemeName === "omnirush-a" ? "omnirush-b" : "omnirush-a";
  monaco.editor.defineTheme(name, data);
  currentThemeName = name;
  currentThemeKey = key;
  return name;
}

/** Defines the editor theme from the current app theme (an editor created later must not reuse a stale one). */
export function monacoThemeName(): string {
  return defineThemes();
}

/** Re-reads the active theme and switches the editor theme (mode, preset or custom theme changed). */
export function applyMonacoTheme(): void {
  monaco.editor.setTheme(defineThemes());
}

export function setupMonaco(): Monaco {
  if (!configured) {
    configured = true;
    (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
      getWorker: () => new EditorWorker(),
    };
    defineThemes();
  }
  return monaco;
}

/** Monaco's language id for a path, from the extensions and file names its grammars register. */
export function languageForPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();
  for (const language of monaco.languages.getLanguages()) {
    if (language.filenames?.some((candidate) => candidate.toLowerCase() === lower)) return language.id;
  }
  let best: { id: string; length: number } | null = null;
  for (const language of monaco.languages.getLanguages()) {
    for (const extension of language.extensions ?? []) {
      const ext = extension.toLowerCase();
      if (lower.endsWith(ext) && (!best || ext.length > best.length)) best = { id: language.id, length: ext.length };
    }
  }
  if (best) return best.id;
  // JSON has no grammar without its language-service worker; JavaScript's colours it well.
  if (/\.(json|jsonc|json5|webmanifest)$/.test(lower) || lower === ".babelrc" || lower === ".eslintrc") return "javascript";
  return "plaintext";
}
