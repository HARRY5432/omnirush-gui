/** @jsxImportSource react */
/**
 * A Markdown file rendered in an editor tab, read-only, following the file's text as you type (300 ms; files over
 * 1 MB update when saved). The chat's renderer (sanitised: no raw HTML, no scripts). Links: a relative link opens
 * the file in the editor, `#anchor` scrolls, http(s) opens in the browser, anything else does nothing. Images: a
 * relative one loads from the project; a remote one is not loaded (a placeholder with its address).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type * as MonacoApi from "monaco-editor/editor/editor.api.js";

import type { OmniRushServerClient } from "@/app/lib/omnirush-server";
import { renderMarkdownHtml } from "@/components/markdown/markdown";
import { isImagePath } from "./image-view";

const LARGE = 1_000_000;
const MAX_IMAGES = 30;

/** `target` relative to the folder of `from` (both project paths), or null when it leaves the project. */
export function resolveProjectPath(from: string, target: string): string | null {
  const clean = target.split(/[?#]/)[0]!;
  if (!clean) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return null;
  }
  const parts = decoded.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

export function MarkdownPreview(props: {
  client: OmniRushServerClient;
  workspaceId: string;
  path: string;
  model: MonacoApi.editor.ITextModel;
  isDirty: () => boolean;
  onOpenFile: (path: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  const [text, setText] = useState(() => props.model.getValue());
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setText(props.model.getValue());
    let timer = 0;
    const subscription = props.model.onDidChangeContent(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (props.model.getValueLength() > LARGE && props.isDirty()) return;
        setText(props.model.getValue());
      }, 300);
    });
    return () => {
      window.clearTimeout(timer);
      subscription.dispose();
    };
  }, [props.model, props.isDirty]);

  const html = useMemo(() => ({ __html: renderMarkdownHtml(text, "surface") }), [text]);

  // Images: relative ones from the project (blob URLs, released with the render); remote ones not loaded.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const urls: string[] = [];
    let cancelled = false;
    let loaded = 0;
    for (const image of Array.from(root.querySelectorAll("img"))) {
      const src = image.getAttribute("src") ?? "";
      image.removeAttribute("srcset");
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("blob:")) {
        const note = document.createElement("span");
        note.className = "my-2 inline-block rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground";
        note.textContent = `Remote image not loaded: ${src}`;
        note.dataset.editorRemoteImage = src;
        (image.closest("button") ?? image).replaceWith(note);
        continue;
      }
      const target = resolveProjectPath(props.path, src);
      image.removeAttribute("src");
      if (!target || !isImagePath(target) || loaded >= MAX_IMAGES) continue;
      loaded += 1;
      props.client.editorRaw(props.workspaceId, target).then(
        (result) => {
          if (cancelled) return;
          const url = URL.createObjectURL(new Blob([result.data], { type: result.contentType ?? "application/octet-stream" }));
          urls.push(url);
          image.src = url;
        },
        () => undefined,
      );
    }
    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [html, props.client, props.path, props.workspaceId]);

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) {
      // The chat renderer wraps images in an "expand" button: nothing to expand here.
      if ((event.target as HTMLElement).closest("button[data-omnirush-image-preview]")) event.preventDefault();
      return;
    }
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    const inline = anchor.getAttribute("data-omnirush-inline-code-path");
    if (href.startsWith("#") && href.length > 1) {
      const id = decodeURIComponent(href.slice(1));
      const heading = rootRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)
        ?? Array.from(rootRef.current?.querySelectorAll("h1,h2,h3,h4,h5,h6") ?? []).find((element) => slug(element.textContent ?? "") === id);
      heading?.scrollIntoView({ block: "start" });
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      props.onOpenExternal(href);
      return;
    }
    const target = resolveProjectPath(props.path, inline ?? href);
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(inline ?? href)) props.onOpenFile(target);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-editor-preview={props.path}>
      <div
        ref={rootRef}
        className="markdown-content mx-auto max-w-3xl select-text px-6 py-5 text-foreground"
        onClick={onClick}
        dangerouslySetInnerHTML={html}
      />
    </div>
  );
}

/** GitHub-style heading anchor. */
function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
}
