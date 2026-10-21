import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { useBuildathonStore, type BuildathonEvent, type BuildathonStatus } from "../src/app/lib/buildathon";
import { BuildathonChip } from "../src/react-app/domains/buildathon/buildathon";

const HOUR = 3_600_000;

function event(overrides: Partial<BuildathonEvent>): BuildathonEvent {
  return {
    id: "frontier-2026",
    name: "OmniRush Frontier Buildathon 2026",
    startsAt: new Date(Date.now() - 48 * HOUR).toISOString(),
    registrationEndsAt: null,
    deadlineAt: new Date(Date.now() + 5 * HOUR).toISOString(),
    resultsAt: null,
    phase: "building",
    pageUrl: null,
    submitUrl: null,
    rules: [],
    tracks: [],
    reminders: [],
    ...overrides,
  } as BuildathonEvent;
}

if (typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined") GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

function renderChip(): string {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<BuildathonChip />));
  const html = host.innerHTML;
  act(() => root.unmount());
  host.remove();
  return html;
}

function withStatus(ev: BuildathonEvent): string {
  const status = { enrolled: true, serverTime: null, event: ev, participant: null, submission: null, repro: { box: "on", agentRules: "", checklist: [] }, announcements: [], github: null } as BuildathonStatus;
  useBuildathonStore.setState({ status, offsetMs: 0 });
  return renderChip();
}

afterEach(() => useBuildathonStore.setState({ status: null }));

describe("header chip", () => {
  test("shows while submissions are open, shrinks and hides in a narrow title bar", () => {
    const html = withStatus(event({}));
    expect(html).toContain('data-testid="buildathon-chip"');
    expect(html).toContain("left");
    expect(html).toContain("Buildathon · ");
    expect(html).toContain("@max-[48rem]/titlebar:hidden");
    expect(html).toContain("@max-[32rem]/titlebar:hidden");
    expect(html).toContain("truncate");
  });

  test("nothing once submissions have closed (deadline passed, judging, results, closed)", () => {
    expect(withStatus(event({ deadlineAt: new Date(Date.now() - HOUR).toISOString() }))).toBe("");
    for (const phase of ["judging", "results", "closed"] as const) {
      expect(withStatus(event({ phase }))).toBe("");
    }
  });

  test("nothing without a status", () => {
    expect(renderChip()).toBe("");
  });
});
