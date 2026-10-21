import { useEffect, useRef, useState } from "react";
import { AppWindow, MousePointer2 } from "lucide-react";

import type { ComputerUseAppRef, ComputerUseCursorMove } from "@omnirush/types/desktop-ipc";

import { scalePoints, type ComputerUsePoint } from "./describe";

/** The app the host verified: icon, name, executable or bundle id, process id. */
export function ComputerUseAppIdentity(props: { app: ComputerUseAppRef; compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className={`flex shrink-0 items-center justify-center rounded-lg border border-dls-border bg-dls-hover text-dls-secondary ${props.compact ? "size-5" : "size-8"}`}>
        <AppWindow size={props.compact ? 12 : 16} />
      </div>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold leading-5 text-dls-text">{props.app.app_name}</div>
        {props.compact ? null : (
          <div className="truncate font-mono text-[11px] leading-4 text-dls-secondary" title={props.app.bundle_or_exe}>
            {props.app.bundle_or_exe}{props.app.pid === null ? "" : ` · pid ${props.app.pid}`}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The agent's cursor over the frame: on each move it jumps to `from`, then glides to `to` (a CSS transition),
 * as a person's pointer would; otherwise it sits where the last frame shows it.
 */
function AgentCursor(props: { frame: { width: number; height: number }; at: ComputerUsePoint | null; move: ComputerUseCursorMove | undefined }) {
  const { move } = props;
  const [shown, setShown] = useState<{ point: ComputerUsePoint; glide: boolean } | null>(null);
  // Every status push is a new object: the move's sequence number says whether it is a new move.
  const latest = useRef(move);
  latest.current = move;
  const seq = move?.seq;
  useEffect(() => {
    const current = latest.current;
    if (seq === undefined || !current) return undefined;
    setShown(current.from ? { point: current.from, glide: false } : null);
    let next = requestAnimationFrame(() => { next = requestAnimationFrame(() => setShown({ point: current.to, glide: true })); });
    return () => cancelAnimationFrame(next);
  }, [seq]);
  const point = move ? shown?.point : props.at;
  if (!point) return null;
  const [mark] = scalePoints([point], move ?? props.frame, { width: 100, height: 100 });
  if (!mark) return null;
  return (
    <span
      aria-hidden="true"
      data-computer-use-cursor
      className={`pointer-events-none absolute ${shown?.glide && move ? "transition-[left,top] duration-200 ease-out" : ""}`}
      style={{ left: `${mark.x}%`, top: `${mark.y}%` }}
    >
      <MousePointer2 size={18} className="-translate-x-[2px] -translate-y-[2px] fill-violet-500 text-white drop-shadow" />
      <span className="absolute left-3.5 top-4 rounded bg-violet-500 px-1 text-[9px] font-bold leading-[14px] text-white">AGENT</span>
    </span>
  );
}

/** The latest frame, with the agent's cursor on the agent's own display. */
export function ComputerUseFrame(props: {
  frame: { width: number; height: number; data_url: string };
  cursor?: ComputerUsePoint | null;
  move?: ComputerUseCursorMove;
  alt: string;
  className?: string;
}) {
  const showCursor = props.cursor !== undefined || props.move !== undefined;
  return (
    <div className="relative inline-block max-w-full overflow-hidden rounded-lg border border-dls-border">
      <img src={props.frame.data_url} alt={props.alt} className={`block h-auto w-auto max-w-full ${props.className ?? "max-h-[260px]"}`} />
      {showCursor ? <AgentCursor frame={props.frame} at={props.cursor ?? null} move={props.move} /> : null}
    </div>
  );
}
