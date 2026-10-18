/** @jsxImportSource react */
// Sponsored placements (app/lib/placements.ts): a slim, quiet card on the
// home / new-chat screen and one dim line after a finished turn, once per
// session. Always labelled "Sponsored · <sponsor>"; plain text, the app's own
// colours, no motion, no sound, no toast. The link opens in the system
// browser only on a click; × hides it for the placement's snooze days.
// Nothing renders while the main process has no placement to show.

import { useEffect, useRef } from "react";
import { ArrowUpRight, X } from "lucide-react";

import {
  dismissPlacement,
  endTurnFooter,
  loadHomePlacement,
  loadTurnFooter,
  openPlacement,
  placementShown,
  turnJustFinished,
  usePlacementsStore,
  type Placement,
} from "../../../app/lib/placements";

function DismissButton(props: { placement: Placement; testId: string }) {
  return (
    <button
      type="button"
      aria-label="Hide this sponsored message"
      title={`Hide for ${props.placement.snoozeDays} day${props.placement.snoozeDays === 1 ? "" : "s"}`}
      onClick={() => dismissPlacement(props.placement)}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground"
      data-testid={props.testId}
    >
      <X className="size-3" aria-hidden="true" />
    </button>
  );
}

/** The home / new-chat card: under the composer and the suggestions. */
export function PlacementHomeCard() {
  const placement = usePlacementsStore((state) => state.home);
  useEffect(() => {
    void loadHomePlacement();
  }, []);
  useEffect(() => {
    if (placement) placementShown(placement, "home");
  }, [placement]);
  if (!placement) return null;
  return <PlacementHomeCardView placement={placement} />;
}

/** The card itself (tests render it directly). */
export function PlacementHomeCardView({ placement }: { placement: Placement }) {
  return (
    <aside
      aria-label={placement.label}
      data-testid="placement-home"
      data-placement-id={placement.id}
      className="flex items-center gap-3 rounded-lg border border-border/70 bg-background px-3 py-2"
    >
      {placement.imageUrl ? (
        <img
          src={placement.imageUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          referrerPolicy="no-referrer"
          className="size-8 shrink-0 rounded-md object-cover"
          data-testid="placement-home-image"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] leading-4 text-muted-foreground" data-testid="placement-home-label">{placement.label}</div>
        <div className="truncate text-[12.5px] font-medium leading-5 text-foreground" data-testid="placement-home-title">{placement.title}</div>
        {placement.body ? (
          <div className="line-clamp-2 text-[12px] leading-4 text-muted-foreground" data-testid="placement-home-body">{placement.body}</div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => openPlacement(placement)}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/80 px-2.5 text-[12px] font-medium text-foreground hover:bg-accent"
        data-testid="placement-home-cta"
      >
        {placement.ctaLabel}
        <ArrowUpRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </button>
      <DismissButton placement={placement} testId="placement-home-dismiss" />
    </aside>
  );
}

/**
 * The line after a finished turn, above the composer: asked on the running →
 * done edge of this session's turn, gone when the next turn starts, once per
 * session (the main process remembers it across runs too).
 */
export function PlacementTurnFooter(props: { sessionId: string; turnRunning: boolean }) {
  const placement = usePlacementsStore((state) => state.footers[props.sessionId] ?? null);
  const previous = useRef({ sessionId: props.sessionId, running: props.turnRunning });
  useEffect(() => {
    const before = previous.current;
    const now = { sessionId: props.sessionId, running: props.turnRunning };
    previous.current = now;
    if (props.turnRunning) {
      endTurnFooter(props.sessionId);
      return;
    }
    if (turnJustFinished(before, now)) void loadTurnFooter(props.sessionId);
  }, [props.sessionId, props.turnRunning]);
  const visible = Boolean(placement) && !props.turnRunning;
  useEffect(() => {
    if (visible && placement) placementShown(placement, `turn:${props.sessionId}`);
  }, [placement, props.sessionId, visible]);
  if (!visible || !placement) return null;
  return <PlacementTurnFooterView placement={placement} />;
}

/** The line itself (tests render it directly). */
export function PlacementTurnFooterView({ placement }: { placement: Placement }) {
  return (
    <div className="px-4 max-lg:px-3 lg:px-8">
      <div
        role="note"
        aria-label={placement.label}
        data-testid="placement-turn-footer"
        data-placement-id={placement.id}
        className="mx-auto flex max-w-[800px] items-center gap-2 pb-1 text-[11px] leading-4 text-muted-foreground/80"
      >
        <span className="min-w-0 flex-1 truncate">
          <span>{placement.label}</span>
          <span aria-hidden="true"> — </span>
          <span className="text-muted-foreground">{placement.title}</span>
          {placement.body ? <span> · {placement.body}</span> : null}
        </span>
        <button
          type="button"
          onClick={() => openPlacement(placement)}
          className="inline-flex shrink-0 items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline"
          data-testid="placement-turn-footer-cta"
        >
          {placement.ctaLabel}
          <ArrowUpRight className="size-3" aria-hidden="true" />
        </button>
        <DismissButton placement={placement} testId="placement-turn-footer-dismiss" />
      </div>
    </div>
  );
}
