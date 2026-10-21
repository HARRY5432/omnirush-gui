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

function fallbackFor(
  sessionModel: { providerID: string; modelID: string },
  ctx = context(),
  defaultModel = omnirushDefault,
  lockAnswered = true,
) {
  return sessionModelFallback({
    sessionModel,
    sessionAvailability: computeModelAvailability(sessionModel, ctx),
    defaultModel,
    defaultAvailability: computeModelAvailability(defaultModel, ctx),
    lockAnswered,
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
      lockAnswered: true,
    })).toBeNull();
  });

  test("a blocked provider does not move the chat before the server answered the lock", () => {
    // The app starts locked until its server answers; an unlocked server must not see chats rewritten.
    expect(fallbackFor({ providerID: "mockai", modelID: "mock-1" }, context(), omnirushDefault, false)).toBeNull();
    // A retired OmniRush model does not depend on the lock.
    expect(fallbackFor({ providerID: "omnirush", modelID: "gpt-5.6-sol" }, context(), omnirushDefault, false)).toEqual(omnirushDefault);
  });

  test("an organization's provider that is not connected, or another provider's missing model, keeps the picker", () => {
    const base = { defaultModel: omnirushDefault, defaultAvailability: { status: "available" } as const, lockAnswered: true };
    expect(sessionModelFallback({
      ...base,
      sessionModel: { providerID: "lpr_acme", modelID: "acme-large" },
      sessionAvailability: { status: "unavailable", reason: "provider_not_connected" },
    })).toBeNull();
    expect(sessionModelFallback({
      ...base,
      sessionModel: { providerID: "lpr_acme", modelID: "acme-old" },
      sessionAvailability: { status: "unavailable", reason: "model_missing" },
    })).toBeNull();
  });

  test("the lock state records the server's first answer", async () => {
    const lock = await import("../src/app/lib/provider-lock");
    lock.resetProviderLockState();
    expect(lock.providerLockAnswered()).toBe(false);
    lock.setProviderLockState(null);
    expect(lock.providerLockAnswered()).toBe(false);
    const before = lock.providerLockState();
    lock.setProviderLockState({ locked: true, message: "Only OmniRush models are available." });
    expect(lock.providerLockAnswered()).toBe(true);
    // Same lock, new object: subscribers re-render for the answer.
    expect(lock.providerLockState()).not.toBe(before);
    expect(lock.providerLockState().locked).toBe(true);
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
