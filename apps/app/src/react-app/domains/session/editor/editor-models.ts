/**
 * The editor's documents for one workspace: a Monaco model per open file
 * (shared by its file tab, its review diff and its git diff, so an edit shows
 * everywhere), when it was read, and whether it has unsaved changes. Kept
 * while the app runs, so closing the panel keeps unsaved text.
 */
import type * as MonacoApi from "monaco-editor/editor/editor.api.js";

import { onFilesRewound } from "@/app/lib/files-rewound";
import type { OmniRushServerClient } from "@/app/lib/omnirush-server";
import { languageForPath, type Monaco } from "./monaco";
import { useEditorStore } from "./editor-store";

export type FileDoc = {
  path: string;
  model: MonacoApi.editor.ITextModel;
  /** The file's mtime when it was last read or saved; null for a file that does not exist yet. */
  updatedAt: number | null;
  savedVersion: number;
  /** The file changed on disk while this document had unsaved changes. */
  conflict: boolean;
  /** The file is gone from disk (deleted since it was opened, or an agent deletion under review). */
  missing: boolean;
};

export type OpenResult =
  | { ok: true; doc: FileDoc }
  | { ok: false; reason: "binary" | "too_large" | "missing" | "error"; message: string };

export type SaveOptions = { sessionId: string | null; source: "editor" | "review"; force?: boolean };
export type SaveResult = { ok: true } | { ok: false; conflict: boolean; message: string };

export class EditorDocuments {
  private docs = new Map<string, FileDoc>();
  private loading = new Map<string, Promise<OpenResult>>();
  private baselines = new Map<string, MonacoApi.editor.ITextModel>();
  /** Editor panels showing these documents (they re-read them after an undo themselves, and say what conflicts). */
  shown = 0;

  constructor(
    readonly monaco: Monaco,
    public client: OmniRushServerClient,
    readonly workspaceId: string,
  ) {}

  uri(path: string, scheme = "omnirush-file"): MonacoApi.Uri {
    return this.monaco.Uri.from({ scheme, authority: this.workspaceId.replace(/[^A-Za-z0-9_-]/g, "_"), path: `/${path}` });
  }

  get(path: string): FileDoc | null {
    return this.docs.get(path) ?? null;
  }

  isDirty(doc: FileDoc): boolean {
    return doc.model.getAlternativeVersionId() !== doc.savedVersion;
  }

  private track(doc: FileDoc): void {
    doc.model.onDidChangeContent(() => {
      useEditorStore.getState().setDirty(this.workspaceId, doc.path, this.isDirty(doc));
    });
  }

  open(path: string): Promise<OpenResult> {
    const existing = this.docs.get(path);
    if (existing) return Promise.resolve({ ok: true, doc: existing });
    const pending = this.loading.get(path);
    if (pending) return pending;
    const load = (async (): Promise<OpenResult> => {
      try {
        const file = await this.client.editorReadFile(this.workspaceId, path);
        if (file.binary) return { ok: false, reason: "binary", message: "This file is binary and cannot be edited here." };
        if (file.tooLarge || file.content === null) return { ok: false, reason: "too_large", message: "This file is too large to open in the editor (over 5 MB)." };
        const model = this.monaco.editor.createModel(file.content, languageForPath(path), this.uri(path));
        const doc: FileDoc = { path, model, updatedAt: file.updatedAt, savedVersion: model.getAlternativeVersionId(), conflict: false, missing: false };
        this.docs.set(path, doc);
        this.track(doc);
        return { ok: true, doc };
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 404) return { ok: false, reason: "missing", message: "This file no longer exists." };
        return { ok: false, reason: "error", message: error instanceof Error ? error.message : "Could not open this file." };
      } finally {
        this.loading.delete(path);
      }
    })();
    this.loading.set(path, load);
    return load;
  }

  /** A document for a file that does not exist on disk (an agent deletion under review): empty, saved state "missing". */
  openMissing(path: string): FileDoc {
    const existing = this.docs.get(path);
    if (existing) return existing;
    const model = this.monaco.editor.createModel("", languageForPath(path), this.uri(path));
    const doc: FileDoc = { path, model, updatedAt: null, savedVersion: model.getAlternativeVersionId(), conflict: false, missing: true };
    this.docs.set(path, doc);
    this.track(doc);
    return doc;
  }

  async save(path: string, options: SaveOptions): Promise<SaveResult> {
    const doc = this.docs.get(path);
    if (!doc) return { ok: false, conflict: false, message: "This file is not open." };
    const version = doc.model.getAlternativeVersionId();
    const content = doc.model.getValue(this.monaco.editor.EndOfLinePreference.TextDefined);
    try {
      const result = await this.client.editorWriteFile(this.workspaceId, {
        path,
        content,
        baseUpdatedAt: doc.updatedAt,
        ...(options.force ? { force: true } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId, source: options.source } : {}),
      });
      doc.updatedAt = result.updatedAt;
      doc.savedVersion = version;
      doc.conflict = false;
      doc.missing = false;
      useEditorStore.getState().setDirty(this.workspaceId, path, this.isDirty(doc));
      return { ok: true };
    } catch (error) {
      const status = (error as { status?: number }).status;
      return { ok: false, conflict: status === 409, message: error instanceof Error ? error.message : "Could not save this file." };
    }
  }

  async remove(path: string, options: SaveOptions): Promise<SaveResult> {
    try {
      await this.client.editorWriteFile(this.workspaceId, {
        path,
        delete: true,
        ...(options.sessionId ? { sessionId: options.sessionId, source: options.source } : {}),
      });
      const doc = this.docs.get(path);
      if (doc) {
        doc.updatedAt = null;
        doc.missing = true;
        doc.savedVersion = doc.model.getAlternativeVersionId();
        useEditorStore.getState().setDirty(this.workspaceId, path, false);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, conflict: false, message: error instanceof Error ? error.message : "Could not delete this file." };
    }
  }

  /**
   * Reads open files again (after a turn, on focus): a clean document takes
   * the disk text (one undo step), a dirty one is flagged as a conflict.
   */
  async refresh(paths?: string[], options: { discard?: boolean } = {}): Promise<void> {
    const targets = (paths ?? [...this.docs.keys()]).map((path) => this.docs.get(path)).filter((doc): doc is FileDoc => Boolean(doc));
    // Discarding: the document counts as clean, whatever was typed into it.
    const dirty = (doc: FileDoc) => !options.discard && this.isDirty(doc);
    await Promise.all(targets.map(async (doc) => {
      let file;
      try {
        file = await this.client.editorReadFile(this.workspaceId, doc.path);
      } catch (error) {
        // Deleted on disk: a clean document empties and says so; a dirty one keeps the user's text.
        if ((error as { status?: number }).status === 404 && (!doc.missing || options.discard)) {
          if (dirty(doc)) {
            doc.conflict = true;
            return;
          }
          if (doc.model.getValueLength() > 0) doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: "" }], () => null);
          doc.updatedAt = null;
          doc.missing = true;
          doc.conflict = false;
          doc.savedVersion = doc.model.getAlternativeVersionId();
          useEditorStore.getState().setDirty(this.workspaceId, doc.path, false);
        }
        return;
      }
      if (file.content === null) return;
      const current = doc.model.getValue(this.monaco.editor.EndOfLinePreference.TextDefined);
      doc.missing = false;
      if (current === file.content) {
        // Same text as on disk: the document is clean (also after a discard).
        doc.updatedAt = file.updatedAt;
        doc.conflict = false;
        doc.savedVersion = doc.model.getAlternativeVersionId();
        useEditorStore.getState().setDirty(this.workspaceId, doc.path, false);
        return;
      }
      if (!options.discard && file.updatedAt === doc.updatedAt) return;
      if (dirty(doc)) {
        doc.conflict = true;
        return;
      }
      doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: file.content }], () => null);
      doc.updatedAt = file.updatedAt;
      doc.conflict = false;
      doc.savedVersion = doc.model.getAlternativeVersionId();
      useEditorStore.getState().setDirty(this.workspaceId, doc.path, false);
    }));
  }

  /**
   * After an undo or redo: every open file read again. Returns the files with
   * unsaved changes that changed on disk (newly flagged as a conflict).
   */
  async refreshAfterRewind(): Promise<string[]> {
    const before = new Set([...this.docs.values()].filter((doc) => doc.conflict).map((doc) => doc.path));
    await this.refresh();
    return [...this.docs.values()].filter((doc) => doc.conflict && !before.has(doc.path)).map((doc) => doc.path);
  }

  /** Discards unsaved changes: the disk text again. */
  async revert(path: string): Promise<void> {
    const doc = this.docs.get(path);
    if (!doc) return;
    await this.refresh([path], { discard: true }).catch(() => undefined);
  }

  /** The read-only "before" model of a review or git diff. */
  baseline(key: string, path: string, text: string): MonacoApi.editor.ITextModel {
    const uri = this.uri(`${key}/${path}`, "omnirush-base");
    let model = this.baselines.get(uri.toString());
    if (!model || model.isDisposed()) {
      model = this.monaco.editor.createModel(text, languageForPath(path), uri);
      this.baselines.set(uri.toString(), model);
    } else if (model.getValue() !== text) {
      model.setValue(text);
    }
    return model;
  }

  /** Closes clean documents nobody shows (no tab, not under review), so a long session does not keep every file it touched. */
  evict(keep: ReadonlySet<string>): void {
    for (const [path, doc] of this.docs) {
      if (keep.has(path) || this.isDirty(doc) || doc.conflict) continue;
      doc.model.dispose();
      this.docs.delete(path);
    }
  }

  /** Review "before" models of reviews other than these keys. */
  disposeReviewModels(keepKeys: ReadonlySet<string>): void {
    for (const model of this.monaco.editor.getModels()) {
      const uri = model.uri;
      if (uri.scheme !== "omnirush-base" || !uri.path.startsWith("/review/")) continue;
      if (uri.authority !== this.uri("x").authority) continue;
      const key = uri.path.slice("/review/".length).split("/")[0] ?? "";
      if (!keepKeys.has(key) && !model.isAttachedToEditor()) model.dispose();
    }
  }

  dispose(): void {
    for (const doc of this.docs.values()) doc.model.dispose();
    for (const model of this.baselines.values()) model.dispose();
    this.docs.clear();
    this.baselines.clear();
  }
}

const byWorkspace = new Map<string, EditorDocuments>();

// An undo or redo changed files: documents no editor panel shows are read again here (a shown one's panel does it).
onFilesRewound(() => {
  for (const docs of byWorkspace.values()) if (docs.shown === 0) void docs.refresh().catch(() => undefined);
});

export function editorDocuments(monaco: Monaco, client: OmniRushServerClient, workspaceId: string): EditorDocuments {
  const existing = byWorkspace.get(workspaceId);
  if (existing) {
    // A new client object for the same server (a re-render, a token refresh) keeps the open documents.
    existing.client = client;
    return existing;
  }
  const created = new EditorDocuments(monaco, client, workspaceId);
  byWorkspace.set(workspaceId, created);
  return created;
}
