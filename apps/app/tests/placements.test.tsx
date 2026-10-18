import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  asPlacement,
  dismissPlacement,
  endTurnFooter,
  loadHomePlacement,
  loadTurnFooter,
  openPlacement,
  placementShown,
  setPlacementsBridgeForTests,
  turnJustFinished,
  usePlacementsStore,
} from "../src/app/lib/placements";
import { PlacementHomeCard, PlacementHomeCardView, PlacementTurnFooter, PlacementTurnFooterView } from "../src/react-app/domains/placements/placements";

const PLACEMENT = {
  id: "plc_abc",
  slot: "home_banner",
  label: "Sponsored · Acme",
  sponsor: "Acme",
  title: "Fast CI for your repo",
  body: "Run your tests in half the time.",
  ctaLabel: "Try it",
  url: "https://acme.example/ci",
  imageUrl: null,
  snoozeDays: 7,
};

function fakeMain(answer: unknown = PLACEMENT) {
  const asks: unknown[] = [];
  const actions: { id: string; action: string }[] = [];
  setPlacementsBridgeForTests({
    placement: async (input) => {
      asks.push(input);
      return typeof answer === "function" ? (answer as (i: unknown) => unknown)(input) : answer;
    },
    action: async (input) => {
      actions.push(input);
      return { ok: true };
    },
  });
  return { asks, actions };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => setPlacementsBridgeForTests(null));

describe("placements: what the window accepts", () => {
  test("a placement from the main process", () => {
    expect(asPlacement(PLACEMENT)?.label).toBe("Sponsored · Acme");
  });

  test("the label is always Sponsored · sponsor", () => {
    expect(asPlacement({ ...PLACEMENT, label: "Recommended" })?.label).toBe("Sponsored · Acme");
  });

  test("anything else is nothing", () => {
    for (const bad of [
      null,
      "x",
      { ...PLACEMENT, url: "http://acme.example" },
      { ...PLACEMENT, url: "javascript:alert(1)" },
      { ...PLACEMENT, imageUrl: "http://acme.example/a.png" },
      { ...PLACEMENT, slot: "modal" },
      { ...PLACEMENT, title: "" },
      { ...PLACEMENT, title: "T".repeat(61) },
      { ...PLACEMENT, body: "B".repeat(141) },
      { ...PLACEMENT, ctaLabel: "C".repeat(21) },
      { ...PLACEMENT, sponsor: "" },
    ]) {
      expect(asPlacement(bad)).toBeNull();
    }
  });
});

describe("placements: the home card", () => {
  test("nothing before an answer, and nothing for a null answer", async () => {
    fakeMain(null);
    expect(renderToStaticMarkup(<PlacementHomeCard />)).toBe("");
    await loadHomePlacement();
    expect(usePlacementsStore.getState().home).toBeNull();
    expect(renderToStaticMarkup(<PlacementHomeCard />)).toBe("");
  });

  test("a failing main process is nothing too", async () => {
    setPlacementsBridgeForTests({ placement: async () => { throw new Error("no handler"); }, action: async () => ({ ok: false }) });
    expect(await loadHomePlacement()).toBeNull();
    expect(renderToStaticMarkup(<PlacementHomeCard />)).toBe("");
  });

  test("labelled, title, body, CTA and ×; plain text, no motion", async () => {
    const { asks } = fakeMain();
    await loadHomePlacement();
    await loadHomePlacement();
    expect(asks).toEqual([{ slot: "home_banner" }]);
    const placement = usePlacementsStore.getState().home!;
    expect(placement.title).toBe("Fast CI for your repo");
    const html = renderToStaticMarkup(<PlacementHomeCardView placement={placement} />);
    expect(html).toContain('data-testid="placement-home"');
    expect(html).toContain("Sponsored · Acme");
    expect(html).toContain("Fast CI for your repo");
    expect(html).toContain("Run your tests in half the time.");
    expect(html).toContain("Try it");
    expect(html).toContain('aria-label="Hide this sponsored message"');
    expect(html).not.toMatch(/animate-|transition|<a /);
    expect(html).not.toContain("<img");
    // The link is never in the page: the main process opens it on a click.
    expect(html).not.toContain("acme.example");
  });

  test("an https image only when there is one", async () => {
    fakeMain({ ...PLACEMENT, imageUrl: "https://acme.example/logo.png" });
    const placement = await loadHomePlacement();
    const html = renderToStaticMarkup(<PlacementHomeCardView placement={placement!} />);
    expect(html).toContain('src="https://acme.example/logo.png"');
    expect(html).toMatch(/referrerpolicy="no-referrer"/i);
  });

  test("impression once, click opens through the main process, × hides it", async () => {
    const { actions } = fakeMain();
    const placement = await loadHomePlacement();
    placementShown(placement!, "home");
    placementShown(placement!, "home");
    openPlacement(placement!);
    dismissPlacement(placement!);
    await flush();
    expect(actions).toEqual([
      { id: "plc_abc", action: "impression" },
      { id: "plc_abc", action: "open" },
      { id: "plc_abc", action: "dismiss" },
    ]);
    expect(usePlacementsStore.getState().home).toBeNull();
  });
});

describe("placements: the turn line", () => {
  test("only on the running → done edge of the same session", () => {
    expect(turnJustFinished({ sessionId: "a", running: true }, { sessionId: "a", running: false })).toBe(true);
    expect(turnJustFinished({ sessionId: "a", running: false }, { sessionId: "a", running: false })).toBe(false);
    expect(turnJustFinished({ sessionId: "a", running: true }, { sessionId: "b", running: false })).toBe(false);
    expect(turnJustFinished({ sessionId: "a", running: false }, { sessionId: "a", running: true })).toBe(false);
  });

  test("asked once per session, drawn only while no turn runs, gone when the next turn starts", async () => {
    const { asks } = fakeMain({ ...PLACEMENT, slot: "turn_footer" });
    await loadTurnFooter("ses_1");
    await loadTurnFooter("ses_1");
    expect(asks).toEqual([{ slot: "turn_footer", sessionId: "ses_1" }]);
    const placement = usePlacementsStore.getState().footers.ses_1!;
    const line = renderToStaticMarkup(<PlacementTurnFooterView placement={placement} />);
    expect(line).toContain('data-testid="placement-turn-footer"');
    expect(line).toContain("Sponsored · Acme");
    expect(line).not.toMatch(/animate-|transition|<a /);
    // While a turn runs: nothing (the container's rule, before any state).
    expect(renderToStaticMarkup(<PlacementTurnFooter sessionId="ses_1" turnRunning />)).toBe("");
    expect(usePlacementsStore.getState().footers.ses_2).toBeUndefined();
    endTurnFooter("ses_1");
    expect(usePlacementsStore.getState().footers.ses_1).toBeNull();
    await loadTurnFooter("ses_1");
    expect(asks.length).toBe(1);
  });

  test("none from the main process: nothing", async () => {
    fakeMain(null);
    await loadTurnFooter("ses_1");
    expect(usePlacementsStore.getState().footers.ses_1).toBeNull();
    expect(renderToStaticMarkup(<PlacementTurnFooter sessionId="ses_1" turnRunning={false} />)).toBe("");
  });
});
