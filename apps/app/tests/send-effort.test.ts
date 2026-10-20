import { afterAll, describe, expect, mock, test } from "bun:test";

import type { ComposerDraft, ProviderListItem } from "../src/app/types";
import { OMNIRUSH_REASONING_EFFORTS } from "../src/app/constants";
import { getModelBehaviorSummary, resolveModelBehaviorValue } from "../src/app/lib/model-behavior";

type ProviderModel = ProviderListItem["models"][string];

const omnirushModel = (id: string, levels: string[]): ProviderModel => ({
  id,
  providerID: "omnirush",
  name: id,
  api: { id, url: "http://127.0.0.1:8090/omnirush/v1", npm: "@ai-sdk/openai" },
  status: "active",
  headers: {},
  options: {},
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 400_000, output: 128_000 },
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  release_date: "2026-10-01",
  variants: Object.fromEntries(levels.map((level) => [level, { reasoningEffort: level }])),
}) as ProviderModel;

const astra = omnirushModel("gpt-6-astra", ["low", "high", "xhigh", "max"]);
const nova = omnirushModel("nova-9", ["low", "high"]);
const catalog = { omnirush: { "gpt-6-astra": astra, "nova-9": nova } };
const astraRef = { providerID: "omnirush", modelID: "gpt-6-astra" };

describe("the effort a send carries is the one the picker shows", () => {
  test("resolver and picker agree for every stored choice", () => {
    for (const model of [astra, nova]) {
      for (const stored of [null, "", "default", ...OMNIRUSH_REASONING_EFFORTS, "ultra", "turbo", "High"]) {
        const shown = getModelBehaviorSummary("omnirush", model, stored).value;
        expect(shown).not.toBeNull();
        expect(resolveModelBehaviorValue("omnirush", model, stored)).toBe(shown);
      }
    }
  });

  test("no choice (a new chat, or one copied from a chat that had none) sends the default", () => {
    expect(resolveModelBehaviorValue("omnirush", astra, null)).toBe("xhigh");
    // A model without xhigh: the level nearest medium, as the server's engine default.
    expect(resolveModelBehaviorValue("omnirush", nova, null)).toBe("high");
  });

  test("a user choice is kept, an effort the model lacks falls back to the default", () => {
    expect(resolveModelBehaviorValue("omnirush", astra, "low")).toBe("low");
    expect(resolveModelBehaviorValue("omnirush", astra, "max")).toBe("max");
    expect(resolveModelBehaviorValue("omnirush", astra, "medium")).toBe("xhigh");
    expect(resolveModelBehaviorValue("omnirush", nova, "xhigh")).toBe("high");
  });

  test("before providers load, a stored choice passes through and none stays none (engine default)", () => {
    expect(resolveModelBehaviorValue("omnirush", undefined, "low")).toBe("low");
    expect(resolveModelBehaviorValue("omnirush", undefined, null)).toBeNull();
    expect(resolveModelBehaviorValue("omnirush", undefined, "default")).toBeNull();
  });
});

describe("send paths", () => {
  test("resolveSendVariant uses the catalog the picker rendered from", async () => {
    const { rememberProviderCatalog, resolveSendVariant } = await import("../src/react-app/domains/session/surface/session-model-store");
    expect(resolveSendVariant(astraRef, null, {})).toBeNull();
    rememberProviderCatalog(catalog);
    expect(resolveSendVariant(astraRef, null)).toBe("xhigh");
    expect(resolveSendVariant(astraRef, "low")).toBe("low");
    expect(resolveSendVariant({ providerID: "omnirush", modelID: "nova-9" }, undefined)).toBe("high");
    expect(resolveSendVariant(null, "low")).toBe("low");
  });

  test("every prompt and command send in the route and the queue drainer carries the resolved effort", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of ["../src/react-app/shell/session-route.tsx", "../src/react-app/domains/session/sync/global-queue-drainer.ts"]) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      const sends = [...source.matchAll(/\.session\.(promptAsync|command)\(\{([\s\S]*?)\}\);/g)];
      expect(sends.length).toBeGreaterThan(0);
      for (const [, , body] of sends) expect(body).toMatch(/\.\.\.\((sendVariant|variant) \? \{ variant/);
      // No send effort is taken from a stored value without the resolver.
      const assignments = [...source.matchAll(/const sendVariant = [^\n]*/g)].map(([line]) => line);
      expect(assignments.length).toBeGreaterThan(0);
      for (const line of assignments) expect(line).toContain("resolveSendVariant(");
    }
  });
});

describe("queued message drain", () => {
  const calls: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const restore: Array<() => void> = [];
  afterAll(() => restore.forEach((fn) => fn()));

  test("a queued message and a queued command send the shown effort, not the stored null", async () => {
    const realOpencode = await import("../src/app/lib/opencode");
    const fakeClient = {
      session: {
        promptAsync: async (input: Record<string, unknown>) => { calls.push({ kind: "prompt", input }); return { data: {} }; },
        command: async (input: Record<string, unknown>) => { calls.push({ kind: "command", input }); return { data: {} }; },
      },
    };
    mock.module("@/app/lib/opencode", () => ({ ...realOpencode, createClient: () => fakeClient }));
    mock.module("@/app/lib/opencode-v2-adapter", () => ({ createClientV2: () => fakeClient, isOpencodeV2BaseUrl: () => false }));
    mock.module("@/app/lib/opencode-interruption", () => ({
      submitAfterInterruption: (_base: string, _id: string, send: (afterStop: boolean) => Promise<unknown>) => send(false),
    }));
    mock.module("@/app/lib/opencode-session-native", () => ({
      composeNativeSessionSnapshot: async () => ({ status: { type: "idle" } }),
    }));
    mock.module("@/react-app/domains/session/sync/session-sync", () => ({
      ensureWorkspaceSessionSync: () => () => {},
      trackWorkspaceSessionSync: () => () => {},
    }));
    mock.module("@/react-app/domains/session/sync/draft-parts", () => ({
      draftToParts: async (draft: ComposerDraft) => [{ type: "text", text: draft.text }],
    }));
    mock.module("@/react-app/domains/session/sync/env-context", () => ({ buildOmniRushSessionSystemContext: async () => undefined }));
    mock.module("@/app/lib/analytics", () => ({ markTaskRunStart: () => {} }));
    mock.module("@/react-app/kernel/model-config", () => ({ readStoredDefaultModel: () => astraRef }));

    const { rememberProviderCatalog, getSessionModelSelection, useSessionModelStore } = await import("../src/react-app/domains/session/surface/session-model-store");
    const { useComposerStateStore } = await import("../src/react-app/domains/session/surface/composer-state-store");
    const { setQueuedSendContext } = await import("../src/react-app/domains/session/sync/queued-send-context");
    const { startGlobalQueueDrainer } = await import("../src/react-app/domains/session/sync/global-queue-drainer");
    rememberProviderCatalog(catalog);

    const sessionId = "ses_queue_effort";
    // The chat was opened with the previous chat's settings: its model, no effort.
    useSessionModelStore.getState().setModel(sessionId, astraRef, null);
    setQueuedSendContext(sessionId, {
      workspaceId: "ws", workspaceRoot: "/tmp/ws", opencodeBaseUrl: "http://127.0.0.1:1/opencode", omnirushToken: "t",
      client: {} as never, agent: null, variant: null, model: astraRef, environmentRuntimeKey: null,
    });
    const draft = (text: string, command?: { name: string; arguments: string }): ComposerDraft => ({
      mode: "prompt", parts: [], attachments: [], text, ...(command ? { command } : {}),
    });
    useComposerStateStore.getState().appendQueuedDraft(sessionId, draft("queued message"));
    const stop = startGlobalQueueDrainer();
    restore.push(stop);
    const deadline = Date.now() + 3_000;
    while (calls.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls[0]).toMatchObject({ kind: "prompt", input: { variant: "xhigh", model: astraRef } });
    // The stored choice stays the user's (none); only the send resolves it.
    expect(getSessionModelSelection(sessionId)?.variant).toBeNull();

    useSessionModelStore.getState().setVariant(sessionId, "low");
    const { resetQueuedDrainForTests } = await import("../src/react-app/domains/session/surface/queued-drain-machine");
    resetQueuedDrainForTests?.();
    setQueuedSendContext(sessionId, {
      workspaceId: "ws", workspaceRoot: "/tmp/ws", opencodeBaseUrl: "http://127.0.0.1:1/opencode", omnirushToken: "t",
      client: {} as never, agent: null, variant: null, model: astraRef, environmentRuntimeKey: null,
    });
    useComposerStateStore.getState().appendQueuedDraft(sessionId, draft("/review", { name: "review", arguments: "" }));
    while (calls.length < 2 && Date.now() < deadline + 3_000) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls[1]).toMatchObject({ kind: "command", input: { command: "review", variant: "low" } });
  });
});
