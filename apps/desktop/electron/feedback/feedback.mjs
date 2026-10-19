// In-app feedback: the rules both apps share. The same file ships in
// omnirush-cli (assets/extensions/omnirush/feedback/) and omnirush-gui
// (apps/desktop/electron/feedback/); both list it in PARITY.sha256 there.
//
// Three ways in:
//   - after a turn (sampled): one quiet "How was this?" after a finished,
//     eligible turn. Eligible = it finished normally (not a refusal, a spent
//     allowance or an error) and ran at least one tool or 30 s. At most once
//     per session and `max_per_day` per local day, on `turn_sample_rate` of
//     the eligible turns;
//   - the pulse (0-10): instead of the after-turn prompt, once the app saw
//     `pulse_after_sessions` sessions, then at most every `pulse_every_days`;
//   - anytime (the person asks: /feedback, "Send feedback"): always
//     available, whatever the policy says.
//
// The server decides whether the app asks at all (GET
// /client/feedback-policy). Anything but a usable answer with `enabled: true`
// (a 404, an error, a 2 s timeout, a malformed answer, a cached answer older
// than a day) means the app never asks on its own. The answer is cached in
// the app's data folder and asked again after an hour; start-up never waits
// for it.
//
// Sending: POST /feedback with the fields of the contract and nothing else.
// What is sent is queued first in the same file and sent from there (a small
// spool: 50 entries, each dropped after 7 days), so offline, signed out, a 429
// or a 5xx keep it for later. A 404 (the server has no feedback yet) keeps it
// too and the app stops asking on its own until a queued send goes through.
// A 2xx or a 4xx that is final (400, 413, 422) removes it.
//
// Nothing here touches sessions, prompts, the model, files or uploads, and
// the comment never goes to analytics (analyticsProperties). Node builtins
// only; the transport (`request`) is the app's own authorized call.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const POLICY_PATH = "/client/feedback-policy";
export const SUBMIT_PATH = "/feedback";
export const STATE_FILE = "feedback.json";
export const KINDS = Object.freeze(["turn", "general", "pulse"]);
export const TRIGGERS = Object.freeze(["sampled", "command", "menu", "pulse"]);
export const CLIENTS = Object.freeze(["cli", "desktop", "web"]);
/** After a 👎: what went wrong (the server's category ids). */
export const TURN_REASONS = Object.freeze([
  Object.freeze({ id: "wrong", label: "Wrong" }),
  Object.freeze({ id: "slow", label: "Too slow" }),
  Object.freeze({ id: "instructions", label: "Didn't follow instructions" }),
  Object.freeze({ id: "broke", label: "Broke something" }),
  Object.freeze({ id: "ui", label: "UI problem" }),
  Object.freeze({ id: "other", label: "Other" }),
]);
/** Anytime feedback: its category. */
export const GENERAL_CATEGORIES = Object.freeze([
  Object.freeze({ id: "bug", label: "Bug" }),
  Object.freeze({ id: "idea", label: "Idea" }),
  Object.freeze({ id: "praise", label: "Praise" }),
  Object.freeze({ id: "other", label: "Other" }),
]);
export const CATEGORY_IDS = Object.freeze(["wrong", "slow", "instructions", "broke", "ui", "other", "bug", "idea", "praise"]);
export const COMMENT_MAX = 1_000;
export const PULSE_QUESTION = "How likely are you to recommend OmniRush to a friend?";
export const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  turnSampleRate: 0.125,
  maxPerDay: 1,
  pulseEnabled: false,
  pulseAfterSessions: 5,
  pulseEveryDays: 30,
});
/** An eligible turn ran at least this long, or used a tool. */
export const ELIGIBLE_MIN_MS = 30_000;
export const FETCH_TIMEOUT_MS = 2_000;
export const SUBMIT_TIMEOUT_MS = 5_000;
export const POLICY_REFRESH_MS = 3_600_000;
/** A cached policy older than this (no fresh one since) means off. */
export const POLICY_MAX_AGE_MS = 24 * 3_600_000;
export const SPOOL_MAX = 50;
export const SPOOL_MAX_AGE_MS = 7 * 86_400_000;
/** First retry after a failed send (or the retry interval, if shorter), doubled per try up to RETRY_MAX_MS. */
export const RETRY_MIN_MS = 60_000;
export const RETRY_MAX_MS = 6 * 3_600_000;
/** After a 429: the next try. After a 404: at most this long too. */
export const RATE_LIMIT_RETRY_MS = 3_600_000;
/** While one send is out, the entry is not due for anyone else (another window or terminal). */
export const IN_FLIGHT_MS = SUBMIT_TIMEOUT_MS + 15_000;
/** The state file's lock: waited for this long at most, taken over when older than LOCK_STALE_MS. */
export const LOCK_WAIT_MS = 300;
export const LOCK_STALE_MS = 3_000;
/** Sessions remembered (once-per-session, the pulse's count), the newest. */
export const MAX_SESSIONS = 500;
const DAY_MS = 86_400_000;
const STATE_VERSION = 1;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const LABEL_RE = /^[A-Za-z0-9._:/@+-]{1,80}$/;

// --- policy -----------------------------------------------------------------

function num(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return NaN;
}

function intIn(value, min, max, fallback) {
  const n = num(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * The server's policy, checked and clamped, or null when it is not an answer.
 * Off unless `enabled` is exactly true; the pulse off unless `pulse_enabled`
 * is exactly true.
 */
export function parsePolicy(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const rate = num(body.turn_sample_rate);
  return {
    enabled: body.enabled === true,
    turnSampleRate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : DEFAULT_POLICY.turnSampleRate,
    maxPerDay: intIn(body.max_per_day, 0, 10, DEFAULT_POLICY.maxPerDay),
    pulseEnabled: body.pulse_enabled === true,
    pulseAfterSessions: intIn(body.pulse_after_sessions, 1, 1_000, DEFAULT_POLICY.pulseAfterSessions),
    pulseEveryDays: intIn(body.pulse_every_days, 1, 365, DEFAULT_POLICY.pulseEveryDays),
  };
}

// --- turns ------------------------------------------------------------------

/** Refusal / limit / error outcomes never get the after-turn prompt. */
export const TURN_OUTCOMES = Object.freeze(["ok", "refused", "limit", "error", "stopped"]);

/**
 * Whether a finished turn may get the after-turn prompt: it finished
 * normally (`outcome` "ok") and used at least one tool or ran 30 s.
 */
export function turnEligible({ outcome, toolCalls = 0, durationMs = 0 } = {}) {
  if (outcome !== "ok") return false;
  return (Number.isFinite(toolCalls) && toolCalls >= 1) || (Number.isFinite(durationMs) && durationMs >= ELIGIBLE_MIN_MS);
}

const REFUSAL_START = /^\s*(?:i['’]m sorry|i am sorry|sorry,? (?:but )?i can(?:no|['’])t|i can(?:no|['’])t (?:help|assist|do that|comply)|i won['’]t be able|i['’]m (?:not able|unable) to (?:help|assist))/i;

/** A short answer that opens like a refusal ("I'm sorry, but I can't…"). */
export function looksLikeRefusal(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 600 && REFUSAL_START.test(trimmed);
}

// --- payload ----------------------------------------------------------------

// Control characters (except newline and tab in anytime feedback), bidi
// overrides and zero-width marks never leave the app.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** The comment as sent: trimmed, at most COMMENT_MAX characters; one line unless `multiline`; null when empty. */
export function cleanComment(value, { multiline = false } = {}) {
  if (typeof value !== "string") return null;
  let text = value.replace(/\r\n?/g, "\n").replace(UNSAFE_CHARS, " ");
  text = multiline ? text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n") : text.replace(/\s+/g, " ");
  text = text.trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length <= COMMENT_MAX ? text : chars.slice(0, COMMENT_MAX).join("").trimEnd();
}

function label(value) {
  return typeof value === "string" && LABEL_RE.test(value.trim()) ? value.trim() : null;
}

/** "0-10 pulse" bucket: promoter (9-10), passive (7-8), detractor (0-6). */
export function npsBucket(score) {
  if (!Number.isInteger(score) || score < 0 || score > 10) return null;
  return score >= 9 ? "promoter" : score >= 7 ? "passive" : "detractor";
}

/**
 * The POST body of one feedback, or { error } when it cannot be sent. Input
 * (camelCase): kind, rating, categories, comment, sessionId, turn, trigger,
 * modelId, effort; `ctx`: client, appVersion, os.
 */
export function buildPayload(input = {}, ctx = {}) {
  const kind = KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) return { error: "kind" };
  let rating = null;
  if (kind === "turn") {
    if (input.rating !== "up" && input.rating !== "down") return { error: "rating" };
    rating = input.rating;
  } else if (kind === "pulse") {
    if (!Number.isInteger(input.rating) || input.rating < 0 || input.rating > 10) return { error: "rating" };
    rating = input.rating;
  }
  const allowed = kind === "turn" ? (rating === "down" ? TURN_REASONS.map((r) => r.id) : []) : kind === "general" ? GENERAL_CATEGORIES.map((c) => c.id) : [];
  const categories = [];
  for (const id of Array.isArray(input.categories) ? input.categories : []) {
    if (allowed.includes(id) && !categories.includes(id)) categories.push(id);
  }
  const comment = cleanComment(input.comment, { multiline: kind === "general" });
  if (kind === "general" && !comment) return { error: "comment" };
  const trigger = TRIGGERS.includes(input.trigger) ? input.trigger : kind === "turn" ? "sampled" : kind === "pulse" ? "pulse" : "command";
  const sessionId = typeof input.sessionId === "string" && SESSION_RE.test(input.sessionId) ? input.sessionId : null;
  const turn = Number.isInteger(input.turn) && input.turn >= 1 && input.turn <= 100_000 ? input.turn : null;
  const client = CLIENTS.includes(ctx.client) ? ctx.client : "cli";
  return {
    payload: {
      kind,
      rating,
      categories,
      comment,
      session_id: sessionId,
      turn: sessionId ? turn : null,
      trigger,
      client,
      app_version: label(ctx.appVersion) ?? "0",
      os: ["win", "mac", "linux"].includes(ctx.os) ? ctx.os : osName(),
      model_id: label(input.modelId),
      effort: label(input.effort),
    },
  };
}

/**
 * The analytics properties of a sent feedback: labels only, never the
 * comment (only whether there was one).
 */
export function analyticsProperties(payload) {
  const bucket = payload?.kind === "pulse" ? npsBucket(payload.rating) : payload?.rating === "up" || payload?.rating === "down" ? payload.rating : null;
  const categories = Array.isArray(payload?.categories) ? payload.categories.filter((c) => CATEGORY_IDS.includes(c)) : [];
  return {
    kind: KINDS.includes(payload?.kind) ? payload.kind : "general",
    rating_bucket: bucket,
    categories: categories.length ? categories.join("+") : null,
    has_comment: typeof payload?.comment === "string" && payload.comment.length > 0,
    trigger: TRIGGERS.includes(payload?.trigger) ? payload.trigger : null,
  };
}

// --- state ------------------------------------------------------------------

/**
 * The `os` the server sees: win, mac or linux.
 * @param {string} [platform]
 */
export function osName(platform = process.platform) {
  if (platform === "win32") return "win";
  if (platform === "darwin") return "mac";
  return "linux";
}

/** The local calendar day of `ms` (YYYY-MM-DD). */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function emptyState() {
  return {
    v: STATE_VERSION,
    policy: null,
    policy_at: 0,
    /** The send endpoint answered 404 at this time (0: not seen). */
    absent_at: 0,
    /** Prompts shown on `day` (after-turn and pulse together). */
    asked: { day: "", count: 0 },
    /** Sessions that got a prompt (once per session). */
    asked_sessions: [],
    /** Sessions seen (the pulse's count) and how many in total. */
    sessions: [],
    session_count: 0,
    pulse_at: 0,
    spool: [],
  };
}

function strings(value, max) {
  return Array.isArray(value) ? value.filter((s) => typeof s === "string" && SESSION_RE.test(s)).slice(-max) : [];
}

function validEntry(e) {
  return Boolean(e) && typeof e === "object" && typeof e.id === "string" && Number.isFinite(e.at) && e.payload && typeof e.payload === "object" && KINDS.includes(e.payload.kind);
}

export function readState(file) {
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    data = null;
  }
  const base = emptyState();
  if (!data || typeof data !== "object" || Array.isArray(data) || data.v !== STATE_VERSION) return base;
  const asked = data.asked && typeof data.asked === "object" ? data.asked : {};
  return {
    ...base,
    policy: parsePolicyState(data.policy),
    policy_at: Number.isFinite(data.policy_at) ? data.policy_at : 0,
    absent_at: Number.isFinite(data.absent_at) ? data.absent_at : 0,
    asked: { day: typeof asked.day === "string" ? asked.day : "", count: Number.isFinite(asked.count) ? Math.max(0, Math.floor(asked.count)) : 0 },
    asked_sessions: strings(data.asked_sessions, MAX_SESSIONS),
    sessions: strings(data.sessions, MAX_SESSIONS),
    session_count: Number.isFinite(data.session_count) ? Math.max(0, Math.floor(data.session_count)) : 0,
    pulse_at: Number.isFinite(data.pulse_at) ? data.pulse_at : 0,
    spool: Array.isArray(data.spool) ? data.spool.filter(validEntry).slice(-SPOOL_MAX) : [],
  };
}

function parsePolicyState(value) {
  if (!value || typeof value !== "object") return null;
  return parsePolicy({
    enabled: value.enabled,
    turn_sample_rate: value.turnSampleRate,
    max_per_day: value.maxPerDay,
    pulse_enabled: value.pulseEnabled,
    pulse_after_sessions: value.pulseAfterSessions,
    pulse_every_days: value.pulseEveryDays,
  });
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no Atomics.wait: try again at once */
  }
}

/**
 * Runs `fn` holding `<file>.lock` (O_EXCL), so two apps changing the file at
 * once do not lose each other's change. Never blocks for long: after
 * LOCK_WAIT_MS (or with a lock older than LOCK_STALE_MS, left by a crash) it
 * goes ahead anyway.
 */
export function withLock(file, fn) {
  const lock = `${file}.lock`;
  let fd = null;
  const until = Date.now() + LOCK_WAIT_MS;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    /* the write reports it */
  }
  while (fd === null) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") break;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch {
        /* gone meanwhile */
      }
      if (Date.now() >= until) break;
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
        fs.rmSync(lock, { force: true });
      } catch {
        /* left: stale after LOCK_STALE_MS */
      }
    }
  }
}

export function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// --- the app's feedback -----------------------------------------------------

/**
 * @typedef {(pathAndQuery: string, init: { method?: string, body?: unknown, timeoutMs: number }) => Promise<{ status: number, data: unknown } | null>} FeedbackRequest
 */

/**
 * The app's feedback. `request(pathAndQuery, { method, body, timeoutMs })`
 * is the app's authorized call; it resolves { status, data }, or null when
 * signed out. `allowed`: whether the app may ask on its own in this run (an
 * interactive window or terminal, not headless, CI or switched off); anytime
 * feedback works either way. `onEvent(name, properties)`: the app's
 * analytics (feedback_prompt_shown, feedback_submitted), labels only.
 */
export function createFeedback({
  request,
  stateFile,
  client = "cli",
  version = "",
  os = osName(),
  allowed = true,
  now = Date.now,
  random = Math.random,
  onEvent = null,
  log = () => undefined,
  retryEveryMs = 5 * 60_000,
} = {}) {
  const ctx = { client, appVersion: version, os };
  let fetching = null;
  let flushing = null;
  let timer = null;
  let stopped = false;
  const sentHere = new Set();
  // The first retry: a minute, or the retry interval when that is shorter (a test rig's).
  const retryMinMs = retryEveryMs > 0 ? Math.min(RETRY_MIN_MS, retryEveryMs) : RETRY_MIN_MS;

  // Every change starts from the file (another window or terminal may have written it).
  const read = () => readState(stateFile);
  const mutate = (fn) =>
    withLock(stateFile, () => {
      const state = read();
      const result = fn(state);
      writeState(stateFile, state);
      return result;
    });
  const emit = (name, properties) => {
    try {
      onEvent?.(name, properties);
    } catch {
      /* analytics never in the way */
    }
  };

  /** The policy in force: off when not allowed, not fetched, stale, or while the server has no feedback. */
  function policy(state = read()) {
    const at = now();
    if (!allowed || !state.policy || at - state.policy_at > POLICY_MAX_AGE_MS) return { ...DEFAULT_POLICY };
    // The send endpoint answered 404: never ask until a send works (what was
    // queued is tried again every few minutes; the flag goes with the last entry).
    if (state.absent_at) return { ...DEFAULT_POLICY };
    return { ...state.policy };
  }

  async function refreshPolicy({ force = false } = {}) {
    if (!allowed || typeof request !== "function") return policy();
    if (fetching) return fetching;
    const state = read();
    if (!force && state.policy && now() - state.policy_at < POLICY_REFRESH_MS) return policy(state);
    fetching = (async () => {
      let result = null;
      try {
        result = await request(POLICY_PATH, { method: "GET", timeoutMs: FETCH_TIMEOUT_MS });
      } catch (error) {
        log("debug", "feedback policy: not reachable", { error: error instanceof Error ? error.message : String(error) });
      }
      const parsed = result?.status === 200 ? parsePolicy(result.data) : null;
      if (parsed) {
        // The server answers: what is queued is tried now (it may have been waiting for a deploy).
        const queued = mutate((s) => {
          s.policy = parsed;
          s.policy_at = now();
          for (const e of s.spool) e.next_at = Math.min(e.next_at ?? 0, now());
          return s.spool.length;
        });
        if (queued) void flush().catch(() => undefined);
      } else if (result && result.status === 404) {
        // No feedback on this server (yet): off, asked again in an hour.
        mutate((s) => {
          s.policy = { ...DEFAULT_POLICY };
          s.policy_at = now();
        });
      }
      return policy();
    })().finally(() => {
      fetching = null;
    });
    return fetching;
  }

  /** A session this app started or opened (the pulse counts them). */
  function sessionStarted(sessionId) {
    if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return false;
    return mutate((s) => {
      if (s.sessions.includes(sessionId)) return false;
      s.sessions = [...s.sessions, sessionId].slice(-MAX_SESSIONS);
      s.session_count += 1;
      return true;
    });
  }

  /**
   * After a finished turn: null, or { kind: "turn" | "pulse" } when the app
   * should ask now (then counted: this session and today are used up).
   * `turn`: { sessionId, outcome, toolCalls, durationMs }.
   */
  function offerAfterTurn(turn = {}) {
    const sessionId = typeof turn.sessionId === "string" && SESSION_RE.test(turn.sessionId) ? turn.sessionId : null;
    if (!allowed || !sessionId || !turnEligible(turn)) return null;
    return mutate((s) => {
      const p = policy(s);
      if (!p.enabled || p.maxPerDay < 1) return null;
      if (s.asked_sessions.includes(sessionId)) return null;
      const day = localDay(now());
      const count = s.asked.day === day ? s.asked.count : 0;
      if (count >= p.maxPerDay) return null;
      if (!s.sessions.includes(sessionId)) {
        s.sessions = [...s.sessions, sessionId].slice(-MAX_SESSIONS);
        s.session_count += 1;
      }
      let kind = null;
      if (p.pulseEnabled && s.session_count >= p.pulseAfterSessions && now() - s.pulse_at >= p.pulseEveryDays * DAY_MS) kind = "pulse";
      else if (p.turnSampleRate > 0 && random() < p.turnSampleRate) kind = "turn";
      if (!kind) return null;
      s.asked = { day, count: count + 1 };
      s.asked_sessions = [...s.asked_sessions, sessionId].slice(-MAX_SESSIONS);
      if (kind === "pulse") s.pulse_at = now();
      return { kind };
    });
  }

  /** The prompt is on screen (analytics only). */
  function shown(kind, trigger = kind === "pulse" ? "pulse" : "sampled") {
    emit("feedback_prompt_shown", { kind: KINDS.includes(kind) ? kind : "turn", trigger: TRIGGERS.includes(trigger) ? trigger : "sampled" });
  }

  /**
   * Send one feedback (queued first). Resolves { ok: true, sent, queued,
   * reason? } or { ok: false, error } when the input cannot be sent.
   * `reason` when queued: offline | signed_out | unavailable | rate_limited.
   */
  async function submit(input = {}) {
    const built = buildPayload(input, ctx);
    if (built.error) return { ok: false, error: built.error };
    const entry = { id: randomUUID(), at: now(), tries: 0, next_at: 0, sending_until: 0, payload: built.payload };
    mutate((s) => {
      s.spool = [...s.spool, entry].slice(-SPOOL_MAX);
    });
    emit("feedback_submitted", analyticsProperties(built.payload));
    const outcome = await flush({ only: entry.id });
    // Sent here, or by a send that was already running when this one came.
    const sent = outcome.sent.includes(entry.id) || (sentHere.has(entry.id) && !read().spool.some((e) => e.id === entry.id));
    return sent ? { ok: true, sent: true, queued: false } : { ok: true, sent: false, queued: outcome.kept.includes(entry.id), reason: outcome.reasons[entry.id] ?? "offline" };
  }

  /** Send what is queued and due (or just `only`; `force`: also what waits for its retry, the person asked). */
  async function flush({ only = null, force = false } = {}) {
    if (flushing) {
      await flushing.catch(() => undefined);
      if (!only) return { sent: [], kept: [], reasons: {} };
    }
    const run = (async () => {
      const result = { sent: [], kept: [], reasons: {} };
      if (typeof request !== "function") return result;
      const at = now();
      const due = mutate((s) => {
        s.spool = s.spool.filter((e) => at - e.at <= SPOOL_MAX_AGE_MS);
        if (!s.spool.length) s.absent_at = 0;
        const picked = s.spool.filter((e) => (only ? e.id === only : true) && (e.sending_until ?? 0) <= at && (force || (e.next_at ?? 0) <= at));
        // Out now: nobody else sends these meanwhile.
        for (const e of picked) e.sending_until = at + IN_FLIGHT_MS;
        return picked.map((e) => ({ ...e }));
      });
      for (const entry of due) {
        if (stopped && !only) break;
        let answer = null;
        let failed = false;
        try {
          answer = await request(SUBMIT_PATH, { method: "POST", body: entry.payload, timeoutMs: SUBMIT_TIMEOUT_MS });
        } catch {
          failed = true;
        }
        const status = answer?.status ?? 0;
        const done = status >= 200 && status < 300;
        const final = status === 400 || status === 413 || status === 422;
        let reason = "offline";
        if (!failed && !answer) reason = "signed_out";
        else if (status === 401 || status === 403) reason = "signed_out";
        else if (status === 404) reason = "unavailable";
        else if (status === 429) reason = "rate_limited";
        if (final) log("warn", "feedback: the server refused one", { status });
        mutate((s) => {
          if (done || final) {
            s.spool = s.spool.filter((e) => e.id !== entry.id);
            if (done) s.absent_at = 0;
            return;
          }
          if (status === 404) s.absent_at = now();
          const kept = s.spool.find((e) => e.id === entry.id);
          if (!kept) return;
          kept.sending_until = 0;
          kept.tries = (kept.tries ?? 0) + 1;
          const backoff = Math.min(RETRY_MAX_MS, retryMinMs * 2 ** Math.min(12, kept.tries - 1));
          kept.next_at = now() + (status === 429 ? RATE_LIMIT_RETRY_MS : status === 404 ? Math.min(RATE_LIMIT_RETRY_MS, backoff) : backoff);
        });
        if (done) {
          result.sent.push(entry.id);
          sentHere.add(entry.id);
          if (sentHere.size > 200) sentHere.delete(sentHere.values().next().value);
        }
        else if (!final) {
          result.kept.push(entry.id);
          result.reasons[entry.id] = reason;
        }
        // The server has none or says not now: the rest waits too.
        if (status === 404 || status === 429) break;
      }
      return result;
    })();
    if (!only) flushing = run;
    try {
      return await run;
    } finally {
      if (flushing === run) flushing = null;
    }
  }

  function status() {
    const state = read();
    return { policy: policy(state), queued: state.spool.length, unavailable: Boolean(state.absent_at) };
  }

  return {
    /** Ask for the policy and send what is queued, in the background. */
    start() {
      stopped = false;
      void refreshPolicy().catch(() => undefined);
      void flush().catch(() => undefined);
      if (!timer && retryEveryMs > 0) {
        timer = setInterval(() => {
          void refreshPolicy().catch(() => undefined);
          void flush().catch(() => undefined);
        }, retryEveryMs);
        timer.unref?.();
      }
    },
    /** Stop the timer; one last bounded send of what is due. */
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      stopped = true;
      await flushing?.catch(() => undefined);
    },
    policy: () => policy(),
    refreshPolicy,
    sessionStarted,
    offerAfterTurn,
    shown,
    submit,
    flush,
    status,
    allowed: () => allowed,
  };
}
