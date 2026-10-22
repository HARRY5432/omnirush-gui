import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OmniRushGatewayBroker } from "./omnirush-gateway-broker.js";
import { askSideQuestion, brokerSideCall } from "./side-question.js";
import { parseSideQuestion } from "./btw/side-question.mjs";
import type { OmniRushModelCatalog } from "./omnirush-model-catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse("2026-10-22T10:00:00Z");

// A chat whose turn is running: a tool call still at work.
const RUNNING = [
  { info: { id: "msg_1", role: "user", time: { created: T0 }, model: { providerID: "omnirush", modelID: "gpt-6-astra" } }, parts: [{ type: "text", text: "Fix the failing parser tests" }] },
  { info: { id: "msg_2", role: "assistant", time: { created: T0 + 1_000 }, modelID: "gpt-6-astra", providerID: "omnirush" }, parts: [{ type: "tool", tool: "bash", state: { status: "running", input: { command: "npm test" } } }] },
];
const ANSWER = [
  { type: "response.output_text.delta", delta: "Running npm test." },
  { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "Running npm test." }] }], usage: { input_tokens: 700, output_tokens: 9 } } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const CATALOG = [{ id: "gpt-6-astra", display_name: "Astra", reasoning_levels: ["low", "medium", "high"], capabilities: { reasoning: true, tool_call: true, web_search: true } }] as unknown as OmniRushModelCatalog;

type Call = { url: string; method: string; headers: Headers; body: Record<string, unknown> | null };

function rig() {
  const upstream: Call[] = [];
  const broker = new OmniRushGatewayBroker({
    credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
    engineToken: "local-engine-token",
    fetch: async (input, init) => {
      const raw = init?.body;
      const text = raw === undefined ? "" : typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
      upstream.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: text ? JSON.parse(text) : null });
      return new Response(ANSWER, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  // The engine: every request kept; it serves the running chat.
  const engineCalls: string[] = [];
  const messages = JSON.stringify(RUNNING);
  const engineFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    engineCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    return url.pathname === "/session/ses_run/message" ? new Response(messages, { headers: { "content-type": "application/json" } }) : new Response("", { status: 404 });
  }) as typeof fetch;
  const trace: Array<{ sessionId: string; type: string; data: unknown }> = [{ sessionId: "ses_run", type: "collector.trigger", data: { trigger: "prompt" } }];
  const capture = { uploadEnabled: true, hasSession: (id: string) => id === "ses_run", recordTrace: (sessionId: string, type: string, data: unknown) => trace.push({ sessionId, type, data }) };
  return { broker, upstream, engineCalls, engineFetch, trace, capture };
}

describe("/btw side questions", () => {
  test("CLI/desktop parity: btw/PARITY.sha256 matches its files", () => {
    const dir = join(here, "btw");
    const rows = readFileSync(join(dir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
    expect(rows.length).toBe(1);
    for (const row of rows) {
      const [hash, name] = row.split(/\s+/);
      expect(createHash("sha256").update(readFileSync(join(dir, name!))).digest("hex")).toBe(hash!);
    }
  });

  test("the app reads /btw the same way as the shared module", async () => {
    // A computed path: the app's file is outside this package's typecheck.
    const { parseSideQuestion: appParse } = (await import(join(here, "../../app/src/react-app/domains/session/surface/side-question.ts"))) as { parseSideQuestion: (text: string) => string | null };
    for (const line of ["/btw what now?", "  /BTW  a\nb ", "/btw", "/btwx hi", "fix /btw later", "/btw\tq"]) expect(appParse(line)).toBe(parseSideQuestion(line));
  });

  test("during a running turn: the engine gets one read and no prompt; the turn's trace gains only a side_question", async () => {
    const r = rig();
    const before = JSON.stringify(r.trace);
    const answer = await askSideQuestion({
      engine: { baseUrl: "http://127.0.0.1:4096", headers: [["Authorization", "Basic x"]], search: "?directory=%2Ftmp%2Fp", engine: "v1" },
      ask: brokerSideCall(r.broker, "local-engine-token"),
      catalog: async () => CATALOG,
      webSearch: () => ({ enabled: true, searchContextSize: "low", models: null }),
      capture: r.capture,
      fetchImpl: r.engineFetch,
    }, { sessionId: "ses_run", question: "what is it doing right now?" });
    expect(answer).toEqual({ ok: true, answer: "Running npm test.", sources: [], busy: true, error: null });
    expect(r.engineCalls).toEqual(["GET /session/ses_run/message"]);
    expect(JSON.stringify(r.trace.slice(0, 1))).toBe(before);
    expect(r.trace).toHaveLength(2);
    expect(r.trace[1]!.type).toBe("side_question");
    expect(r.trace[1]!.data).toMatchObject({ schema: 1, question: "what is it doing right now?", answer: "Running npm test.", during_turn: true, web_search: true, effort: "low", usage: { input_tokens: 700, output_tokens: 9 } });
    const [call] = r.upstream;
    expect(call!.url).toBe("https://gateway.example/omnirush/v1/responses");
    expect(call!.headers.get("authorization")).toBe("Bearer access-token");
    expect(call!.headers.get("x-omnirush-session-id")).toBe("ses_run");
    expect(call!.body).toMatchObject({ model: "gpt-6-astra", prompt_cache_key: "ses_run", store: false, stream: true, tools: [{ type: "web_search", search_context_size: "low" }] });
    expect((call!.body!.reasoning as Record<string, unknown>).effort).toBe("low");
  });

  test("the side call goes out with the same client headers as the engine's own model calls", async () => {
    const r = rig();
    await (await r.broker.handle(new Request("http://127.0.0.1/omnirush-gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer local-engine-token", "content-type": "application/json", "x-omnirush-session-id": "ses_run" },
      body: JSON.stringify({ model: "gpt-6-astra", input: [] }),
    }), "responses")).text();
    await (await brokerSideCall(r.broker, "local-engine-token")({ model: "gpt-6-astra", input: [] }, "ses_run")).text();
    const [chat, side] = r.upstream;
    const names = (h: Headers) => [...h.keys()].filter((k) => k !== "x-omnirush-client-request-id").sort();
    expect(names(side!.headers)).toEqual(names(chat!.headers));
    for (const name of names(chat!.headers)) expect(side!.headers.get(name)).toBe(chat!.headers.get(name));
  });

  test("a chat the uploader does not track: answered, nothing recorded; no chat: refused", async () => {
    const r = rig();
    const deps = { engine: { baseUrl: "http://127.0.0.1:4096", headers: [] as Array<[string, string]>, search: "", engine: "v1" as const }, ask: brokerSideCall(r.broker, "local-engine-token"), catalog: async () => CATALOG, webSearch: () => null, capture: { ...r.capture, hasSession: () => false }, fetchImpl: r.engineFetch };
    expect((await askSideQuestion(deps, { sessionId: "ses_run", question: "q" })).ok).toBe(true);
    expect(r.trace).toHaveLength(1);
    expect(r.upstream[0]!.body!.tools).toBeUndefined();
    expect((await askSideQuestion({ ...deps, engine: null }, { sessionId: "", question: "q" })).error).toMatch(/Open a chat first/);
  });
});
