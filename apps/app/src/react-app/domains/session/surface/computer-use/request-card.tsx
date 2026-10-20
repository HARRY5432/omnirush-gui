import { useState } from "react";
import { AppWindow, Check, Clock3, MonitorSmartphone, XCircle } from "lucide-react";

import type { ComputerUseAnswer, ComputerUseAppRef, ComputerUseRequest } from "@omnirush/types/desktop-ipc";
import { Button } from "@/components/ui/button";
import { stripRemoteMethodErrorPrefix } from "@/react-app/domains/settings/state/electron-updater-state";

import { describeComputerUseAction, scalePoints, typedText, type ComputerUsePoint } from "./describe";
import { answerComputerUse } from "./status-store";

const APPROVE_WITH_OWN_INPUT = "Use your own mouse or keyboard to approve.";

/** The app the host verified: icon, name, executable or bundle id, process id. */
export function ComputerUseAppIdentity(props: { app: ComputerUseAppRef; icon: string | null; compact?: boolean }) {
  const icon = props.icon?.startsWith("data:image/") ? props.icon : null;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {icon ? (
        <img src={icon} alt="" className={props.compact ? "size-5 shrink-0" : "size-8 shrink-0"} />
      ) : (
        <div className={`flex shrink-0 items-center justify-center rounded-lg border border-dls-border bg-dls-hover text-dls-secondary ${props.compact ? "size-5" : "size-8"}`}>
          <AppWindow size={props.compact ? 12 : 16} />
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold leading-5 text-dls-text">{props.app.app_name}</div>
        {props.compact ? null : (
          <div className="truncate font-mono text-[11px] leading-4 text-dls-secondary" title={props.app.bundle_or_exe}>
            {props.app.bundle_or_exe} · pid {props.app.pid}
          </div>
        )}
      </div>
    </div>
  );
}

/** A frame with a red marker at each point (a line through them for a drag). */
export function ComputerUseFrame(props: {
  frame: { width: number; height: number; data_url: string };
  points?: ComputerUsePoint[];
  alt: string;
  className?: string;
}) {
  // Percentages of the shown image, so the markers follow any displayed size.
  const marks = scalePoints(props.points ?? [], props.frame, { width: 100, height: 100 });
  return (
    <div className="relative inline-block max-w-full overflow-hidden rounded-lg border border-dls-border">
      <img src={props.frame.data_url} alt={props.alt} className={`block h-auto w-auto max-w-full ${props.className ?? "max-h-[260px]"}`} />
      {marks.length > 1 ? (
        <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline
            points={marks.map((mark) => `${mark.x},${mark.y}`).join(" ")}
            fill="none"
            stroke="rgb(239 68 68)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}
      {marks.map((mark, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-red-500 bg-red-500/20 shadow-[0_0_0_2px_rgba(255,255,255,0.8)]"
          style={{ left: `${mark.x}%`, top: `${mark.y}%` }}
        >
          <span className="absolute left-1/2 top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500" />
        </span>
      ))}
    </div>
  );
}

function AgentSays(props: { text: string }) {
  if (!props.text.trim()) return null;
  return (
    <blockquote className="border-l-2 border-dls-border pl-3 text-[12px] leading-5 text-dls-text">
      <span className="text-dls-secondary">The agent says: </span>
      {props.text}
    </blockquote>
  );
}

/** An approval only the person answers: open a window, or one action in it. */
export function ComputerUseRequestCard(props: { request: ComputerUseRequest }) {
  const request = props.request;
  const [windowId, setWindowId] = useState(request.kind === "open" ? request.window_id : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = (decision: ComputerUseAnswer["decision"]) => {
    setBusy(true);
    setError(null);
    answerComputerUse({ request_id: request.request_id, decision, ...(request.kind === "open" ? { window_id: windowId } : {}) })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? stripRemoteMethodErrorPrefix(reason.message) : "";
        setError(message || APPROVE_WITH_OWN_INPUT);
      })
      .finally(() => setBusy(false));
  };

  const errorLine = error ? (
    <p role="alert" className="text-[12px] font-medium leading-5 text-red-11">{error}</p>
  ) : null;

  if (request.kind === "open") {
    return (
      <div data-computer-use-request={request.request_id} className="flex flex-col gap-3 border-b border-dls-border px-4 py-3">
        <div className="flex items-center gap-2 text-[13px] font-medium leading-5 text-dls-text">
          <MonitorSmartphone size={16} className="text-dls-secondary" />
          Let the agent use this app?
        </div>
        <ComputerUseAppIdentity app={request.app} icon={request.icon} />
        <div className="grid gap-2 text-[12px] leading-5 text-dls-text sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-dls-secondary">Window</span>
            {request.windows.length > 1 ? (
              <select
                aria-label="Window to allow"
                className="w-full rounded-lg border border-dls-border bg-transparent px-2 py-1.5 text-[12px]"
                value={windowId}
                onChange={(event) => setWindowId(event.target.value)}
              >
                {request.windows.map((item) => (
                  <option key={item.id} value={item.id}>{item.title || "Untitled window"}</option>
                ))}
              </select>
            ) : (
              <span className="truncate">{request.windows.find((item) => item.id === request.window_id)?.title || "Untitled window"}</span>
            )}
          </label>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-dls-secondary">Access</span>
            <span>{request.mode === "observe" ? "See the window" : "Use mouse and keyboard"}</span>
          </div>
        </div>
        <AgentSays text={request.purpose} />
        <p className="text-[12px] leading-5 text-dls-secondary">
          Screenshots of this window and every action are recorded with the chat and sent to the model provider. Don't approve windows with other people's personal or regulated data.
        </p>
        {errorLine}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => answer("chat")} data-computer-use-answer="chat" className="h-auto py-1.5">
            <Check data-icon="inline-start" />
            <span className="flex flex-col items-start leading-4">
              <span>Allow for this chat</span>
              <span className="text-[10px] font-normal opacity-80">Same app, up to {Math.round(request.chat_seconds / 60)} minutes</span>
            </span>
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => answer("once")} data-computer-use-answer="once">
            <Clock3 data-icon="inline-start" />
            Allow once
          </Button>
          <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => answer("deny")} data-computer-use-answer="deny">
            <XCircle data-icon="inline-start" />
            Deny
          </Button>
        </div>
      </div>
    );
  }

  const text = typedText(request.action);
  return (
    <div data-computer-use-request={request.request_id} className="flex flex-col gap-3 border-b border-dls-border px-4 py-3">
      <div className="text-[13px] font-medium leading-5 text-dls-text">Allow this action?</div>
      <div className="flex min-w-0 items-center gap-2">
        <ComputerUseAppIdentity app={request.app} icon={request.icon} compact />
        {request.window_title ? <span className="truncate text-[12px] text-dls-secondary">{request.window_title}</span> : null}
      </div>
      {text === null ? (
        <div className="text-[13px] font-medium leading-5 text-dls-text">{describeComputerUseAction(request.action)}</div>
      ) : (
        <div className="flex flex-col gap-1 text-[13px] font-medium leading-5 text-dls-text">
          Type
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dls-border bg-dls-hover/55 px-2.5 py-1.5 font-mono text-[12px] font-normal">{text}</pre>
        </div>
      )}
      <AgentSays text={request.intent} />
      {request.reasons.length ? (
        <ul className="list-disc pl-5 text-[12px] leading-5 text-dls-secondary">
          {request.reasons.map((reason, index) => <li key={`${reason.code}-${index}`}>{reason.text}</li>)}
        </ul>
      ) : null}
      <ComputerUseFrame frame={request.frame} points={request.points} alt={`${request.app.app_name} window`} />
      {errorLine}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => answer("allow")} data-computer-use-answer="allow">
          <Check data-icon="inline-start" />
          Allow
        </Button>
        <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => answer("deny")} data-computer-use-answer="deny">
          <XCircle data-icon="inline-start" />
          Deny
        </Button>
      </div>
    </div>
  );
}
