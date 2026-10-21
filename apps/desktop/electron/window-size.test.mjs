import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initialWindowSize } from "./window-size.mjs";

describe("initial window size", () => {
  it("keeps the preferred size on a large screen", () => {
    assert.deepEqual(initialWindowSize({ width: 1920, height: 1040 }), { width: 1180, height: 820 });
  });

  it("fits a 1366x768 laptop with a taskbar", () => {
    assert.deepEqual(initialWindowSize({ width: 1366, height: 728 }), { width: 1180, height: 728 });
  });

  it("fits 1280x720 and 1366x768 at 125 % scaling", () => {
    assert.deepEqual(initialWindowSize({ width: 1280, height: 680 }), { width: 1180, height: 680 });
    assert.deepEqual(initialWindowSize({ width: 1093, height: 582 }), { width: 1093, height: 582 });
  });

  it("never exceeds a tiny screen and falls back without a work area", () => {
    assert.deepEqual(initialWindowSize({ width: 600, height: 400 }), { width: 600, height: 400 });
    assert.deepEqual(initialWindowSize(null), { width: 1180, height: 820 });
  });
});
