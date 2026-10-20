/**
 * The git gutter: marks next to lines added (solid bar), changed (striped bar) or removed (wedge) since HEAD, for
 * the text in the editor including unsaved changes. Read-only in this batch. Nothing for files git does not track,
 * binary or very large files, or folders that are not repositories. The diff runs in a worker, started on first use.
 */
import type * as MonacoApi from "monaco-editor/editor/editor.api.js";

import type { OmniRushServerClient } from "@/app/lib/omnirush-server";
import { gutterLabel, type GutterMark } from "./line-diff";

const MAX_CHARS = 2_000_000;
const DEBOUNCE_MS = 300;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (marks: GutterMark[] | null) => void>();

function diffInWorker(head: string, current: string): Promise<GutterMark[] | null> {
  if (!worker) {
    worker = new Worker(new URL("./line-diff.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: number; marks: GutterMark[] | null }>) => {
      pending.get(event.data.id)?.(event.data.marks);
      pending.delete(event.data.id);
    };
  }
  const id = (nextId += 1);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker!.postMessage({ id, head, current });
  });
}

/** HEAD text per workspace file; dropped when git's state changes (a commit, checkout, stage). */
export class GitGutter {
  private heads = new Map<string, Promise<string | null>>();

  constructor(private client: OmniRushServerClient, private workspaceId: string) {}

  /** Git's state changed: HEAD texts are read again. */
  reset() {
    this.heads.clear();
  }

  private head(path: string): Promise<string | null> {
    let head = this.heads.get(path);
    if (!head) {
      head = this.client.editorGitOriginal(this.workspaceId, path, "HEAD").then(
        (file) => (file.exists && !file.binary && !file.tooLarge && typeof file.content === "string" ? file.content : null),
        () => null,
      );
      this.heads.set(path, head);
    }
    return head;
  }

  /** Marks for `model` (the file `path`) in `editor`, kept up to date while it is shown. */
  attach(editor: MonacoApi.editor.ICodeEditor, model: MonacoApi.editor.ITextModel, path: string, changedInGit: boolean, isDirty: () => boolean): () => void {
    const decorations = editor.createDecorationsCollection();
    let timer = 0;
    let disposed = false;
    let generation = 0;
    const update = async () => {
      const mine = (generation += 1);
      // Not changed in git and not edited here: nothing to mark, nothing to fetch.
      if (!changedInGit && !isDirty()) {
        decorations.clear();
        return;
      }
      const head = await this.head(path);
      const current = model.getValue();
      if (disposed || mine !== generation) return;
      if (head === null || head.length > MAX_CHARS || current.length > MAX_CHARS) {
        decorations.clear();
        return;
      }
      const marks = await diffInWorker(head, current);
      if (disposed || mine !== generation || model.isDisposed()) return;
      decorations.set((marks ?? []).map((mark) => ({
        range: { startLineNumber: Math.max(1, mark.startLine), startColumn: 1, endLineNumber: Math.max(1, mark.endLine), endColumn: 1 },
        options: {
          isWholeLine: true,
          linesDecorationsClassName: mark.kind === "add" ? "omnirush-gutter-add" : mark.kind === "change" ? "omnirush-gutter-change" : mark.startLine === 0 ? "omnirush-gutter-delete-top" : "omnirush-gutter-delete",
          linesDecorationsTooltip: gutterLabel(mark),
        },
      })));
    };
    void update();
    const subscription = model.onDidChangeContent(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void update(), DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      subscription.dispose();
      decorations.clear();
    };
  }
}
