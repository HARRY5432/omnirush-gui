import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { showWrapQuestion, startWrapNow, wrapFinished } from "./budget-wrap-rules.js";
import { OmniRushBudgetWrap } from "./omnirush-budget-wrap.js";

const originalFetch = globalThis.fetch;
const originalServer = process.env.OMNIRUSH_SERVER_URL;
const originalToken = process.env.OMNIRUSH_SERVER_TOKEN;
const gatewayHeaders = new Map<string, Record<string, string>>();

beforeAll(() => {
  process.env.OMNIRUSH_WRAP_IDLE_SETTLE_MS = "0";
  process.env.OMNIRUSH_SERVER_URL = "http://localhost:3579";
  process.env.OMNIRUSH_SERVER_TOKEN = "local-token";
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    return new Response("{}", { status: 200, headers: gatewayHeaders.get(headers.get("x-omnirush-session-id") ?? "") ?? {} });
  }, originalFetch);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalServer === undefined) delete process.env.OMNIRUSH_SERVER_URL;
  else process.env.OMNIRUSH_SERVER_URL = originalServer;
  if (originalToken === undefined) delete process.env.OMNIRUSH_SERVER_TOKEN;
  else process.env.OMNIRUSH_SERVER_TOKEN = originalToken;
});

type Hooks = Awaited<ReturnType<typeof OmniRushBudgetWrap>>;

async function modelRequest(hooks: Hooks, sessionID: string, answer: Record<string, string>, agent?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  await hooks["chat.headers"]!({ sessionID, agent, model: { providerID: "omnirush", id: "gpt-6-astra" } }, { headers });
  gatewayHeaders.set(sessionID, answer);
  await (await fetch("http://gateway.test/v1/responses", { method: "POST", headers, body: "{}" })).text();
  return headers;
}

function operation(init?: RequestInit): string {
  const body: unknown = JSON.parse(String(init?.body));
  if (!body || typeof body !== "object" || !("input" in body)) return "";
  const input = body.input;
  if (!input || typeof input !== "object" || !("args" in input)) return "";
  const args = input.args;
  return args && typeof args === "object" && "operation" in args ? String(args.operation) : "";
}

describe("account budget wrap plugin", () => {
  test("compacts only after acceptance, with the selected model and private marker", async () => {
    const controls: string[] = [];
    let compactCalls = 0;
    let hooks: Hooks;
    hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("/experimental/ui-control/request")) {
          const action = operation(init);
          controls.push(action);
          return Response.json({ ok: true, result: { choice: action === "offer" ? "accept" : "ok" } });
        }
        if (url.endsWith("/session/ses_accept/summarize")) {
          compactCalls += 1;
          expect(JSON.parse(String(init?.body))).toEqual({ providerID: "omnirush", modelID: "gpt-6-astra" });
          const headers = await modelRequest(hooks, "ses_accept", { "x-omnirush-wrap-up": "1" }, "compaction");
          expect(headers["x-omnirush-context-wrap"]).toBe("1");
          await hooks.event!({ event: { type: "session.compacted", properties: { sessionID: "ses_accept" } } });
          return new Response("true", { status: 200 });
        }
        throw new Error("unexpected URL: " + url);
      },
    });
    try {
      const headers = await modelRequest(hooks, "ses_accept", {
        "x-omnirush-wrap-required": "1",
        "x-omnirush-wrap-offer-id": "allowance-1",
        "x-omnirush-wrap-scopes": "day",
      });
      expect(headers["x-omnirush-context-wrap"]).toBeUndefined();
      expect(compactCalls).toBe(0);
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_accept" } } });
      await Bun.sleep(30);
      expect(controls).toContain("offer");
      expect(controls).toContain("finish");
      expect(compactCalls).toBe(1);
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_accept" } } });
      await Bun.sleep(10);
      expect(compactCalls).toBe(1);
    } finally { await hooks.dispose!(); }
  });

  test("declining leaves the session running and never compacts it", async () => {
    let compactCalls = 0;
    const hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      fetch: async (input) => {
        if (String(input).includes("/experimental/ui-control/request")) return Response.json({ ok: true, result: { choice: "decline" } });
        compactCalls += 1;
        return new Response("true", { status: 200 });
      },
    });
    try {
      await modelRequest(hooks, "ses_decline", { "x-omnirush-wrap-required": "1", "x-omnirush-wrap-offer-id": "allowance-2" });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_decline" } } });
      await Bun.sleep(30);
      expect(compactCalls).toBe(0);
    } finally { await hooks.dispose!(); }
  });

  test("no connected window keeps the offer pending without compaction", async () => {
    let controlCalls = 0;
    const hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      fetch: async () => { controlCalls += 1; return Response.json({ ok: false, error: "window away" }); },
    });
    try {
      await modelRequest(hooks, "ses_away", { "x-omnirush-wrap-required": "1", "x-omnirush-wrap-offer-id": "allowance-3" });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_away" } } });
      await Bun.sleep(30);
      expect(controlCalls).toBeGreaterThan(0);
      const headers: Record<string, string> = {};
      await hooks["chat.headers"]!({ sessionID: "ses_away", model: { providerID: "omnirush", id: "gpt-6-astra" } }, { headers });
      expect(headers["x-omnirush-context-wrap"]).toBeUndefined();
    } finally { await hooks.dispose!(); }
  });
  test("a wrap served from bonus tokens (no gateway confirmation) still finishes", async () => {
    const controls: string[] = [];
    let hooks: Hooks;
    hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("/experimental/ui-control/request")) {
          const action = operation(init);
          controls.push(action);
          return Response.json({ ok: true, result: { choice: action === "offer" ? "accept" : "ok" } });
        }
        if (url.endsWith("/session/ses_pot/summarize")) {
          await modelRequest(hooks, "ses_pot", {}, "compaction");
          await hooks.event!({ event: { type: "session.compacted", properties: { sessionID: "ses_pot" } } });
          return new Response("true", { status: 200 });
        }
        throw new Error("unexpected URL: " + url);
      },
    });
    try {
      await modelRequest(hooks, "ses_pot", { "x-omnirush-wrap-required": "1", "x-omnirush-wrap-offer-id": "allowance-pot" });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_pot" } } });
      await Bun.sleep(30);
      expect(controls).toContain("finish");
      expect(controls).not.toContain("fail");
    } finally { await hooks.dispose!(); }
  });

  test("a failed wrap is reported once and never compacts again by itself", async () => {
    const controls: string[] = [];
    let compactCalls = 0;
    let choice = "accept";
    const hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("/experimental/ui-control/request")) {
          const action = operation(init);
          controls.push(action);
          if (action === "fail") choice = "failed";
          return Response.json({ ok: true, result: { choice: action === "offer" ? choice : "ok" } });
        }
        compactCalls += 1;
        return new Response("{}", { status: 500 });
      },
    });
    try {
      await modelRequest(hooks, "ses_fail", { "x-omnirush-wrap-required": "1", "x-omnirush-wrap-offer-id": "allowance-fail" });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_fail" } } });
      await Bun.sleep(50);
      expect(compactCalls).toBe(1);
      expect(controls.filter((item) => item === "fail")).toHaveLength(1);
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_fail" } } });
      await Bun.sleep(30);
      expect(compactCalls).toBe(1);
    } finally { await hooks.dispose!(); }
  });

  test("a running turn hides the question and an accepted wrap waits for idle", async () => {
    const controls: string[] = [];
    let compactCalls = 0;
    let hooks: Hooks;
    hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("/experimental/ui-control/request")) {
          const action = operation(init);
          controls.push(action);
          return Response.json({ ok: true, result: { choice: action === "offer" ? "accept" : "ok" } });
        }
        compactCalls += 1;
        await hooks.event!({ event: { type: "session.compacted", properties: { sessionID: "ses_busy" } } });
        return new Response("true", { status: 200 });
      },
    });
    try {
      await modelRequest(hooks, "ses_busy", { "x-omnirush-wrap-required": "1", "x-omnirush-wrap-offer-id": "allowance-busy" });
      await hooks.event!({ event: { type: "session.status", properties: { sessionID: "ses_busy", status: { type: "busy" } } } });
      await Bun.sleep(20);
      expect(compactCalls).toBe(0);
      expect(controls).not.toContain("offer");
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_busy" } } });
      await Bun.sleep(30);
      expect(compactCalls).toBe(1);
      expect(controls).toContain("finish");
    } finally { await hooks.dispose!(); }
  });
});

describe("account budget wrap plugin: retry and busy", () => {
  test("a Retry during a turn queued behind the wrap waits for idle", async () => {
    let compactCalls = 0;
    let choice = "accept";
    let hooks: Hooks;
    hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("/experimental/ui-control/request")) {
          const action = operation(init);
          if (action === "fail") choice = "accept"; // the person clicks Retry at once
          return Response.json({ ok: true, result: { choice: action === "offer" ? choice : "ok" } });
        }
        compactCalls += 1;
        // A prompt sent during the wrap keeps the session busy after it.
        await hooks.event!({ event: { type: "session.status", properties: { sessionID: "ses_q", status: { type: "busy" } } } });
        return new Response("{}", { status: 500 });
      },
    });
    try {
      await modelRequest(hooks, "ses_q", { "x-omnirush-wrap-required": "1", "x-omnirush-wrap-offer-id": "allowance-q" });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_q" } } });
      await Bun.sleep(60);
      expect(compactCalls).toBe(1);
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_q" } } });
      await Bun.sleep(30);
      expect(compactCalls).toBe(2);
    } finally { await hooks.dispose!(); }
  });
});

describe("account budget wrap plugin: queued turn", () => {
  test("a turn queued right after idle never sees the question", async () => {
    process.env.OMNIRUSH_WRAP_IDLE_SETTLE_MS = "60";
    const controls: string[] = [];
    const hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      fetch: async (input, init) => {
        controls.push(operation(init));
        return Response.json({ ok: true, result: { choice: "pending" } });
      },
    });
    try {
      await modelRequest(hooks, "ses_flash", { "x-omnirush-wrap-required": "1", "x-omnirush-wrap-offer-id": "allowance-flash" });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_flash" } } });
      await Bun.sleep(10);
      await hooks.event!({ event: { type: "session.status", properties: { sessionID: "ses_flash", status: { type: "busy" } } } });
      await Bun.sleep(120);
      expect(controls).not.toContain("offer");
    } finally {
      process.env.OMNIRUSH_WRAP_IDLE_SETTLE_MS = "0";
      await hooks.dispose!();
    }
  });
});

describe("handoff offer rules (shared with the CLI)", () => {
  test("CLI/desktop parity: budget-wrap-rules.ts matches PARITY.sha256", () => {
    const rows = readFileSync(join(import.meta.dir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
    for (const row of rows) {
      const [hash, name] = row.split(/\s+/);
      expect(createHash("sha256").update(readFileSync(join(import.meta.dir, name!))).digest("hex")).toBe(hash!);
    }
    expect(rows.length).toBe(1);
  });

  test("asks only while idle, starts only while idle, finishes on a compacted session", () => {
    expect(showWrapQuestion({ choice: "pending", busy: false })).toBe(true);
    expect(showWrapQuestion({ choice: "pending", busy: true })).toBe(false);
    for (const choice of ["decline", "done", "failed", "accept"]) expect(showWrapQuestion({ choice, busy: false })).toBe(false);
    expect(startWrapNow({ choice: "accept", busy: true, inFlight: false })).toBe(false);
    expect(startWrapNow({ choice: "accept", busy: false, inFlight: false })).toBe(true);
    expect(wrapFinished({ ok: true, compacted: false })).toBe(false);
    expect(wrapFinished({ ok: true, compacted: true })).toBe(true);
  });
});
