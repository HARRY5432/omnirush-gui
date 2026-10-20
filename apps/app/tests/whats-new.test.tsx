import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { localStorage: storage, addEventListener: () => undefined, removeEventListener: () => undefined },
});

const whatsNew = await import("../src/react-app/domains/whats-new/whats-new");
const { UpdateToastCard, WhatsNewReleases, WhatsNewText, updateToastPlacement } = await import("../src/react-app/domains/whats-new/whats-new-sheet");
const { rankPaletteItems } = await import("../src/react-app/shell/command-palette-search");
const { ensureInspectorInstalled } = await import("../src/app/lib/app-inspector");

const DIR = path.join(import.meta.dir, "../src/react-app/domains/whats-new");
const DATA = JSON.parse(readFileSync(path.join(DIR, "whats-new.json"), "utf8")) as {
  schema: number;
  cli: Array<Record<string, unknown>>;
  desktop: Array<Record<string, unknown>>;
};

beforeEach(() => {
  storage.clear();
  whatsNew.resetWhatsNewStoreForTests();
});

describe("whats-new.json", () => {
  test("matches PARITY.sha256 (the CLI's copy)", () => {
    const rows = readFileSync(path.join(DIR, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [hash, name] = row.split(/\s+/);
      const file = path.basename(name ?? "");
      const actual = createHash("sha256").update(readFileSync(path.join(DIR, file))).digest("hex");
      expect(`${file} ${actual}`).toBe(`${file} ${hash}`);
    }
  });

  test("schema 1: semver versions, ISO dates, newest first, string items", () => {
    expect(DATA.schema).toBe(1);
    expect(DATA.desktop.length).toBeGreaterThan(0);
    for (const list of [DATA.cli, DATA.desktop]) {
      expect(Array.isArray(list)).toBe(true);
      for (const [index, entry] of list.entries()) {
        const version = String(entry.version);
        const date = String(entry.date);
        expect(whatsNew.isSemver(version)).toBe(true);
        expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(date);
        for (const group of ["new", "improved", "fixed"]) {
          const items = entry[group];
          expect(Array.isArray(items)).toBe(true);
          for (const item of items as unknown[]) {
            expect(typeof item).toBe("string");
            expect((item as string).trim().length).toBeGreaterThan(0);
          }
        }
        if (index > 0) {
          const previous = list[index - 1]!;
          expect(whatsNew.compareVersions(String(previous.version), version)!).toBeGreaterThan(0);
          expect(String(previous.date) >= date).toBe(true);
        }
      }
    }
    expect(whatsNew.desktopReleases[0]?.version).toBe(String(DATA.desktop[0]!.version));
  });
});

describe("versions", () => {
  test("compareVersions", () => {
    expect(whatsNew.compareVersions("3.6.3", "3.6.2")).toBeGreaterThan(0);
    expect(whatsNew.compareVersions("3.6.0", "3.5.9")).toBeGreaterThan(0);
    expect(whatsNew.compareVersions("3.10.0", "3.9.9")).toBeGreaterThan(0);
    expect(whatsNew.compareVersions("3.6.2", "3.6.3")).toBeLessThan(0);
    expect(whatsNew.compareVersions("3.6.3", "3.6.3")).toBe(0);
    expect(whatsNew.compareVersions("3.6.3-beta.1", "3.6.3")).toBeLessThan(0);
    expect(whatsNew.compareVersions("junk", "3.6.3")).toBeNull();
    expect(whatsNew.compareVersions("3.6.3-beta.10", "3.6.3-beta.9")).toBeGreaterThan(0);
    expect(whatsNew.compareVersions("3.6.3-beta.2", "3.6.3-beta.10")).toBeLessThan(0);
    expect(whatsNew.compareVersions("3.6.3-1", "3.6.3-alpha")).toBeLessThan(0);
    expect(whatsNew.compareVersions("3.6.3-beta", "3.6.3-beta.1")).toBeLessThan(0);
  });

  test("dev builds count as no version", () => {
    expect(whatsNew.normalizeAppVersion("0.0.0-dev")).toBe("");
    expect(whatsNew.normalizeAppVersion("0.0.0")).toBe("");
    expect(whatsNew.normalizeAppVersion("")).toBe("");
    expect(whatsNew.normalizeAppVersion(undefined)).toBe("");
    expect(whatsNew.normalizeAppVersion(" 3.6.3 ")).toBe("3.6.3");
    expect(whatsNew.displayVersion("")).toBe(whatsNew.desktopReleases[0]!.version);
    expect(whatsNew.displayVersion("3.6.2")).toBe("3.6.2");
  });
});

describe("update toast decision", () => {
  test("fresh install: no toast, remembers the version", () => {
    expect(whatsNew.updateDecision(null, "3.6.3")).toEqual({ toast: false, store: "3.6.3" });
    expect(whatsNew.updateDecision("", "3.6.3")).toEqual({ toast: false, store: "3.6.3" });
    expect(whatsNew.updateDecision("garbage", "3.6.3")).toEqual({ toast: false, store: "3.6.3" });
  });

  test("same version: nothing", () => {
    expect(whatsNew.updateDecision("3.6.3", "3.6.3")).toEqual({ toast: false, store: null });
  });

  test("upgrade: toast once", () => {
    expect(whatsNew.updateDecision("3.6.2", "3.6.3")).toEqual({ toast: true, store: "3.6.3" });
    expect(whatsNew.updateDecision("3.5.9", "3.6.0")).toEqual({ toast: true, store: "3.6.0" });
  });

  test("downgrade: no toast, keeps the higher stored version", () => {
    expect(whatsNew.updateDecision("3.6.3", "3.6.2")).toEqual({ toast: false, store: null });
  });

  test("dev build (empty version): never toasts or stores", () => {
    expect(whatsNew.updateDecision(null, "")).toEqual({ toast: false, store: null });
    expect(whatsNew.updateDecision("3.6.2", "")).toEqual({ toast: false, store: null });
  });

  test("stored state: upgrade toasts once, then not again", () => {
    expect(whatsNew.takeUpdateDecision("3.6.2")).toBe(false);
    expect(storage.getItem(whatsNew.LAST_VERSION_STORAGE_KEY)).toBe("3.6.2");
    expect(whatsNew.takeUpdateDecision("3.6.3")).toBe(true);
    // Not remembered until shown: a start that never got to show it asks again.
    expect(whatsNew.takeUpdateDecision("3.6.3")).toBe(true);
    whatsNew.markUpdateToastShown("3.6.3");
    expect(whatsNew.takeUpdateDecision("3.6.3")).toBe(false);
    expect(whatsNew.takeUpdateDecision("3.6.2")).toBe(false);
    expect(storage.getItem(whatsNew.LAST_VERSION_STORAGE_KEY)).toBe("3.6.3");
  });
});

describe("menu dot and opening", () => {
  test("dot until the notes were opened on this version", () => {
    expect(whatsNew.hasUnseenNotes(null, "3.6.3")).toBe(true);
    expect(whatsNew.hasUnseenNotes("3.6.2", "3.6.3")).toBe(true);
    expect(whatsNew.hasUnseenNotes("3.6.3", "3.6.3")).toBe(false);
  });

  test("opening stores the version, opens the sheet and records whats_new_opened", () => {
    ensureInspectorInstalled();
    const inspector = (window as unknown as { __omnirush: { events: (limit?: number) => Array<{ name: string; data?: unknown }>; clearEvents: () => void } }).__omnirush;
    inspector.clearEvents();
    whatsNew.openWhatsNew("palette");
    const state = whatsNew.useWhatsNewStore.getState();
    expect(state.open).toBe(true);
    expect(state.openedVersion).toBe(whatsNew.displayVersion());
    expect(storage.getItem(whatsNew.OPENED_VERSION_STORAGE_KEY)).toBe(whatsNew.displayVersion());
    expect(inspector.events(50).map((entry) => entry.name)).toContain("analytics.whats_new_opened");
    whatsNew.closeWhatsNew();
    expect(whatsNew.useWhatsNewStore.getState().open).toBe(false);
  });
});

describe("sheet content", () => {
  test("inline code", () => {
    expect(whatsNew.inlineParts("Use `/undo` or `omnirush notify` now")).toEqual([
      { code: false, text: "Use " },
      { code: true, text: "/undo" },
      { code: false, text: " or " },
      { code: true, text: "omnirush notify" },
      { code: false, text: " now" },
    ]);
    expect(whatsNew.inlineParts("a ` lone tick")).toEqual([{ code: false, text: "a ` lone tick" }]);
    expect(renderToStaticMarkup(<WhatsNewText text="Run `x`" />)).toContain("<code");
  });

  test("current version first with a badge, groups in order, empty groups hidden", () => {
    const releases = [
      { version: "3.6.3", date: "2026-10-20", new: ["A `b`"], improved: [], fixed: ["C"] },
      { version: "3.6.2", date: "2026-10-19", new: [], improved: ["D"], fixed: [] },
    ];
    const markup = renderToStaticMarkup(<WhatsNewReleases releases={releases} version="3.6.3" />);
    expect(markup.indexOf('data-whats-new-release="3.6.3"')).toBeLessThan(markup.indexOf('data-whats-new-release="3.6.2"'));
    const current = markup.slice(0, markup.indexOf('data-whats-new-release="3.6.2"'));
    expect(current).toContain('data-current="true"');
    expect(current).toContain("Current");
    expect(current).toContain('data-whats-new-group="new"');
    expect(current).not.toContain('data-whats-new-group="improved"');
    expect(current.indexOf('data-whats-new-group="new"')).toBeLessThan(current.indexOf('data-whats-new-group="fixed"'));
    expect(current).toContain("<code");
    const older = markup.slice(markup.indexOf('data-whats-new-release="3.6.2"'));
    expect(older).not.toContain("data-current");
    expect(older).toContain('data-whats-new-group="improved"');
    expect(older).not.toContain('data-whats-new-group="fixed"');
  });

  test("the real data renders every desktop release", () => {
    const markup = renderToStaticMarkup(<WhatsNewReleases version={whatsNew.desktopReleases[0]!.version} />);
    for (const release of whatsNew.desktopReleases) expect(markup).toContain(`data-whats-new-release="${release.version}"`);
    expect(markup.match(/data-current="true"/g)?.length).toBe(1);
  });
});

describe("which releases a build shows", () => {
  const releases = [
    { version: "3.6.3", date: "2026-10-20", new: ["A"], improved: [], fixed: [] },
    { version: "3.6.1", date: "2026-10-19", new: ["B"], improved: [], fixed: [] },
    { version: "3.6.0", date: "2026-10-18", new: ["C"], improved: [], fixed: [] },
  ];
  test("own entry is current", () => {
    expect(whatsNew.releasesFor("3.6.3", releases)).toEqual({ releases, current: "3.6.3" });
  });
  test("no own entry: the closest older one is current, newer ones hidden", () => {
    const shown = whatsNew.releasesFor("3.6.2", releases);
    expect(shown.current).toBe("3.6.1");
    expect(shown.releases.map((r) => r.version)).toEqual(["3.6.1", "3.6.0"]);
    const markup = renderToStaticMarkup(<WhatsNewReleases releases={releases} version="3.6.2" />);
    expect(markup).not.toContain('data-whats-new-release="3.6.3"');
    expect(markup).toContain('data-whats-new-release="3.6.1" data-current="true"');
  });
  test("dev build or older than every entry: all, newest first", () => {
    expect(whatsNew.releasesFor("", releases)).toEqual({ releases, current: "3.6.3" });
    expect(whatsNew.releasesFor("3.5.0", releases)).toEqual({ releases, current: null });
  });
});

describe("update toast", () => {
  test("one-line summary from the first New items", () => {
    expect(whatsNew.updateSummary(whatsNew.desktopReleases.find((r) => r.version === "3.6.3"))).toBe("Chat and IDE layouts, permission modes and more.");
    expect(whatsNew.updateSummary({ version: "1.0.0", date: "2026-01-01", new: ["Use `/undo` now."], improved: [], fixed: [] })).toBe("Use /undo now.");
    expect(whatsNew.updateSummary({ version: "1.0.0", date: "2026-01-01", new: ["One thing: a", "IDE mode: b"], improved: [], fixed: [] })).toBe("One thing and IDE mode.");
    expect(whatsNew.updateSummary({ version: "1.0.0", date: "2026-01-01", new: [], improved: [], fixed: ["Fixed a crash."] })).toBe("Fixed a crash.");
    expect(whatsNew.updateSummary(undefined)).toBe("");
  });

  test("card: icon, title, summary, What's new and Later", () => {
    const markup = renderToStaticMarkup(<UpdateToastCard version="3.6.3" summary="Chat and IDE layouts and more." onOpen={() => {}} onClose={() => {}} />);
    expect(markup).toContain("Updated to 3.6.3");
    expect(markup).toContain("Chat and IDE layouts and more.");
    expect(markup).toContain("What&#x27;s new");
    expect(markup).toContain("Later");
    expect(markup).toContain("<svg");
  });

  test("placement: above the composer, right-aligned; a strip in a narrow chat; corner without a composer", () => {
    const viewport = { width: 1440, height: 900 };
    const wide = updateToastPlacement({ left: 230, right: 1400, top: 640, width: 1170 }, { right: 1213 }, viewport);
    expect(wide).toEqual({ right: 227, bottom: 272, width: 360, strip: false });
    const narrow = updateToastPlacement({ left: 760, right: 1090, top: 470, width: 330 }, { right: 1060 }, { width: 1100, height: 800 });
    expect(narrow).toEqual({ left: 772, right: 22, bottom: 342, strip: true });
    expect(updateToastPlacement(null, null, viewport)).toEqual({ right: 24, bottom: 24, strip: false });
  });
});

describe("command palette", () => {
  test("the What's new row sits under Help", () => {
    const groups = rankPaletteItems("what", [
      { id: "whats-new", title: "What's new", group: "help", keywords: ["changelog"], action: () => {} },
      { id: "x", title: "Something else", action: () => {} },
    ], []);
    expect(groups[0]?.label).toBe("Help");
    expect(groups[0]?.items[0]?.id).toBe("whats-new");
    expect(rankPaletteItems("", [{ id: "whats-new", title: "What's new", group: "help", action: () => {} }], [])[0]?.label).toBe("Help");
  });
});
