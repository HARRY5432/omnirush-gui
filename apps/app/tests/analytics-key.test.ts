import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import * as analyticsKey from "../src/app/lib/analytics-key";
import { resolvePosthogKey } from "../src/app/lib/analytics-key";

const release = { appVersion: "3.5.9", packaged: true };

describe("analytics-key", () => {
  test("ships without a built-in key", () => {
    expect(Object.keys(analyticsKey)).toEqual(["resolvePosthogKey"]);
  });

  test("stays silent without an env key", () => {
    expect(resolvePosthogKey(undefined, release)).toBe("");
    expect(resolvePosthogKey(null, release)).toBe("");
  });

  test("treats an explicit blank as disabled", () => {
    expect(resolvePosthogKey("", release)).toBe("");
  });

  test("trims whitespace to disabled", () => {
    expect(resolvePosthogKey("  ", release)).toBe("");
  });

  test("uses an explicit key after trim in a packaged release build", () => {
    expect(resolvePosthogKey(" phc_custom ", release)).toBe("phc_custom");
    expect(resolvePosthogKey("phc_custom", { appVersion: "3.6.0-rc.1", packaged: true })).toBe("phc_custom");
  });

  test("never sends from a dev or unpackaged build, even with the key set", () => {
    // `pnpm dev`, a source checkout, an unpackaged build: no packaged flag.
    expect(resolvePosthogKey("phc_custom")).toBe("");
    expect(resolvePosthogKey("phc_custom", { appVersion: "3.5.9" })).toBe("");
    expect(resolvePosthogKey("phc_custom", { appVersion: "3.5.9", packaged: false })).toBe("");
    // A packaged build that was never stamped with a release version.
    for (const appVersion of ["0.0.0-dev", "0.0.0", "", null, "3.5.9-dev", "3.5.9-dev.2", "dev", "latest"]) {
      expect(resolvePosthogKey("phc_custom", { appVersion, packaged: true })).toBe("");
    }
  });

  test("the packaged flag comes only from the Electron build", () => {
    const vite = readFileSync(path.join(import.meta.dir, "..", "vite.config.ts"), "utf8");
    expect(vite).toContain('"import.meta.env.VITE_OMNIRUSH_PACKAGED_BUILD": JSON.stringify(isElectronPackagedBuild ? "1" : "")');
    expect(vite).toContain('const isElectronPackagedBuild = process.env.OMNIRUSH_ELECTRON_BUILD === "1"');
  });
});
