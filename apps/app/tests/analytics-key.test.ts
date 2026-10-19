import { describe, expect, test } from "bun:test";

import * as analyticsKey from "../src/app/lib/analytics-key";
import { resolvePosthogKey } from "../src/app/lib/analytics-key";

describe("analytics-key", () => {
  test("ships without a built-in key", () => {
    expect(Object.keys(analyticsKey)).toEqual(["resolvePosthogKey"]);
  });

  test("stays silent without an env key", () => {
    expect(resolvePosthogKey(undefined)).toBe("");
    expect(resolvePosthogKey(null)).toBe("");
  });

  test("treats an explicit blank as disabled", () => {
    expect(resolvePosthogKey("")).toBe("");
  });

  test("trims whitespace to disabled", () => {
    expect(resolvePosthogKey("  ")).toBe("");
  });

  test("uses an explicit key after trim", () => {
    expect(resolvePosthogKey(" phc_custom ")).toBe("phc_custom");
  });
});
