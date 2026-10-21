import assert from "node:assert/strict";
import test from "node:test";

import { applyBackgroundRenderingSwitches, mergeFeatureList, WINDOWS_OCCLUSION_FEATURE } from "./background-rendering.mjs";

function fakeCommandLine(initial = {}) {
  const switches = new Map(Object.entries(initial));
  return {
    switches,
    getSwitchValue(name) { return switches.get(name) ?? ""; },
    appendSwitch(name, value) { switches.set(name, value); },
  };
}

test("merging keeps existing features, trims blanks and skips duplicates", () => {
  assert.equal(mergeFeatureList("", ["A"]), "A");
  assert.equal(mergeFeatureList(undefined, ["A"]), "A");
  assert.equal(mergeFeatureList(" X , ,Y", ["A", "X"]), "X,Y,A");
  assert.equal(mergeFeatureList("A", ["A"]), "A");
});

test("Windows turns off native occlusion so covered windows keep rendering", () => {
  const commandLine = fakeCommandLine();
  assert.equal(applyBackgroundRenderingSwitches(commandLine, "win32"), WINDOWS_OCCLUSION_FEATURE);
  assert.equal(commandLine.switches.get("disable-features"), "CalculateNativeWinOcclusion");
});

test("Windows keeps features disabled by launch arguments", () => {
  const commandLine = fakeCommandLine({ "disable-features": "SomethingElse" });
  applyBackgroundRenderingSwitches(commandLine, "win32");
  assert.equal(commandLine.switches.get("disable-features"), "SomethingElse,CalculateNativeWinOcclusion");
});

test("other platforms leave the command line alone", () => {
  /** @type {NodeJS.Platform[]} */
  const platforms = ["darwin", "linux"];
  for (const platform of platforms) {
    const commandLine = fakeCommandLine();
    assert.equal(applyBackgroundRenderingSwitches(commandLine, platform), null);
    assert.equal(commandLine.switches.size, 0);
  }
});
