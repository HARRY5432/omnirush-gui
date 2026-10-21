/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FreeSpaceSection, freeSpaceMessage, type FreeSpaceResult } from "../src/react-app/domains/settings/pages/free-space-section";

const result = (over: Partial<FreeSpaceResult> = {}): FreeSpaceResult => ({ ok: true, skipped: null, dryRun: true, freedBytes: 0, freed: "0 B", items: [], ...over });

describe("settings free up space section", () => {
  test("renders Check and Free up space in the desktop app, and says what is never touched", () => {
    const markup = renderToStaticMarkup(<FreeSpaceSection available deps={{ freeUpSpace: async () => result() }} />);
    expect(markup).toContain("Storage");
    expect(markup).toContain("Check");
    expect(markup).toContain("Free up space");
    expect(markup).toContain("Restore previous version stays");
    expect(markup).toContain("never touched");
  });

  test("is hidden outside the desktop app", () => {
    expect(renderToStaticMarkup(<FreeSpaceSection available={false} />)).toBe("");
  });

  test("status lines: found, freed, nothing, update pending, busy", () => {
    const items = [{ kind: "installer", path: "/x/pending", bytes: 1, size: "180 MB", reason: "update 3.6.4 installed", inUse: false }];
    expect(freeSpaceMessage(result({ freed: "180 MB", items }))).toBe("180 MB can be freed (1 items)");
    expect(freeSpaceMessage(result({ dryRun: false, freed: "180 MB", items }))).toBe("Freed 180 MB");
    expect(freeSpaceMessage(result())).toBe("Nothing to remove");
    expect(freeSpaceMessage(result({ ok: false, skipped: "update-pending" }))).toContain("waiting to install");
    expect(freeSpaceMessage(result({ ok: false, skipped: "busy" }))).toContain("already running");
  });
});
