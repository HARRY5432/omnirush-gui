// In-app feedback in the desktop app (the main process's side).
//
// The rules live in ./feedback/feedback.mjs (the same file as the CLI's,
// PARITY.sha256 there): the server's policy, when the app may ask after a
// turn (once per session, `max_per_day`, the sample rate, the pulse), the
// payload, the queue in the app's data folder (feedback.json) and the
// sending. Here: the account's authorized call, whether this run may ask on
// its own, and what the window may ask over IPC:
//   omnirushFeedbackPolicy  {}                      → the policy in force
//   omnirushFeedbackOffer   {sessionId, outcome, toolCalls, durationMs, text?}
//                                                    → null | { kind: "turn" | "pulse" }
//   omnirushFeedbackShown   {kind, trigger?}         → analytics only
//   omnirushFeedbackSubmit  {kind, rating, categories, comment, sessionId, turn, trigger, modelId, effort}
//                                                    → { ok, sent, queued, reason? } | { ok: false, error }
//   omnirushFeedbackStatus  {}                      → { policy, queued, unavailable, allowed }
//
// The two analytics events (feedback_prompt_shown, feedback_submitted;
// labels only, never the comment) go to the window (EVENT_CHANNEL), which
// hands them to the app's own analytics.
//
// "Send feedback" always works. The app asks on its own only in an
// interactive, released build: never with OMNIRUSH_FEEDBACK=0, in CI, or in
// a development build (unless OMNIRUSH_FEEDBACK=1, for test rigs). Nothing
// here touches a session's messages, the engine, the model or uploads.

import path from "node:path";

import { createFeedback, looksLikeRefusal, osName, STATE_FILE, TURN_OUTCOMES } from "./feedback/feedback.mjs";

/** Main → window: { name, properties } of one analytics event. */
export const EVENT_CHANNEL = "omnirush:feedback:event";
/** Production retry/refresh interval of the queue (the shared module's default). */
export const RETRY_EVERY_MS = 5 * 60_000;
const OFF = new Set(["0", "false", "no", "off"]);
const ON = new Set(["1", "true", "yes", "on"]);
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function flag(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Whether this run may ask on its own (after a turn, the pulse). Anytime
 * feedback works either way.
 * @param {{ env?: Record<string, string | undefined>, packaged?: boolean, devMode?: boolean }} [input]
 */
export function desktopFeedbackAllowed({ env = process.env, packaged = false, devMode = false } = {}) {
  const value = flag(env.OMNIRUSH_FEEDBACK);
  if (OFF.has(value)) return false;
  if (ON.has(value)) return true;
  const ci = flag(env.CI);
  if (ci && !OFF.has(ci)) return false;
  return packaged === true && devMode !== true;
}

/**
 * The queue's retry interval: 5 minutes; an unpackaged build (test rigs)
 * may shorten it with OMNIRUSH_FEEDBACK_RETRY_MS (at least 1 s).
 * @param {{ env?: Record<string, string | undefined>, packaged?: boolean }} [input]
 */
export function desktopFeedbackRetryMs({ env = process.env, packaged = false } = {}) {
  if (packaged) return RETRY_EVERY_MS;
  const n = Number(env.OMNIRUSH_FEEDBACK_RETRY_MS);
  return Number.isFinite(n) && n >= 1_000 ? Math.floor(n) : RETRY_EVERY_MS;
}

function text(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * @param {{
 *   request: import("./feedback/feedback.mjs").FeedbackRequest,
 *   userDataPath: string,
 *   version?: string,
 *   platform?: string,
 *   env?: Record<string, string | undefined>,
 *   packaged?: boolean,
 *   devMode?: boolean,
 *   emit?: ((name: string, properties: Record<string, unknown>) => void) | null,
 *   now?: () => number,
 *   random?: () => number,
 *   log?: (level: string, message: string, data?: object) => void,
 *   accountId?: (() => Promise<string | null>) | null,
 * }} options
 *
 * `accountId()`: the signed-in account's id, null when signed out. Queued
 * feedback is stamped with it and sent only under that account; the app
 * never asks on its own while signed out.
 */
export function createDesktopFeedback({
  request,
  userDataPath,
  version = "",
  platform = process.platform,
  env = process.env,
  packaged = false,
  devMode = false,
  emit = null,
  now = Date.now,
  random = Math.random,
  log = () => undefined,
  accountId = null,
}) {
  const allowed = desktopFeedbackAllowed({ env, packaged, devMode });
  /** The account last read (the shared module asks synchronously); read again before each offer, send and retry. */
  let account = null;
  async function readAccount() {
    if (typeof accountId !== "function") return account;
    account = await accountId().catch(() => null);
    return account;
  }
  const retryEveryMs = desktopFeedbackRetryMs({ env, packaged });
  let accountTimer = null;
  /** @type {import("./feedback/feedback.mjs").FeedbackOptions} */
  const options = {
    request,
    stateFile: path.join(userDataPath, STATE_FILE),
    client: "desktop",
    version,
    os: osName(platform),
    allowed,
    now,
    random,
    log,
    retryEveryMs,
    ...(typeof accountId === "function" ? { account: () => account } : {}),
    onEvent: (name, properties) => {
      try {
        emit?.(name, properties);
      } catch {
        /* analytics never in the way */
      }
    },
  };
  const service = createFeedback(options);

  return {
    service,
    allowed,
    async start() {
      await readAccount();
      service.start();
      // The queue's own retries see a sign-in or sign-out within one interval.
      if (!accountTimer && typeof accountId === "function") {
        accountTimer = setInterval(() => void readAccount(), Math.min(retryEveryMs, 60_000));
        accountTimer.unref?.();
      }
    },
    stop() {
      if (accountTimer) clearInterval(accountTimer);
      accountTimer = null;
      return service.stop();
    },
    /** IPC omnirushFeedbackPolicy: the policy in force (off when not allowed). */
    policy: () => service.policy(),
    /** IPC omnirushFeedbackStatus. */
    status: () => ({ ...service.status(), allowed }),
    /** IPC omnirushFeedbackSessionStarted {sessionId}: the pulse counts sessions. */
    sessionStarted(input) {
      const sessionId = typeof input?.sessionId === "string" && SESSION_RE.test(input.sessionId) ? input.sessionId : null;
      return sessionId ? service.sessionStarted(sessionId) : false;
    },
    /**
     * IPC omnirushFeedbackOffer: after a finished turn. `text` (the answer's
     * final text, at most 700 characters) is only read here to tell a
     * refusal that came back as an ordinary answer; it is not kept.
     */
    async offer(input) {
      const sessionId = typeof input?.sessionId === "string" && SESSION_RE.test(input.sessionId) ? input.sessionId : null;
      if (!sessionId) return null;
      await readAccount();
      let outcome = typeof input?.outcome === "string" && TURN_OUTCOMES.includes(input.outcome) ? input.outcome : "error";
      if (outcome === "ok" && looksLikeRefusal(text(input?.text, 700))) outcome = "refused";
      try {
        return service.offerAfterTurn({ sessionId, outcome, toolCalls: finite(input?.toolCalls), durationMs: finite(input?.durationMs) });
      } catch {
        return null;
      }
    },
    /** IPC omnirushFeedbackShown {kind, trigger?}: the prompt is on screen. */
    shown(input) {
      const kind = input?.kind === "pulse" ? "pulse" : "turn";
      service.shown(kind, kind === "pulse" ? "pulse" : "sampled");
      return { ok: true };
    },
    /**
     * IPC omnirushFeedbackSubmit: one feedback (always allowed). Never
     * throws: { ok: false, error } when it cannot be sent or kept.
     * @returns {Promise<import("@omnirush/types/desktop-ipc").OmniRushFeedbackResult>}
     */
    async submit(input) {
      const value = input && typeof input === "object" ? input : {};
      await readAccount();
      try {
        return await /** @type {any} */ (service.submit)({
          kind: value.kind,
          rating: value.rating,
          categories: Array.isArray(value.categories) ? value.categories.slice(0, 12) : [],
          comment: text(value.comment, 4_000),
          sessionId: value.sessionId,
          turn: value.turn,
          trigger: value.trigger,
          modelId: value.modelId,
          effort: value.effort,
        });
      } catch {
        return /** @type {any} */ ({ ok: false, error: "failed" });
      }
    },
  };
}
