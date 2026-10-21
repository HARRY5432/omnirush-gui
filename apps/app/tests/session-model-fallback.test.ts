import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { setProviderLockState } from "../src/app/lib/provider-lock";
import {
  computeModelAvailability,
  sessionModelFallback,
  type ModelAvailabilityContext,
} from "../src/react-app/domains/session/surface/model-availability";

// The server's lock as an app on 3.7 sees it: only OmniRush's own provider.
beforeAll(() => setProviderLockState({ locked: true }));
afterAll(() => setProviderLockState(null));

function catalog(providers: Array<{ id: string; models: string[] }>): ProviderListResponse {
  return {
    all: providers.map((entry) => ({
      id: entry.id,
      name: entry.id,
      source: "config",
      env: [],
      models: Object.fromEntries(entry.models.map((modelId) => [modelId, { name: modelId }])),
    })),
    connected: providers.map((entry) => entry.id),
    default: {},
  } as unknown as ProviderListResponse;
}

function context(overrides: Partial<ModelAvailabilityContext> = {}): ModelAvailabilityContext {
  return {
    workspaceReady: true,
    loading: false,
    signedIn: false,
    cloudProviderSyncReady: true,
    omniRushModelsSyncing: false,
    restrictToCloud: false,
    checkRestriction: () => false,
    // The locked engine lists OmniRush's models only (the account's catalog).
    cloudProviderList: catalog([{ id: "omnirush", models: ["gpt-6-astra", "gpt-6-sol"] }]),
    providerList: catalog([{ id: "omnirush", models: ["gpt-6-astra", "gpt-6-sol"] }]),
    ...overrides,
  };
}

const omnirushDefault = { providerID: "omnirush", modelID: "gpt-6-astra" };

function fallbackFor(sessionModel: { providerID: string; modelID: string }, ctx = context(), defaultModel = omnirushDefault) {
  return sessionModelFallback({
    sessionModel,
    sessionAvailability: computeModelAvailability(sessionModel, ctx),
    defaultModel,
    defaultAvailability: computeModelAvailability(defaultModel, ctx),
  });
}

describe("a conversation's remembered model that can no longer be used", () => {
  test("another provider's model (locked) moves to the OmniRush default", () => {
    expect(computeModelAvailability({ providerID: "mockai", modelID: "mock-1" }, context())).toEqual({
      status: "unavailable",
      reason: "provider_blocked",
    });
    expect(fallbackFor({ providerID: "mockai", modelID: "mock-1" })).toEqual(omnirushDefault);
    expect(fallbackFor({ providerID: "opencode", modelID: "big-pickle" })).toEqual(omnirushDefault);
  });

  test("an OmniRush model that left the catalog moves to the default", () => {
    expect(fallbackFor({ providerID: "omnirush", modelID: "gpt-5.6-sol" })).toEqual(omnirushDefault);
  });

  test("a usable model stays", () => {
    expect(fallbackFor({ providerID: "omnirush", modelID: "gpt-6-sol" })).toBeNull();
  });

  test("nothing moves while the catalog is still settling", () => {
    expect(fallbackFor({ providerID: "mockai", modelID: "mock-1" }, context({ providerList: undefined, cloudProviderList: null, cloudProviderSyncReady: false }))).toBeNull();
    expect(fallbackFor({ providerID: "mockai", modelID: "mock-1" }, context({ loading: true }))).toBeNull();
  });

  test("no switch when the default cannot be used either (the picker handles it)", () => {
    expect(fallbackFor(
      { providerID: "mockai", modelID: "mock-1" },
      context(),
      { providerID: "omnirush", modelID: "gpt-5.6-sol" },
    )).toBeNull();
    expect(sessionModelFallback({
      sessionModel: { providerID: "mockai", modelID: "mock-1" },
      sessionAvailability: { status: "unavailable", reason: "provider_blocked" },
      defaultModel: null,
      defaultAvailability: { status: "pending" },
    })).toBeNull();
  });

  test("the session route switches with a notice instead of opening the picker", () => {
    const source = readFileSync(join(import.meta.dir, "../src/react-app/shell/session-route.tsx"), "utf8");
    expect(source).toContain("sessionModelFallback({");
    expect(source).toContain('t("models.switched_unavailable", { model: modelName, provider: providerName })');
    expect(source).toContain("if (sessionFallbackKey) return;");
    const en = readFileSync(join(import.meta.dir, "../src/i18n/locales/en.ts"), "utf8");
    expect(en).toContain('"models.switched_unavailable": "Switched to {model} because {provider} isn\'t available."');
  });
});
