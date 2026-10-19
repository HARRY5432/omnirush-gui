// In-app feedback: the shared module (./feedback/feedback.mjs, the same file
// in the CLI, PARITY.sha256) and the main process's side (feedback-desktop.mjs,
// the account store's feedbackRequest). The CLI covers the same rules with its
// own launcher.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GENERAL_CATEGORIES, PULSE_QUESTION, TURN_REASONS } from "./feedback/feedback.mjs";
import { createDesktopFeedback, desktopFeedbackAllowed, desktopFeedbackRetryMs, EVENT_CHANNEL, RETRY_EVERY_MS } from "./feedback-desktop.mjs";
import { createDesktopOmniRushAccountStore } from "./omnirush-account.mjs";
import { buildNukeManifest } from "./nuke.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse("2026-10-19T09:00:00");
const DAY = 86_400_000;
const ON = { enabled: true, turn_sample_rate: 1, max_per_day: 1, pulse_enabled: false, pulse_after_sessions: 5, pulse_every_days: 30 };
const OK_TURN = { outcome: "ok", toolCalls: 1, durationMs: 2_000 };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "feedback-desk-"));
}

/**
 * A desktop feedback with a scripted server (the policy's answer or status,
 * the submit's status or "offline" / "signed_out"); every call is recorded.
 * @param {{ policy?: any, submit?: any, env?: Record<string, string>, packaged?: boolean, devMode?: boolean, userDataPath?: string, now?: () => number, accountId?: () => Promise<string | null> }} [options]
 */
function desktop({ policy = ON, submit = 201, env = { OMNIRUSH_FEEDBACK: "1" }, packaged = false, devMode = false, userDataPath = tmp(), now = () => T0, accountId = undefined } = {}) {
  const calls = [];
  const events = [];
  /** @type {{ policy: any, submit: any }} */
  const server = { policy, submit };
  const d = createDesktopFeedback({
    request: async (p, init) => {
      calls.push({ path: p, ...init });
      if (p === "/client/feedback-policy") return typeof server.policy === "number" ? { status: server.policy, data: null } : { status: 200, data: server.policy };
      if (p === "/feedback") {
        if (server.submit === "offline") throw new Error("ECONNREFUSED");
        if (server.submit === "signed_out") return null;
        if (typeof server.submit === "object") return server.submit;
        return { status: server.submit, data: server.submit === 201 ? { ok: true } : null, retryAfter: null };
      }
      return { status: 404, data: null };
    },
    userDataPath,
    version: "3.6.1",
    platform: "linux",
    env,
    packaged,
    devMode,
    emit: (name, properties) => events.push({ name, properties }),
    now,
    random: () => 0,
    ...(accountId ? { accountId } : {}),
  });
  return { d, calls, events, server, userDataPath };
}

test("parity: feedback.mjs is the CLI's file, byte for byte (PARITY.sha256)", () => {
  const listed = fs.readFileSync(path.join(here, "feedback", "PARITY.sha256"), "utf8");
  const hash = createHash("sha256").update(fs.readFileSync(path.join(here, "feedback", "feedback.mjs"))).digest("hex");
  const lines = listed.split("\n").filter((line) => line && !line.startsWith("#"));
  assert.ok(lines.length >= 1);
  for (const line of lines) assert.equal(line.split(/\s+/)[0], hash, `PARITY.sha256 lists ${line}`);
});

test("allowed: interactive released builds only; OMNIRUSH_FEEDBACK=0 off, =1 on; CI off", () => {
  assert.equal(desktopFeedbackAllowed({ env: {}, packaged: true }), true);
  assert.equal(desktopFeedbackAllowed({ env: {}, packaged: false }), false, "a development build never asks on its own");
  assert.equal(desktopFeedbackAllowed({ env: {}, packaged: true, devMode: true }), false);
  for (const off of ["0", "false", "no", "off", " OFF "]) assert.equal(desktopFeedbackAllowed({ env: { OMNIRUSH_FEEDBACK: off }, packaged: true }), false, off);
  assert.equal(desktopFeedbackAllowed({ env: { CI: "true" }, packaged: true }), false, "CI");
  assert.equal(desktopFeedbackAllowed({ env: { CI: "0" }, packaged: true }), true);
  assert.equal(desktopFeedbackAllowed({ env: { OMNIRUSH_FEEDBACK: "1" }, packaged: false }), true, "test rigs");
});

test("retry interval: 5 minutes; only an unpackaged build may shorten it", () => {
  assert.equal(RETRY_EVERY_MS, 300_000);
  assert.equal(desktopFeedbackRetryMs({ env: {}, packaged: true }), 300_000);
  assert.equal(desktopFeedbackRetryMs({ env: { OMNIRUSH_FEEDBACK_RETRY_MS: "3000" }, packaged: true }), 300_000);
  assert.equal(desktopFeedbackRetryMs({ env: { OMNIRUSH_FEEDBACK_RETRY_MS: "3000" }, packaged: false }), 3_000);
  assert.equal(desktopFeedbackRetryMs({ env: { OMNIRUSH_FEEDBACK_RETRY_MS: "10" }, packaged: false }), 300_000);
});

test("offer: an eligible turn gets the prompt, once per session and once a day", async () => {
  let now = T0;
  const { d, calls } = desktop({ now: () => now });
  await d.service.refreshPolicy({ force: true });
  assert.equal(calls[0].path, "/client/feedback-policy");
  assert.equal(calls[0].method, "GET");
  assert.deepEqual(await d.offer({ sessionId: "ses_a", ...OK_TURN }), { kind: "turn" });
  assert.equal(await d.offer({ sessionId: "ses_a", ...OK_TURN }), null, "once per session");
  assert.equal(await d.offer({ sessionId: "ses_b", ...OK_TURN }), null, "max_per_day 1");
  now = T0 + DAY;
  await d.service.refreshPolicy({ force: true });
  assert.deepEqual(await d.offer({ sessionId: "ses_b", ...OK_TURN }), { kind: "turn" }, "the next day");
});

test("offer: never after an ineligible turn (no tool and short, refusal, limit, error, stop)", async () => {
  const { d } = desktop();
  await d.service.refreshPolicy({ force: true });
  assert.equal(await d.offer({ sessionId: "ses_1", outcome: "ok", toolCalls: 0, durationMs: 5_000 }), null, "no tool, short");
  assert.equal(await d.offer({ sessionId: "ses_2", ...OK_TURN, text: "I'm sorry, but I can't help with that." }), null, "a refusal in words");
  for (const outcome of ["refused", "limit", "error", "stopped", "weird"]) assert.equal(await d.offer({ sessionId: `ses_${outcome}`, ...OK_TURN, outcome }), null, outcome);
  assert.equal(await d.offer({ sessionId: "bad id!", ...OK_TURN }), null, "a bad session id");
  assert.deepEqual(await d.offer({ sessionId: "ses_long", outcome: "ok", toolCalls: 0, durationMs: 31_000 }), { kind: "turn" }, "no tool but 30 s+");
});

test("offer: disabled, 404 or unreachable policy, OMNIRUSH_FEEDBACK=0 or a dev build: never", async () => {
  for (const [label, opts] of /** @type {Array<[string, any]>} */ ([
    ["disabled", { policy: { ...ON, enabled: false } }],
    ["404", { policy: 404 }],
    ["500", { policy: 500 }],
    ["off switch", { env: { OMNIRUSH_FEEDBACK: "0" } }],
    ["dev build", { env: {}, packaged: false }],
  ])) {
    const { d, calls } = desktop(opts);
    await d.service.refreshPolicy({ force: true });
    assert.equal(await d.offer({ sessionId: "ses_x", ...OK_TURN }), null, label);
    assert.equal(d.status().policy.enabled, false, label);
    if (label === "off switch" || label === "dev build") assert.equal(calls.length, 0, `${label}: the server is not asked`);
  }
});

test("pulse: after pulse_after_sessions sessions, instead of the turn prompt", async () => {
  const { d } = desktop({ policy: { ...ON, pulse_enabled: true, pulse_after_sessions: 2 } });
  await d.service.refreshPolicy({ force: true });
  assert.equal(d.sessionStarted({ sessionId: "ses_p1" }), true);
  assert.equal(d.sessionStarted({ sessionId: "ses_p1" }), false, "counted once");
  assert.deepEqual(await d.offer({ sessionId: "ses_p2", ...OK_TURN }), { kind: "pulse" });
});

test("shown and submitted: analytics labels only, never the comment", async () => {
  const { d, events, calls } = desktop();
  d.shown({ kind: "turn" });
  d.shown({ kind: "pulse" });
  const marker = "MARKER-secret-comment-7f3a";
  const result = await d.submit({ kind: "turn", rating: "down", categories: ["wrong", "slow", "bogus"], comment: marker, sessionId: "ses_abc", turn: 3, trigger: "sampled", modelId: "gpt-6-astra", effort: "high" });
  assert.deepEqual(result, { ok: true, sent: true, queued: false });
  assert.deepEqual(events[0], { name: "feedback_prompt_shown", properties: { kind: "turn", trigger: "sampled" } });
  assert.deepEqual(events[1], { name: "feedback_prompt_shown", properties: { kind: "pulse", trigger: "pulse" } });
  assert.deepEqual(events[2], { name: "feedback_submitted", properties: { kind: "turn", rating_bucket: "down", categories: "wrong+slow", has_comment: true, trigger: "sampled" } });
  assert.ok(!JSON.stringify(events).includes(marker), "no comment text in analytics");
  const post = calls.find((c) => c.path === "/feedback");
  assert.equal(post.method, "POST");
  assert.deepEqual(post.body, {
    kind: "turn", rating: "down", categories: ["wrong", "slow"], comment: marker, session_id: "ses_abc", turn: 3,
    trigger: "sampled", client: "desktop", app_version: "3.6.1", os: "linux", model_id: "gpt-6-astra", effort: "high",
  });
});

test("submit: anytime feedback works whatever the policy, even switched off", async () => {
  const { d, calls } = desktop({ policy: { ...ON, enabled: false }, env: { OMNIRUSH_FEEDBACK: "0" } });
  const result = await d.submit({ kind: "general", rating: null, categories: ["bug"], comment: "The sidebar\nflickers", sessionId: "ses_open", turn: null, trigger: "menu" });
  assert.deepEqual(result, { ok: true, sent: true, queued: false });
  assert.deepEqual(calls.at(-1).body, { kind: "general", rating: null, categories: ["bug"], comment: "The sidebar\nflickers", session_id: "ses_open", turn: null, trigger: "menu", client: "desktop", app_version: "3.6.1", os: "linux", model_id: null, effort: null });
  assert.deepEqual(await d.submit({ kind: "general", categories: ["idea"], comment: "  ", trigger: "command" }), { ok: false, error: "comment" });
});

test("submit: a 404 queues it in feedback.json and stops the prompts; a later 201 drains the queue", async () => {
  let now = T0;
  const { d, server, userDataPath } = desktop({ submit: 404, now: () => now });
  await d.service.refreshPolicy({ force: true });
  const result = await d.submit({ kind: "turn", rating: "up", comment: "nice", sessionId: "ses_q", turn: 1, trigger: "sampled" });
  assert.deepEqual(result, { ok: true, sent: false, queued: true, reason: "unavailable" });
  const saved = JSON.parse(fs.readFileSync(path.join(userDataPath, "feedback.json"), "utf8"));
  assert.equal(saved.spool.length, 1);
  assert.ok(saved.absent_at > 0);
  assert.equal(d.status().unavailable, true);
  assert.equal(await d.offer({ sessionId: "ses_new", ...OK_TURN }), null, "no more prompts while the server has none");
  server.submit = 201;
  now += 10 * 60_000;
  const flushed = await d.service.flush();
  assert.equal(flushed.sent.length, 1);
  assert.equal(d.status().queued, 0);
  assert.equal(d.status().unavailable, false);
  assert.deepEqual(await d.offer({ sessionId: "ses_new", ...OK_TURN }), { kind: "turn" }, "asking again once a send went through");
});

test("submit: offline, signed out and 429 are kept for later with their reason", async () => {
  for (const [submit, reason] of [["offline", "offline"], ["signed_out", "signed_out"], [429, "rate_limited"]]) {
    const { d } = desktop({ submit: /** @type {any} */ (submit) });
    const r = await d.submit({ kind: "pulse", rating: 9, comment: null, trigger: "pulse" });
    assert.deepEqual(r, { ok: true, sent: false, queued: true, reason }, String(submit));
    assert.equal(d.status().queued, 1);
  }
});

test("submit: a 422 names the wrong fields and a 413 is too large; neither is queued", async () => {
  const { d, server } = desktop({ submit: { status: 422, data: { detail: "invalid_feedback", errors: { comment: "too long" } }, retryAfter: null } });
  const r = await d.submit({ kind: "general", categories: ["bug"], comment: "x", trigger: "menu" });
  assert.deepEqual(r, { ok: false, error: "invalid", errors: { comment: "too long" } });
  assert.equal(d.status().queued, 0, "not kept: the person is told");
  server.submit = { status: 413, data: { detail: "feedback_too_large" }, retryAfter: null };
  const big = await d.submit({ kind: "general", categories: ["bug"], comment: "y", trigger: "menu" });
  assert.equal(big.ok, false);
  assert.equal(/** @type {any} */ (big).error, "too_large");
  assert.equal(d.status().queued, 0);
});

test("submit: a 429 waits for its Retry-After", async () => {
  const { d, userDataPath } = desktop({ submit: { status: 429, data: { detail: "feedback_rate_limited" }, retryAfter: 7_200 } });
  const r = await d.submit({ kind: "turn", rating: "up", sessionId: "ses_r", turn: 1, trigger: "sampled" });
  assert.deepEqual(r, { ok: true, sent: false, queued: true, reason: "rate_limited" });
  const saved = JSON.parse(fs.readFileSync(path.join(userDataPath, "feedback.json"), "utf8"));
  assert.equal(saved.spool[0].next_at, T0 + 7_200_000);
});

test("accounts: no offers signed out; queued feedback goes only under the account it was written under", async () => {
  let who = /** @type {string | null} */ (null);
  const { d, calls } = desktop({ accountId: async () => who });
  await d.service.refreshPolicy({ force: true });
  assert.equal(await d.offer({ sessionId: "ses_out", ...OK_TURN }), null, "signed out: never asks on its own");
  assert.deepEqual(await d.submit({ kind: "general", categories: ["idea"], comment: "written signed out", trigger: "menu" }), { ok: true, sent: false, queued: true, reason: "signed_out" });
  who = "acct-a";
  assert.deepEqual(await d.offer({ sessionId: "ses_a1", ...OK_TURN }), { kind: "turn" }, "signed in: asks");
  calls.length = 0;
  await d.service.flush({ force: true });
  assert.equal(calls.filter((c) => c.path === "/feedback").length, 0, "the one written signed out is never sent");
  assert.deepEqual(await d.submit({ kind: "general", categories: ["bug"], comment: "from A", trigger: "menu" }), { ok: true, sent: true, queued: false });
});

test("accounts: an entry queued under A is not sent while B is signed in, and goes once A is back", async () => {
  let who = /** @type {string | null} */ ("acct-a");
  const { d, calls, server } = desktop({ submit: "offline", accountId: async () => who });
  assert.deepEqual(await d.submit({ kind: "general", categories: ["bug"], comment: "A's note", trigger: "menu" }), { ok: true, sent: false, queued: true, reason: "offline" });
  server.submit = 201;
  who = "acct-b";
  await d.submit({ kind: "general", categories: ["idea"], comment: "B's note", trigger: "menu" });
  calls.length = 0;
  await d.service.flush({ force: true });
  assert.ok(calls.every((c) => c.path !== "/feedback" || /** @type {any} */ (c.body).comment !== "A's note"), "A's entry not sent under B");
  who = "acct-a";
  await d.submit({ kind: "general", categories: ["praise"], comment: "A again", trigger: "menu" });
  await d.service.flush({ force: true });
  assert.ok(calls.some((c) => c.path === "/feedback" && /** @type {any} */ (c.body).comment === "A's note"), "sent once A is back");
});

test("Reset app data (nuke) removes the whole data folder, feedback.json with it", () => {
  const userDataPath = "/home/alice/.config/ai.omnirush.desktop";
  const manifest = buildNukeManifest({ env: {}, homedir: "/home/alice", platform: "linux", userDataPath });
  assert.ok(manifest.deletePaths.includes(userDataPath));
});

test("the state lives in the app's data folder (feedback.json), not in any workspace", async () => {
  const { d, userDataPath } = desktop();
  await d.service.refreshPolicy({ force: true });
  await d.offer({ sessionId: "ses_f", ...OK_TURN });
  const saved = JSON.parse(fs.readFileSync(path.join(userDataPath, "feedback.json"), "utf8"));
  assert.deepEqual(saved.asked_sessions, ["ses_f"]);
});

test("wiring: main.mjs handlers, the preload's event channel, the bridge and the renderer's labels", () => {
  const main = fs.readFileSync(path.join(here, "main.mjs"), "utf8");
  for (const name of ["omnirushFeedbackPolicy", "omnirushFeedbackStatus", "omnirushFeedbackSessionStarted", "omnirushFeedbackOffer", "omnirushFeedbackShown", "omnirushFeedbackSubmit"]) {
    assert.match(main, new RegExp(`^  "${name}": async \\(event`, "m"), name);
  }
  assert.match(main, /omnirushAccountStore\.feedbackRequest\(pathAndQuery, init\)/);
  assert.match(main, /desktopFeedback\.start\(\)/);
  assert.match(main, /desktopFeedback\.stop\(\)/);
  const preload = fs.readFileSync(path.join(here, "preload.mjs"), "utf8");
  assert.ok(preload.includes(`ipcRenderer.on("${EVENT_CHANNEL}"`), "the preload passes the analytics events on");
  const renderer = fs.readFileSync(path.join(here, "..", "..", "app", "src", "app", "lib", "in-app-feedback.ts"), "utf8");
  for (const item of [...TURN_REASONS, ...GENERAL_CATEGORIES]) assert.ok(renderer.includes(`{ id: "${item.id}", label: "${item.label}" }`), `${item.id}: ${item.label}`);
  assert.ok(renderer.includes(JSON.stringify(PULSE_QUESTION)));
  assert.ok(renderer.includes(`"${EVENT_CHANNEL}"`));
});

test("account store: feedbackRequest posts feedback to the account server with the device credential (renewed on a 401)", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = new Headers(init.headers);
    seen.push({ method: init.method ?? "GET", path: `${u.pathname}${u.search}`, auth: headers.get("authorization"), type: headers.get("content-type"), body: init.body ?? null, signal: Boolean(init.signal) });
    if (u.pathname.endsWith("/feedback") && headers.get("authorization") === "Bearer access-1") return new Response("", { status: 401 });
    if (u.pathname.includes("/device/token") || u.pathname.includes("/refresh")) {
      return new Response(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.pathname.endsWith("/device/me")) return new Response(JSON.stringify({ id: "3F2504E0-4F89-11D3-9A0C-0305E82C3301", email: "a@example.invalid", status: "active" }), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/feedback") && JSON.parse(String(init.body)).comment === "bad") {
      return new Response(JSON.stringify({ detail: "invalid_feedback", errors: { comment: "too long" } }), { status: 422, headers: { "content-type": "application/json" } });
    }
    if (u.pathname.endsWith("/feedback") && JSON.parse(String(init.body)).comment === "limit") {
      return new Response(JSON.stringify({ detail: "feedback_rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "5400" } });
    }
    if (u.pathname.endsWith("/feedback")) return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(ON), { status: 200, headers: { "content-type": "application/json" } });
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omnirush-feedback-"));
  const store = createDesktopOmniRushAccountStore({
    filePath: path.join(directory, "account.bin"),
    loadSafeStorage: () => ({
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "keychain",
      encryptStringAsync: async (value) => Buffer.from(value, "utf8"),
      decryptStringAsync: async (value) => ({ result: value.toString("utf8"), shouldReEncrypt: false }),
    }),
    platform: /** @type {NodeJS.Platform} */ ("linux"),
    env: { OMNIRUSH_DEV_MODE: "1" },
    sleep: async () => undefined,
    execFileImpl: async (file) => { throw new Error(`unexpected ${file}`); },
    clientVersion: "3.6.1",
    fetchImpl,
  });
  const userDataPath = tmp();
  let now = T0;
  const d = createDesktopFeedback({ request: (p, init) => store.feedbackRequest(p, init), userDataPath, version: "3.6.1", platform: "darwin", env: { OMNIRUSH_FEEDBACK: "1" }, now: () => now });
  const signedOut = await d.submit({ kind: "general", categories: ["idea"], comment: "dark mode for the sidebar", trigger: "command" });
  assert.deepEqual(signedOut, { ok: true, sent: false, queued: true, reason: "signed_out" });
  assert.equal(seen.length, 0, "signed out: nothing asked");
  await store.save({ gatewayUrl: "http://localhost:8090/omnirush/v1", accessToken: "access-1", refreshToken: "refresh-1" });
  const policy = await d.service.refreshPolicy({ force: true });
  assert.equal(policy.enabled, true);
  assert.equal(seen[0].path, "/omnirush/client/feedback-policy");
  const sent = await d.submit({ kind: "turn", rating: "up", comment: null, sessionId: "ses_1", turn: 2, trigger: "sampled" });
  assert.deepEqual(sent, { ok: true, sent: true, queued: false });
  const posts = seen.filter((s) => s.path === "/omnirush/feedback");
  assert.equal(posts[0].auth, "Bearer access-1");
  assert.equal(posts.at(-1).auth, "Bearer access-2", "renewed once after a 401");
  assert.equal(posts.at(-1).type, "application/json");
  assert.equal(JSON.parse(posts.at(-1).body).os, "mac");
  assert.ok(seen.every((s) => s.signal), "always with a timeout");
  now += 2 * 60_000;
  await d.service.flush();
  assert.equal(d.status().queued, 0, "the signed-out one went too, at its retry");
  assert.equal(await store.accountId(), "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "the account from /device/me");
  const refused = await store.feedbackRequest("/feedback", { method: "POST", body: { kind: "general", comment: "bad" } });
  assert.deepEqual(refused, { status: 422, data: { detail: "invalid_feedback", errors: { comment: "too long" } }, retryAfter: null }, "a 422's body is read");
  const limited = await store.feedbackRequest("/feedback", { method: "POST", body: { kind: "general", comment: "limit" } });
  assert.deepEqual(limited, { status: 429, data: { detail: "feedback_rate_limited" }, retryAfter: 5400 }, "Retry-After in seconds");
  assert.deepEqual(await d.submit({ kind: "general", categories: ["bug"], comment: "bad", trigger: "menu" }), { ok: false, error: "invalid", errors: { comment: "too long" } });
});
