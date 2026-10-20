/** @jsxImportSource react */
import { lazy, Suspense } from "react";

import type { EditorPanelProps } from "./editor-panel";

/** Monaco and the editor load the first time the editor opens, never with the chat. */
const EditorPanel = lazy(() => import("./editor-panel"));

export function LazyEditorPanel(props: EditorPanelProps) {
  return (
    <Suspense
      fallback={(
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground" data-editor-loading>
          Loading editor…
        </div>
      )}
    >
      <EditorPanel {...props} />
    </Suspense>
  );
}
