import { describe, expect, test } from "bun:test";
import { OmniRushReasoningEffort } from "./omnirush-reasoning-effort.js";

type Hooks = Awaited<ReturnType<typeof OmniRushReasoningEffort>>;

const astra = { id: "gpt-6-astra", providerID: "omnirush" };
const sol = { id: "gpt-5.6-sol", providerID: "omnirush" };

async function run(
  hooks: Hooks,
  input: Parameters<Hooks["chat.params"]>[0],
  options: Record<string, unknown>,
) {
  const params = { options };
  await hooks["chat.params"](input, params);
  const headers: { headers: Record<string, string> } = { headers: {} };
  await hooks["chat.headers"](input, headers);
  return { options: params.options, headers: headers.headers };
}

describe("OmniRushReasoningEffort", () => {
  test("mirrors the max variant into reasoningEffort and the private header", async () => {
    const hooks = await OmniRushReasoningEffort();
    const result = await run(
      hooks,
      { agent: "omnirush", model: astra, message: { id: "msg_1", model: { variant: "max" } } },
      { reasoning_effort: "max", temperature: 0.2 },
    );
    expect(result.options).toEqual({ reasoning_effort: "max", reasoningEffort: "max", temperature: 0.2 });
    expect(result.headers).toEqual({ "x-omnirush-reasoning-effort": "max" });
  });

  test("applies to every omnirush.ai model", async () => {
    const hooks = await OmniRushReasoningEffort();
    for (const [index, model] of [astra, sol].entries()) {
      const result = await run(
        hooks,
        { agent: "omnirush", model, message: { id: `msg_${index}`, model: { variant: "xhigh" } } },
        { reasoning_effort: "xhigh" },
      );
      expect(result.options.reasoningEffort).toBe("xhigh");
      expect(result.headers["x-omnirush-reasoning-effort"]).toBe("xhigh");
    }
  });

  test("prefers the variant options over the variant name", async () => {
    const hooks = await OmniRushReasoningEffort();
    const result = await run(
      hooks,
      { agent: "omnirush", model: astra, message: { id: "msg_2", model: { variant: "max" } } },
      { reasoning_effort: "max" },
    );
    expect(result.options.reasoningEffort).toBe("max");
    expect(result.headers["x-omnirush-reasoning-effort"]).toBe("max");
  });

  test("falls back to the variant name when the options carry no effort", async () => {
    const hooks = await OmniRushReasoningEffort();
    const result = await run(
      hooks,
      { agent: "omnirush", model: astra, message: { id: "msg_3", model: { variant: "High" } } },
      {},
    );
    expect(result.options).toEqual({ reasoningEffort: "high" });
    expect(result.headers).toEqual({ "x-omnirush-reasoning-effort": "high" });
  });

  test("leaves requests without a selected effort untouched", async () => {
    const hooks = await OmniRushReasoningEffort();
    const result = await run(hooks, { agent: "omnirush", model: astra, message: { id: "msg_4", model: {} } }, { temperature: 0.2 });
    expect(result.options).toEqual({ temperature: 0.2 });
    expect(result.headers).toEqual({});
  });

  test("ignores unknown effort values", async () => {
    const hooks = await OmniRushReasoningEffort();
    const result = await run(
      hooks,
      { agent: "omnirush", model: astra, message: { id: "msg_5", model: { variant: "turbo" } } },
      { reasoning_effort: "turbo" },
    );
    expect(result.options).toEqual({ reasoning_effort: "turbo" });
    expect(result.headers).toEqual({});
  });

  test("skips other providers and title generation", async () => {
    const hooks = await OmniRushReasoningEffort();
    const external = await run(
      hooks,
      { agent: "omnirush", model: { id: "gpt-5.5", providerID: "openai" }, message: { id: "msg_6", model: { variant: "max" } } },
      { reasoning_effort: "max" },
    );
    expect(external.options).toEqual({ reasoning_effort: "max" });
    expect(external.headers).toEqual({});
    const title = await run(
      hooks,
      { agent: "title", model: astra, message: { id: "msg_7", model: { variant: "max" } } },
      {},
    );
    expect(title.options).toEqual({});
    expect(title.headers).toEqual({});
  });

  test("a message without a variant runs at the model-level default effort", async () => {
    const hooks = await OmniRushReasoningEffort();
    const result = await run(
      hooks,
      { agent: "explore", model: astra, message: { id: "msg_8", model: {} } },
      { reasoningEffort: "high" },
    );
    expect(result.options).toEqual({ reasoningEffort: "high" });
    expect(result.headers).toEqual({ "x-omnirush-reasoning-effort": "high" });
  });

  test("a chosen variant wins over the model-level default", async () => {
    const hooks = await OmniRushReasoningEffort();
    // The engine merges model options, then agent options, then the variant's.
    const result = await run(
      hooks,
      { agent: "omnirush", model: astra, message: { id: "msg_9", model: { variant: "low" } } },
      { ...{ reasoningEffort: "high" }, ...{ reasoningEffort: "low" } },
    );
    expect(result.options.reasoningEffort).toBe("low");
    expect(result.headers["x-omnirush-reasoning-effort"]).toBe("low");
  });

  test("small side requests keep the model's first variant, not the model-level default", async () => {
    const hooks = await OmniRushReasoningEffort();
    // As the engine reports a model's variants: its own OpenAI defaults merged with the config's.
    const variants = { low: { reasoningEffort: "low", reasoningSummary: "auto" }, high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" } };
    // smallOptions(first variant) merged with the model options (the default).
    const small = { store: false, reasoningEffort: "high", reasoningSummary: "auto" };
    const title = await run(
      hooks,
      { agent: "title", model: { ...astra, variants }, message: { id: "msg_10", model: { variant: "max" } } },
      { ...small },
    );
    // Titles: the first variant's effort, and still no private header (as before).
    expect(title.options).toEqual({ store: false, reasoningEffort: "low", reasoningSummary: "auto" });
    expect(title.headers).toEqual({});
    const copyName = await run(
      hooks,
      { agent: "project-copy-name", model: { ...astra, variants }, message: { id: "msg_11", model: {} } },
      { ...small },
    );
    expect(copyName.options).toEqual({ store: false, reasoningEffort: "low", reasoningSummary: "auto" });
    expect(copyName.headers).toEqual({ "x-omnirush-reasoning-effort": "low" });
    // A model without variants: no effort at all on its side requests.
    const bare = await run(hooks, { agent: "title", model: astra, message: { id: "msg_12", model: {} } }, { reasoningEffort: "high" });
    expect(bare.options).toEqual({});
    // Another provider's title request is not touched.
    const external = await run(
      hooks,
      { agent: "title", model: { id: "gpt-5.5", providerID: "openai" }, message: { id: "msg_13", model: {} } },
      { reasoningEffort: "xhigh" },
    );
    expect(external.options).toEqual({ reasoningEffort: "xhigh" });
  });

  test("module exposes only the plugin factory", async () => {
    const mod = await import("./omnirush-reasoning-effort.js");
    expect(Object.keys(mod)).toEqual(["OmniRushReasoningEffort"]);
  });
});
