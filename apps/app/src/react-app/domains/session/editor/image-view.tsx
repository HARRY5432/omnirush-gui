/** @jsxImportSource react */
/**
 * An image file in an editor tab: shown with <img> from a blob (an SVG is never inlined, framed or embedded, so it
 * runs no script and loads nothing), on a checkerboard from the theme, with Fit / 100% / zoom buttons. One decoded
 * image per tab, released when the tab is hidden or closed. Too-large files are refused before decoding.
 */
import { useEffect, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";

import type { OmniRushServerClient } from "@/app/lib/omnirush-server";
import { Button } from "@/components/ui/button";

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg"]);
const MAX_PIXELS = 50_000_000;

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ImageView(props: { client: OmniRushServerClient; workspaceId: string; path: string }) {
  const [state, setState] = useState<{ url: string; bytes: number; type: string } | { error: string } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const name = props.path.split("/").pop() ?? props.path;

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setState(null);
    setSize(null);
    setZoom("fit");
    props.client.editorRaw(props.workspaceId, props.path).then(
      (result) => {
        if (cancelled) return;
        const type = result.contentType ?? "application/octet-stream";
        url = URL.createObjectURL(new Blob([result.data], { type }));
        setState({ url, bytes: result.data.byteLength, type });
      },
      (error: { status?: number; message?: string }) => {
        if (!cancelled) setState({ error: error.status === 413 ? "Too large to preview (over 20 MB)." : error.message || "This image cannot be shown." });
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [props.client, props.path, props.workspaceId]);

  const scale = zoom === "fit" ? null : zoom;
  const step = (factor: number) => setZoom((value) => Math.min(8, Math.max(0.1, (value === "fit" ? 1 : value) * factor)));

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-editor-image={props.path}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {size ? `${size.width} × ${size.height}` : ""}{state && "bytes" in state ? ` · ${state.type.replace("image/", "").replace("+xml", "").toUpperCase()} · ${formatBytes(state.bytes)}` : ""}
        </span>
        <span className="flex-1" />
        <Button variant="ghost" size="icon-xs" aria-label="Zoom out" title="Zoom out" onClick={() => step(1 / 1.25)}><Minus /></Button>
        <span className="w-12 text-center tabular-nums" aria-live="polite">{scale === null ? "Fit" : `${Math.round(scale * 100)}%`}</span>
        <Button variant="ghost" size="icon-xs" aria-label="Zoom in" title="Zoom in" onClick={() => step(1.25)}><Plus /></Button>
        <Button variant="ghost" size="xs" onClick={() => setZoom(zoom === "fit" ? 1 : "fit")} aria-label={zoom === "fit" ? "Actual size" : "Fit to window"}>
          <Maximize2 /> {zoom === "fit" ? "100%" : "Fit"}
        </Button>
      </div>
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
        style={{
          backgroundColor: "var(--background)",
          backgroundImage: "linear-gradient(45deg, var(--muted) 25%, transparent 25%), linear-gradient(-45deg, var(--muted) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--muted) 75%), linear-gradient(-45deg, transparent 75%, var(--muted) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
        }}
      >
        {state === null ? <p className="text-sm text-muted-foreground">Loading…</p>
          : "error" in state ? <p className="rounded-md bg-background/90 px-3 py-2 text-sm text-muted-foreground">{state.error}</p>
            : size && size.width * size.height > MAX_PIXELS ? <p className="rounded-md bg-background/90 px-3 py-2 text-sm text-muted-foreground">Too large to preview ({size.width} × {size.height}).</p>
              : (
                <img
                  src={state.url}
                  alt={name}
                  draggable={false}
                  onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                  className="block"
                  style={scale === null ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" } : { width: size ? size.width * scale : undefined, maxWidth: "none" }}
                />
              )}
      </div>
    </div>
  );
}
