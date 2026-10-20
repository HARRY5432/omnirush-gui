import { describe, expect, test } from "bun:test";

import { readableErrorMessage } from "../src/app/lib/opencode";

describe("readableErrorMessage", () => {
  test("the engine's and the app server's own text, not their JSON", () => {
    expect(readableErrorMessage({ name: "UnknownError", data: { message: "OmniRush models are unavailable: the app's config does not point at the OmniRush gateway (see omnirush_ignored in the engine config). Reinstall or update the app." } }))
      .toBe("OmniRush models are unavailable: the app's config does not point at the OmniRush gateway (see omnirush_ignored in the engine config). Reinstall or update the app.");
    expect(readableErrorMessage({ code: "provider_locked", message: "Only OmniRush models are available." })).toBe("Only OmniRush models are available.");
    expect(readableErrorMessage({ name: "X", data: {} })).toBeNull();
    expect(readableErrorMessage(null)).toBeNull();
  });
});
