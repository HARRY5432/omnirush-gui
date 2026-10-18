// Sponsored placements, renderer side. The Electron main process decides
// (apps/desktop/electron/placements-desktop.mjs and the shared
// placements/placements.mjs): it answers a placement to draw or null (none,
// switched off, offline, any error), counts it, and opens its link after a
// click. Here: one home placement per app run, the turn line once per
// session, and the dismissals of this run. Nothing here is awaited on the way
// to the first screen, and nothing here touches a session's messages.

import { create } from "zustand";

import type { OmniRushPlacement, OmniRushPlacementAction, OmniRushPlacementSlot } from "@omnirush/types/desktop-ipc";

import { omnirushPlacement, omnirushPlacementAction } from "./desktop";

export type Placement = OmniRushPlacement;

const SLOTS: readonly OmniRushPlacementSlot[] = ["home_banner", "turn_footer"];

/** Copy limits (the shared module clamps them already; checked again here). */
export const PLACEMENT_LIMITS = { sponsor: 40, title: 60, body: 140, ctaLabel: 20 } as const;

function shortText(value: unknown, max: number): value is string {
  return typeof value === "string" && Array.from(value).length <= max;
}

function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** What the main process sent, if it is a placement this window may draw. */
export function asPlacement(value: unknown): Placement | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== "string" || !p.id || !SLOTS.includes(p.slot as OmniRushPlacementSlot)) return null;
  if (!shortText(p.sponsor, PLACEMENT_LIMITS.sponsor) || !p.sponsor) return null;
  if (!shortText(p.title, PLACEMENT_LIMITS.title) || !p.title) return null;
  if (!shortText(p.body, PLACEMENT_LIMITS.body) || !shortText(p.ctaLabel, PLACEMENT_LIMITS.ctaLabel) || !p.ctaLabel) return null;
  if (!httpsUrl(p.url)) return null;
  if (p.imageUrl !== null && !httpsUrl(p.imageUrl)) return null;
  return {
    id: p.id,
    slot: p.slot as OmniRushPlacementSlot,
    label: `Sponsored · ${p.sponsor}`,
    sponsor: p.sponsor,
    title: p.title,
    body: p.body,
    ctaLabel: p.ctaLabel,
    url: p.url,
    imageUrl: (p.imageUrl as string | null) ?? null,
    snoozeDays: typeof p.snoozeDays === "number" ? p.snoozeDays : 7,
  };
}

type PlacementsState = {
  /** undefined: not asked yet this run; null: nothing to show. */
  home: Placement | null | undefined;
  /** The turn line per session (null: asked, nothing; or it went away). */
  footers: Record<string, Placement | null>;
  setHome: (home: Placement | null) => void;
  setFooter: (sessionId: string, placement: Placement | null) => void;
  hide: (id: string) => void;
};

export const usePlacementsStore = create<PlacementsState>((set) => ({
  home: undefined,
  footers: {},
  setHome: (home) => set({ home }),
  setFooter: (sessionId, placement) => set((state) => ({ footers: { ...state.footers, [sessionId]: placement } })),
  hide: (id) => set((state) => ({
    home: state.home?.id === id ? null : state.home,
    footers: Object.fromEntries(Object.entries(state.footers).map(([sid, p]) => [sid, p?.id === id ? null : p])),
  })),
}));

type Bridge = {
  placement: (input: { slot: OmniRushPlacementSlot; sessionId?: string }) => Promise<unknown>;
  action: (input: { id: string; action: OmniRushPlacementAction }) => Promise<unknown>;
};

let bridge: Bridge = {
  placement: (input) => omnirushPlacement(input),
  action: (input) => omnirushPlacementAction(input),
};

/** Tests: a stand-in for the main process, and a fresh run. */
export function setPlacementsBridgeForTests(next: Bridge | null): void {
  if (next) bridge = next;
  homeAsk = null;
  impressions.clear();
  usePlacementsStore.setState({ home: undefined, footers: {} });
}

let homeAsk: Promise<Placement | null> | null = null;

/** The home placement of this run (asked once; the main process keeps the same one for the run). */
export function loadHomePlacement(): Promise<Placement | null> {
  if (homeAsk) return homeAsk;
  homeAsk = Promise.resolve()
    .then(() => bridge.placement({ slot: "home_banner" }))
    .then(asPlacement)
    .catch(() => null)
    .then((placement) => {
      usePlacementsStore.getState().setHome(placement);
      return placement;
    });
  return homeAsk;
}

/** The turn line for a session whose turn just finished (asked once per session in this run). */
export async function loadTurnFooter(sessionId: string): Promise<Placement | null> {
  if (!sessionId || sessionId in usePlacementsStore.getState().footers) return null;
  usePlacementsStore.getState().setFooter(sessionId, null);
  const placement = await Promise.resolve()
    .then(() => bridge.placement({ slot: "turn_footer", sessionId }))
    .then(asPlacement)
    .catch(() => null);
  if (placement) usePlacementsStore.getState().setFooter(sessionId, placement);
  return placement;
}

/** The next turn started: the line goes and does not come back for this session. */
export function endTurnFooter(sessionId: string): void {
  const footers = usePlacementsStore.getState().footers;
  if (footers[sessionId]) usePlacementsStore.getState().setFooter(sessionId, null);
}

const impressions = new Set<string>();

/** Drawn: one impression per placement and place (home, or a session's turn line). */
export function placementShown(placement: Placement, where: string): void {
  const key = `${where}:${placement.id}`;
  if (impressions.has(key)) return;
  impressions.add(key);
  void bridge.action({ id: placement.id, action: "impression" }).catch(() => undefined);
}

/** The click: the main process opens the link in the system browser. */
export function openPlacement(placement: Placement): void {
  void bridge.action({ id: placement.id, action: "open" }).catch(() => undefined);
}

/** ×: hidden for its snooze days. */
export function dismissPlacement(placement: Placement): void {
  usePlacementsStore.getState().hide(placement.id);
  void bridge.action({ id: placement.id, action: "dismiss" }).catch(() => undefined);
}

/** Whether a turn just finished: this session was running and is not any more. */
export function turnJustFinished(previous: { sessionId: string; running: boolean }, current: { sessionId: string; running: boolean }): boolean {
  return previous.sessionId === current.sessionId && previous.running && !current.running;
}
