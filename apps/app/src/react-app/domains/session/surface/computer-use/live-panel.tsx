import { useState } from "react";
import { ChevronDown, ChevronRight, Hand, Play, Square } from "lucide-react";

import type { ComputerUseControlAction, ComputerUseSessionState } from "@omnirush/types/desktop-ipc";
import { Button } from "@/components/ui/button";
import { stripRemoteMethodErrorPrefix } from "@/react-app/domains/settings/state/electron-updater-state";

import { formatMinutesLeft } from "./describe";
import { ComputerUseAppIdentity, ComputerUseFrame } from "./request-card";
import { buttonRect, controlComputerUse } from "./status-store";

/** A running (or paused) computer use session: what it sees, what it did, and Stop. */
export function ComputerUseLivePanel(props: { session: ComputerUseSessionState }) {
  const session = props.session;
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = session.phase === "paused";

  const control = (action: ComputerUseControlAction, event?: { currentTarget: EventTarget | null }) => {
    setBusy(true);
    setError(null);
    controlComputerUse(session.id, action, buttonRect(event?.currentTarget ?? null))
      .catch((reason: unknown) => setError(reason instanceof Error ? stripRemoteMethodErrorPrefix(reason.message) : "That did not work. Try again."))
      .finally(() => setBusy(false));
  };

  const buttons = (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {paused && session.can_continue ? (
        <Button type="button" variant="outline" size="xs" disabled={busy} onClick={(event) => control("continue", event)} data-computer-use-control="continue">
          <Play data-icon="inline-start" />
          Continue
        </Button>
      ) : null}
      {!paused && session.mode === "control" ? (
        <Button type="button" variant="outline" size="xs" disabled={busy} onClick={(event) => control("takeover", event)} data-computer-use-control="takeover">
          <Hand data-icon="inline-start" />
          Take over
        </Button>
      ) : null}
      <Button type="button" variant="destructive" size="xs" disabled={busy} onClick={(event) => control("stop", event)} data-computer-use-control="stop">
        <Square data-icon="inline-start" />
        Stop
      </Button>
    </div>
  );

  return (
    <div data-computer-use-session={session.id} className="flex flex-col gap-2 border-b border-dls-border px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="flex size-5 shrink-0 items-center justify-center rounded text-dls-secondary hover:text-dls-text"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={open ? "Collapse computer use" : "Expand computer use"}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <ComputerUseAppIdentity app={session.app} icon={null} compact />
        <span className="min-w-0 flex-1 truncate text-[12px] text-dls-secondary" title={session.window.title}>{session.window.title}</span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${paused ? "bg-amber-3 text-amber-11" : "bg-green-3 text-green-11"}`}
        >
          {paused ? "Paused" : "Working"}
        </span>
        {open ? null : buttons}
      </div>
      {open ? (
        <>
          <div className="flex flex-wrap gap-x-3 text-[11px] leading-4 text-dls-secondary">
            <span>{session.mode === "observe" ? "Sees the window" : "Uses mouse and keyboard"}</span>
            <span>{session.actions_left} {session.actions_left === 1 ? "action" : "actions"} left</span>
            <span>{formatMinutesLeft(session.seconds_left)} left</span>
          </div>
          {session.status ? <p role="status" className="text-[12px] leading-5 text-dls-text">{session.status}</p> : null}
          {session.frame ? (
            <ComputerUseFrame frame={session.frame} alt={`${session.app.app_name} window`} className="max-h-[220px]" />
          ) : null}
          {session.log.length ? (
            <ol className="flex flex-col gap-0.5 text-[12px] leading-5">
              {session.log.slice(-8).map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="flex min-w-0 items-baseline gap-2">
                  {entry.ok ? null : (
                    <span className="shrink-0 rounded bg-red-3 px-1 font-mono text-[10px] text-red-11">{entry.code ?? "failed"}</span>
                  )}
                  <span className="shrink-0 text-dls-text">{entry.action}</span>
                  {entry.intent ? <span className="truncate text-dls-secondary">{entry.intent}</span> : null}
                </li>
              ))}
            </ol>
          ) : null}
          {buttons}
        </>
      ) : null}
      {error ? <p role="alert" className="text-[12px] font-medium leading-5 text-red-11">{error}</p> : null}
    </div>
  );
}
