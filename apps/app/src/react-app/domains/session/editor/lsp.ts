/**
 * Language features in the editor from the project's own language servers,
 * the ones the agent already runs (the engine's /editor/lsp routes): hover,
 * go to definition (F12, Cmd/Ctrl+click), references (Shift+F12), rename
 * (F2), document symbols (outline, breadcrumbs, Cmd/Ctrl+Shift+O),
 * diagnostics (squiggles and the Problems panel), and "Fix with agent" as a
 * quick fix. An unsaved buffer's text goes with each request; the engine
 * uses it for that request only and then goes back to the file on disk.
 *
 * Bounds: a file's language servers start only once it has been the active
 * file for a moment, or on the first edit / go to / rename / go to symbol request
 * (not when a file is just glanced at); one request per file at a time; no
 * unsaved text while the chat's agent is working; and the "Language features
 * in the editor" switch turns all of it off.
 */
import { create } from "zustand";
import type * as MonacoApi from "monaco-editor/editor/editor.api.js";

import type { OmniRushServerClient } from "@/app/lib/omnirush-server";
import { toast } from "@/components/ui/sonner";
import type { EditorDocuments } from "./editor-models";
import { useEditorStore } from "./editor-store";
import type { Monaco } from "./monaco";

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type LspDiagnostic = { range: LspRange; severity?: number; message: string; source?: string; code?: string | number | { value: string | number } };
export type ProblemFile = { path: string; diagnostics: LspDiagnostic[] };

type Context = {
  monaco: Monaco;
  client: OmniRushServerClient;
  workspaceId: string;
  workspaceRoot: string;
  docs: EditorDocuments;
  /** Opens a project file in the editor at a 1-based position. */
  openAt: (path: string, line: number, column: number) => void;
  /** "Fix with agent" for a diagnostic. */
  fixWithAgent: (path: string, diagnostic: LspDiagnostic) => void;
};

let current: Context | null = null;
let installed = false;
let unavailable = false;
let sessionBusy = false;

/** Files whose language features have started (per workspace): the outline and diagnostics follow it. */
export const useLspActivation = create<{ active: Record<string, true> }>(() => ({ active: {} }));
const activationKey = (path: string) => `${current?.workspaceId ?? ""}\u0000${path}`;
export function isLspActive(path: string): boolean {
  return Boolean(useLspActivation.getState().active[activationKey(path)]);
}
export function useIsLspActive(path: string | null): boolean {
  return useLspActivation((state) => (path ? Boolean(state.active[activationKey(path)]) : false));
}
/** Starts language features for the file of an editor model (go to symbol and other explicit actions). */
export function activateLspForModel(model: MonacoApi.editor.ITextModel) {
  const path = modelPath(model);
  if (path) activateLsp(path);
}
/** Starts language features for a file (its language servers open it). */
export function activateLsp(path: string) {
  if (!current || !useEditorStore.getState().languageFeatures || isLspActive(path)) return;
  const key = activationKey(path);
  useLspActivation.setState((state) => ({ active: { ...state.active, [key]: true } }));
}

/** While the chat's agent works, no unsaved text goes to the language servers (its tools read their diagnostics). */
export function setLspSessionBusy(busy: boolean) {
  sessionBusy = busy;
}

/** The Problems panel: diagnostics per project file, as the language servers last reported them. */
export const useProblemsStore = create<{
  byWorkspace: Record<string, ProblemFile[]>;
  available: boolean;
  set: (workspaceId: string, files: ProblemFile[]) => void;
  merge: (workspaceId: string, file: ProblemFile) => void;
  setAvailable: (available: boolean) => void;
}>((set) => ({
  byWorkspace: {},
  available: true,
  set: (workspaceId, files) => set((state) => ({ byWorkspace: { ...state.byWorkspace, [workspaceId]: files.filter((file) => file.diagnostics.length) } })),
  merge: (workspaceId, file) =>
    set((state) => {
      const rest = (state.byWorkspace[workspaceId] ?? []).filter((item) => item.path !== file.path);
      return { byWorkspace: { ...state.byWorkspace, [workspaceId]: file.diagnostics.length ? [...rest, file].sort((a, b) => a.path.localeCompare(b.path)) : rest } };
    }),
  setAvailable: (available) => set({ available }),
}));

export function problemCounts(files: readonly ProblemFile[]) {
  let errors = 0;
  let warnings = 0;
  for (const file of files) {
    for (const diagnostic of file.diagnostics) {
      if ((diagnostic.severity ?? 1) === 1) errors += 1;
      else if (diagnostic.severity === 2) warnings += 1;
    }
  }
  return { errors, warnings };
}

/** The workspace-relative path of an editor model, or null (baselines, other workspaces). */
function modelPath(model: MonacoApi.editor.ITextModel): string | null {
  return uriPath(model.uri);
}

/** The workspace-relative path of an editor URI of the current workspace, or null. */
function uriPath(uri: MonacoApi.Uri): string | null {
  if (!current || uri.scheme !== "omnirush-file") return null;
  if (uri.authority !== current.docs.uri("x").authority) return null;
  return uri.path.replace(/^\//, "");
}

/** A `file://` URI from a language server to a workspace path, or null when it is outside the project. */
export function uriToPath(uri: string, workspaceRoot: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let path: string;
  try {
    path = decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = path.replace(/\\/g, "/");
  const caseless = /^[A-Za-z]:\//.test(root);
  const inside = caseless ? normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) : normalized.startsWith(`${root}/`);
  return inside ? normalized.slice(root.length + 1) : null;
}

function toMonacoRange(monaco: Monaco, range: LspRange): MonacoApi.IRange {
  return new monaco.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
}

function isDirty(path: string): boolean {
  const doc = current?.docs.get(path);
  return Boolean(doc && current?.docs.isDirty(doc));
}

function payloadFor(model: MonacoApi.editor.ITextModel, path: string, position?: MonacoApi.Position) {
  const text = isDirty(path) && !sessionBusy ? model.getValue() : undefined;
  return {
    path,
    ...(position ? { line: position.lineNumber - 1, character: position.column - 1 } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

/** One request per file at a time (the engine swaps a file's text in the language servers per request). */
const lanes = new Map<string, Promise<unknown>>();
function inLane<T>(path: string, run: () => Promise<T>): Promise<T> {
  const key = activationKey(path);
  const next = (lanes.get(key) ?? Promise.resolve()).then(run, run);
  const settled = next.catch(() => undefined);
  lanes.set(key, settled);
  void settled.then(() => {
    if (lanes.get(key) === settled) lanes.delete(key);
  });
  return next;
}

/**
 * Whether this engine has the editor routes, checked once per workspace with an empty request before any file
 * text is sent (an engine without them could hand an unknown request to something else).
 */
let support: Promise<boolean> | null = null;
function supported(ctx: Context): Promise<boolean> {
  support ??= ctx.client.editorLsp<unknown>(ctx.workspaceId, "diagnostics", {}).then((raw) => Array.isArray(raw), () => false);
  return support;
}

async function call<T>(op: Parameters<OmniRushServerClient["editorLsp"]>[1], payload: Parameters<OmniRushServerClient["editorLsp"]>[2]): Promise<T | null> {
  if (!current || unavailable || !useEditorStore.getState().languageFeatures) return null;
  const ctx = current;
  const path = typeof payload.path === "string" ? payload.path : null;
  if (!(await supported(ctx))) {
    if (current === ctx) {
      unavailable = true;
      useProblemsStore.getState().setAvailable(false);
    }
    return null;
  }
  try {
    const run = () => ctx.client.editorLsp<T>(ctx.workspaceId, op, payload);
    return await (path ? inLane(path, run) : run());
  } catch (error) {
    // An engine without the editor routes (older build): language features stay off quietly.
    if ((error as { status?: number }).status === 404) {
      unavailable = true;
      useProblemsStore.getState().setAvailable(false);
    }
    return null;
  }
}

type LspLocation = { uri?: string; range?: LspRange; targetUri?: string; targetRange?: LspRange; targetSelectionRange?: LspRange };

/** Locations inside the project, with an editor model ready for each (peek and go-to need one). */
async function toLocations(raw: unknown): Promise<MonacoApi.languages.Location[]> {
  if (!current) return [];
  const ctx = current;
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as LspLocation[];
  const out: MonacoApi.languages.Location[] = [];
  const opened = new Set<string>();
  for (const item of list.slice(0, 200)) {
    const uri = item.targetUri ?? item.uri;
    const range = item.targetSelectionRange ?? item.targetRange ?? item.range;
    if (!uri || !range) continue;
    const path = uriToPath(uri, ctx.workspaceRoot);
    if (!path) continue;
    if (!opened.has(path)) {
      if (opened.size >= 30) continue;
      const result = await ctx.docs.open(path);
      if (!result.ok) continue;
      opened.add(path);
    }
    out.push({ uri: ctx.docs.uri(path), range: toMonacoRange(ctx.monaco, range) });
  }
  return out;
}

const SYMBOL_KIND_MAP = (monaco: Monaco, kind: number) => {
  // LSP SymbolKind is 1-based; Monaco's is the same list 0-based.
  const value = Math.max(0, kind - 1);
  return value as MonacoApi.languages.SymbolKind;
};

type LspDocumentSymbol = { name: string; detail?: string; kind: number; range?: LspRange; selectionRange?: LspRange; children?: LspDocumentSymbol[]; location?: { uri: string; range: LspRange } };

function toDocumentSymbols(monaco: Monaco, raw: LspDocumentSymbol[]): MonacoApi.languages.DocumentSymbol[] {
  return raw
    .filter((symbol) => symbol && typeof symbol.name === "string")
    .map((symbol): MonacoApi.languages.DocumentSymbol | null => {
      const range = symbol.range ?? symbol.location?.range;
      const selection = symbol.selectionRange ?? range;
      if (!range || !selection) return null;
      return {
        name: symbol.name,
        detail: symbol.detail ?? "",
        kind: SYMBOL_KIND_MAP(monaco, symbol.kind),
        tags: [],
        range: toMonacoRange(monaco, range),
        selectionRange: toMonacoRange(monaco, selection),
        children: symbol.children ? toDocumentSymbols(monaco, symbol.children) : undefined,
      };
    })
    .filter((item): item is MonacoApi.languages.DocumentSymbol => item !== null);
}

/** Document symbols of a model (cached per version), for the outline and breadcrumbs. */
const symbolCache = new Map<string, { version: number; symbols: MonacoApi.languages.DocumentSymbol[] }>();
export async function documentSymbols(model: MonacoApi.editor.ITextModel, options: { userAction?: boolean } = {}): Promise<MonacoApi.languages.DocumentSymbol[] | null> {
  const path = modelPath(model);
  if (!path || !current) return [];
  if (options.userAction) activateLsp(path);
  if (!isLspActive(path)) return null;
  const key = model.uri.toString();
  const cached = symbolCache.get(key);
  if (cached && cached.version === model.getVersionId()) return cached.symbols;
  // Unsaved text cannot be sent now: keep what the outline shows.
  if (cached && isDirty(path) && sessionBusy) return cached.symbols;
  const raw = await call<LspDocumentSymbol[]>("symbols", payloadFor(model, path));
  const symbols = Array.isArray(raw) ? toDocumentSymbols(current.monaco, raw) : [];
  symbolCache.set(key, { version: model.getVersionId(), symbols });
  return symbols;
}

/** The symbols around a position, outermost first (breadcrumbs). */
export function symbolPath(symbols: readonly MonacoApi.languages.DocumentSymbol[], line: number, column: number): MonacoApi.languages.DocumentSymbol[] {
  const inside = (range: MonacoApi.IRange) =>
    (line > range.startLineNumber || (line === range.startLineNumber && column >= range.startColumn))
    && (line < range.endLineNumber || (line === range.endLineNumber && column <= range.endColumn));
  for (const symbol of symbols) {
    if (inside(symbol.range)) return [symbol, ...symbolPath(symbol.children ?? [], line, column)];
  }
  return [];
}

function hoverContents(raw: unknown): MonacoApi.IMarkdownString[] {
  const out: MonacoApi.IMarkdownString[] = [];
  const add = (value: unknown) => {
    if (!value) return;
    if (typeof value === "string") out.push({ value });
    else if (typeof value === "object" && "value" in (value as Record<string, unknown>)) {
      const item = value as { value: string; language?: string; kind?: string };
      out.push({ value: item.language ? `\`\`\`${item.language}\n${item.value}\n\`\`\`` : item.value });
    }
  };
  for (const hover of Array.isArray(raw) ? raw : [raw]) {
    const contents = (hover as { contents?: unknown } | null)?.contents;
    if (Array.isArray(contents)) contents.forEach(add);
    else add(contents);
  }
  return out;
}

const SEVERITY = (monaco: Monaco, severity?: number) =>
  severity === 2 ? monaco.MarkerSeverity.Warning : severity === 3 ? monaco.MarkerSeverity.Info : severity === 4 ? monaco.MarkerSeverity.Hint : monaco.MarkerSeverity.Error;

export function diagnosticCode(diagnostic: LspDiagnostic): string | undefined {
  const code = diagnostic.code;
  if (code === undefined || code === null) return undefined;
  return typeof code === "object" ? String(code.value) : String(code);
}

/** Squiggles for one open file, from diagnostics. */
export function applyMarkers(path: string, diagnostics: readonly LspDiagnostic[]) {
  if (!current) return;
  const doc = current.docs.get(path);
  if (!doc) return;
  const monaco = current.monaco;
  monaco.editor.setModelMarkers(doc.model, "lsp", diagnostics.map((diagnostic) => ({
    ...toMonacoRange(monaco, diagnostic.range),
    severity: SEVERITY(monaco, diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source,
    code: diagnosticCode(diagnostic),
  })));
}

/** Per file: a diagnostics request running, one more wanted after it (only the latest counts). */
const diagnosticsRuns = new Map<string, { pending: boolean }>();

/** Diagnostics of one file (its unsaved text when dirty) into its squiggles and the Problems panel. */
export async function refreshFileDiagnostics(path: string): Promise<void> {
  if (!current || !isLspActive(path)) return;
  const ctx = current;
  const key = activationKey(path);
  const running = diagnosticsRuns.get(key);
  if (running) {
    running.pending = true;
    return;
  }
  const run = { pending: true };
  diagnosticsRuns.set(key, run);
  try {
    while (run.pending && current === ctx) {
      run.pending = false;
      const doc = ctx.docs.get(path);
      // Unsaved text cannot be sent while the agent works, and the disk's diagnostics do not fit the buffer: keep the squiggles.
      if (!doc || (isDirty(path) && sessionBusy)) return;
      const version = doc.model.getVersionId();
      const raw = await call<ProblemFile[]>("diagnostics", payloadFor(doc.model, path));
      // An edit since the request: its result is already stale; the run after it applies.
      if (!raw || current !== ctx || (doc.model.getVersionId() !== version && run.pending)) continue;
      const file = raw.find((item) => item.path === path) ?? { path, diagnostics: [] };
      applyMarkers(path, file.diagnostics);
      useProblemsStore.getState().merge(ctx.workspaceId, file);
    }
  } finally {
    diagnosticsRuns.delete(key);
  }
}

/** Every diagnostic the language servers hold for the project (files they have seen). */
export async function refreshAllDiagnostics(): Promise<void> {
  if (!current) return;
  const ctx = current;
  const raw = await call<ProblemFile[]>("diagnostics", {});
  if (!raw || current !== ctx) return;
  // Files with unsaved changes keep what their own text gave (the servers hold the disk copy's).
  const before = useProblemsStore.getState().byWorkspace[ctx.workspaceId] ?? [];
  const dirty = new Set(raw.map((file) => file.path).concat(before.map((file) => file.path)).filter(isDirty));
  const files = [...raw.filter((file) => !dirty.has(file.path)), ...before.filter((file) => dirty.has(file.path))];
  useProblemsStore.getState().set(ctx.workspaceId, files.sort((a, b) => a.path.localeCompare(b.path)));
  for (const file of raw) if (!dirty.has(file.path)) applyMarkers(file.path, file.diagnostics);
}

/** Language features turned off: squiggles and problems go, and files start again only after the dwell. */
export function clearLanguageFeatures() {
  if (current) {
    const monaco = current.monaco;
    for (const model of monaco.editor.getModels()) if (modelPath(model)) monaco.editor.setModelMarkers(model, "lsp", []);
    useProblemsStore.getState().set(current.workspaceId, []);
  }
  useLspActivation.setState({ active: {} });
  symbolCache.clear();
}

/** Where the editor's language features act now (the workspace shown). */
export function setLanguageContext(ctx: Context | null) {
  current = ctx;
  unavailable = false;
  support = null;
  symbolCache.clear();
  diagnosticsRuns.clear();
  useProblemsStore.getState().setAvailable(true);
}

/** The providers, once per Monaco instance; they act on the current context. */
export function installLanguageFeatures(monaco: Monaco) {
  if (installed) return;
  installed = true;
  const selector = "*";
  monaco.languages.registerHoverProvider(selector, {
    provideHover: async (model, position) => {
      // The mouse resting on a file just glanced at starts nothing: hover works once the file's features started.
      const path = modelPath(model);
      if (!path || !isLspActive(path)) return null;
      const contents = hoverContents(await call("hover", payloadFor(model, path, position)));
      return contents.length ? { contents } : null;
    },
  });
  monaco.languages.registerDefinitionProvider(selector, {
    provideDefinition: async (model, position) => {
      const path = modelPath(model);
      if (!path) return null;
      activateLsp(path);
      return toLocations(await call("definition", payloadFor(model, path, position)));
    },
  });
  monaco.languages.registerReferenceProvider(selector, {
    provideReferences: async (model, position) => {
      const path = modelPath(model);
      if (!path) return null;
      activateLsp(path);
      return toLocations(await call("references", payloadFor(model, path, position)));
    },
  });
  monaco.languages.registerDocumentSymbolProvider(selector, {
    displayName: "Language server",
    // Only go to symbol (Cmd/Ctrl+Shift+O) asks Monaco for symbols (sticky scroll uses indentation): an explicit request.
    provideDocumentSymbols: async (model) => (await documentSymbols(model, { userAction: true })) ?? [],
  });
  // Monaco's standalone build only logs a rename's reject reason: say it as a toast too.
  const reject = (reason: string) => {
    toast.info(reason);
    return { edits: [], rejectReason: reason };
  };
  monaco.languages.registerRenameProvider(selector, {
    provideRenameEdits: async (model, position, newName) => {
      const path = modelPath(model);
      if (!path || !current) return null;
      const ctx = current;
      activateLsp(path);
      if (isDirty(path) && sessionBusy) return reject("Save this file or wait for the agent to finish before renaming.");
      const raw = await call<unknown[]>("rename", { ...payloadFor(model, path, position), newName });
      const edits: MonacoApi.languages.IWorkspaceTextEdit[] = [];
      type TextEdit = { range: LspRange; newText: string };
      const addEdits = async (uri: string, list: TextEdit[]) => {
        const target = uriToPath(uri, ctx.workspaceRoot);
        if (!target) return;
        const opened = await ctx.docs.open(target);
        if (!opened.ok) return;
        for (const edit of list) {
          edits.push({ resource: ctx.docs.uri(target), versionId: undefined, textEdit: { range: toMonacoRange(ctx.monaco, edit.range), text: edit.newText } });
        }
      };
      for (const result of raw ?? []) {
        const workspaceEdit = result as { changes?: Record<string, TextEdit[]>; documentChanges?: Array<{ textDocument?: { uri: string }; edits?: TextEdit[] }> };
        for (const [uri, list] of Object.entries(workspaceEdit.changes ?? {})) await addEdits(uri, list);
        for (const change of workspaceEdit.documentChanges ?? []) {
          if (change.textDocument?.uri && change.edits) await addEdits(change.textDocument.uri, change.edits);
        }
      }
      if (!edits.length) return reject("Nothing to rename here (or the language server cannot rename this).");
      // Other files' edits were computed on their saved text: refuse rather than misplace them in unsaved buffers.
      const otherDirty = edits.some((edit) => {
        const target = uriPath(edit.resource);
        return target !== null && target !== path && isDirty(target);
      });
      if (otherDirty) return reject("Save your other changes before renaming.");
      return { edits };
    },
  });
  const fixCommand = "omnirush.editor.fixWithAgent";
  monaco.editor.registerCommand(fixCommand, (_accessor, path: string, diagnostic: LspDiagnostic) => {
    current?.fixWithAgent(path, diagnostic);
  });
  monaco.languages.registerCodeActionProvider(selector, {
    provideCodeActions: (model, _range, context) => {
      const path = modelPath(model);
      if (!path || !context.markers.length) return { actions: [], dispose: () => undefined };
      const actions = context.markers.slice(0, 3).map((marker) => ({
        title: `Fix with agent: ${marker.message.split("\n")[0]!.slice(0, 60)}`,
        kind: "quickfix",
        diagnostics: [marker],
        isPreferred: false,
        command: {
          id: fixCommand,
          title: "Fix with agent",
          arguments: [path, {
            range: { start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 }, end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 } },
            severity: marker.severity === monaco.MarkerSeverity.Warning ? 2 : marker.severity === monaco.MarkerSeverity.Error ? 1 : 3,
            message: marker.message,
            source: marker.source,
            code: typeof marker.code === "object" ? marker.code?.value : marker.code,
          } satisfies LspDiagnostic],
        },
      }));
      return { actions, dispose: () => undefined };
    },
  });
  // Go to definition / references into another file: open it as a tab.
  monaco.editor.registerEditorOpener({
    openCodeEditor: (_source, resource, selectionOrPosition) => {
      const path = uriPath(resource);
      if (!current || !path) return false;
      const at = selectionOrPosition && "startLineNumber" in selectionOrPosition
        ? { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
        : selectionOrPosition && "lineNumber" in selectionOrPosition
          ? { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column }
          : { line: 1, column: 1 };
      current.openAt(path, at.line, at.column);
      return true;
    },
  });
}
