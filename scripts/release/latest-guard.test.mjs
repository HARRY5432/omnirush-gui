import assert from "node:assert/strict";
import { test } from "node:test";
import { latestReleaseDecision } from "./latest-guard.mjs";

test("a fresh release must be higher than the release marked Latest", () => {
  assert.deepEqual(latestReleaseDecision({ version: "3.4.2", latestVersion: "3.4.1", mode: "fresh" }), {
    ok: true,
    markLatest: true,
    problems: [],
  });
  assert.equal(latestReleaseDecision({ version: "4.0.0", latestVersion: "3.4.1", mode: "fresh" }).markLatest, true);
});

test("v3.3.8 after v3.4.1 is refused before anything is built", () => {
  const decision = latestReleaseDecision({ version: "3.3.8", latestVersion: "3.4.1", mode: "fresh" });
  assert.equal(decision.ok, false);
  assert.equal(decision.markLatest, false);
  assert.match(decision.problems[0], /lower than the release marked Latest \(v3\.4\.1\)/);
  assert.match(decision.problems[0], /Publish v3\.4\.2 or higher/);
});

test("a fresh release equal to Latest is refused", () => {
  const decision = latestReleaseDecision({ version: "3.4.1", latestVersion: "3.4.1", mode: "fresh" });
  assert.equal(decision.ok, false);
  assert.match(decision.problems[0], /already the release marked Latest/);
});

test("a rebuild keeps Latest on the newest release", () => {
  assert.deepEqual(latestReleaseDecision({ version: "3.4.1", latestVersion: "3.4.1", mode: "recovery" }).markLatest, true);
  const older = latestReleaseDecision({ version: "3.3.8", latestVersion: "3.4.1", mode: "recovery" });
  assert.equal(older.ok, true);
  assert.equal(older.markLatest, false, "rebuilding an older tag must not move Latest backwards");
});

test("the first release is marked Latest", () => {
  assert.equal(latestReleaseDecision({ version: "1.0.0", latestVersion: null, mode: "fresh" }).markLatest, true);
});

test("malformed input is refused", () => {
  assert.equal(latestReleaseDecision({ version: "3.4.2-beta.1", latestVersion: "3.4.1", mode: "fresh" }).ok, false);
  assert.equal(latestReleaseDecision({ version: "3.4.2", latestVersion: "3.4.1", mode: "other" }).ok, false);
  assert.equal(latestReleaseDecision({ version: "3.4.2", latestVersion: "garbage", mode: "fresh" }).ok, false);
});
