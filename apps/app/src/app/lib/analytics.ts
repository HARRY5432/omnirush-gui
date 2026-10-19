/**
 * Product analytics for the omnirush.ai desktop app (PostHog, zero-dependency).
 *
 * Principles (mirrors `den-telemetry.ts`):
 * - Never send message content, file paths, code, prompts, e-mail addresses
 *   or names. Only event names, counts, lengths, durations, and coarse
 *   context (app version, OS, workspace type, provider/model id, sandbox
 *   mode). Survey answers are fixed choices only, never free text.
 * - Not anonymous: once signed in, events carry the opaque OmniRush account
 *   id (the `id` from /device/me) as the PostHog distinct id; signing out
 *   resets to a fresh random device id. Before sign-in, that random id.
 * - Always on when the build sets a PostHog key (VITE_OMNIRUSH_POSTHOG_KEY);
 *   there is no in-app opt-out. Without a key nothing is sent.
 * - Fire-and-forget: analytics must never break or slow the app.
 * - Every capture is mirrored into the local app inspector
 *   (`window.__omnirush.record("analytics.<event>")`) so coded evals can
 *   assert instrumentation without any analytics backend.
 */
import { denSessionUpdatedEvent, type DenSessionUpdatedDetail } from "./den-session-events";
import { recordInspectorEvent } from "./app-inspector";
import { resolvePosthogKey } from "./analytics-key";

const ENV_POSTHOG_HOST = String(import.meta.env.VITE_OMNIRUSH_POSTHOG_HOST ?? "").trim();
const ENV_APP_VERSION = String(import.meta.env.VITE_OMNIRUSH_APP_VERSION ?? "").trim();
/** Set by the packaged Electron build (vite.config.ts); empty in `pnpm dev` and other unpackaged builds. */
const ENV_PACKAGED_BUILD = String(import.meta.env.VITE_OMNIRUSH_PACKAGED_BUILD ?? "").trim() === "1";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

// No built-in key: nothing is sent unless the build sets
// VITE_OMNIRUSH_POSTHOG_KEY, and only a packaged release build uses it
// (never a dev build). The inspector mirror still records events locally
// either way.
let posthogKey = resolvePosthogKey(import.meta.env.VITE_OMNIRUSH_POSTHOG_KEY, { appVersion: ENV_APP_VERSION, packaged: ENV_PACKAGED_BUILD });
let posthogHost = (ENV_POSTHOG_HOST || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
let appVersion = ENV_APP_VERSION;

const PREFS_STORAGE_KEY = "omnirush.preferences";
const DISTINCT_ID_STORAGE_KEY = "omnirush.analytics.distinctId";
const ACCOUNT_ID_STORAGE_KEY = "omnirush.analytics.accountId";
const FIRST_RUN_STORAGE_KEY = "omnirush.analytics.firstRun";
const FLUSH_INTERVAL_MS = 10_000;
const MAX_BATCH = 50;

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AnalyticsProperties = Record<string, string | number | boolean | null>;

type QueuedEvent = {
  event: string;
  distinctId: string;
  properties: AnalyticsProperties;
  timestamp: string;
};

let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

// Whether this profile had saved preferences before this process started:
// read at import, before any provider writes its defaults. A first launch
// has none.
const hadPreferencesAtStart = (() => {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(PREFS_STORAGE_KEY) !== null;
  } catch {
    return true;
  }
})();

/** Tests only: set the key, host and version a build would. */
export function configureAnalyticsForTests(config: { key?: string; host?: string; appVersion?: string }) {
  // As a packaged release build would.
  if (config.key !== undefined) posthogKey = resolvePosthogKey(config.key, { appVersion: "1.0.0", packaged: true });
  if (config.host !== undefined) posthogHost = config.host.replace(/\/+$/, "");
  if (config.appVersion !== undefined) appVersion = config.appVersion;
}

/** Whether events leave this computer (a key is set). */
export function isAnalyticsActive(): boolean {
  return Boolean(posthogKey);
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The random device id used before sign-in (and after sign-out). */
export function getAnalyticsDistinctId(): string {
  const store = storage();
  if (!store) return "server";
  try {
    const existing = store.getItem(DISTINCT_ID_STORAGE_KEY)?.trim();
    if (existing) return existing;
    const next = crypto.randomUUID();
    store.setItem(DISTINCT_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return "unknown";
  }
}

/** The signed-in OmniRush account id events are linked to, or null. */
export function getAnalyticsAccountId(): string | null {
  try {
    const value = storage()?.getItem(ACCOUNT_ID_STORAGE_KEY)?.trim() ?? "";
    return ACCOUNT_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

function currentDistinctId(): string {
  return getAnalyticsAccountId() ?? getAnalyticsDistinctId();
}

/** "macos" | "windows" | "linux" | "other": the OS family, nothing finer. */
export function analyticsOs(platform: string | null | undefined): string {
  const value = (platform ?? "").toLowerCase();
  if (value.startsWith("mac") || value === "darwin") return "macos";
  if (value.startsWith("win")) return "windows";
  if (value.includes("linux") || value.includes("x11")) return "linux";
  return "other";
}

function baseProperties(): AnalyticsProperties {
  const platform = typeof navigator === "undefined" ? null : navigator.platform || null;
  return {
    client: "desktop",
    app_version: appVersion || null,
    platform,
    os: analyticsOs(platform),
  };
}

function enqueue(event: string, distinctId: string, properties: AnalyticsProperties) {
  queue.push({
    event,
    distinctId,
    properties: { ...baseProperties(), ...properties },
    timestamp: new Date().toISOString(),
  });
  if (queue.length >= MAX_BATCH) void flushAnalytics();
}

/**
 * Queue an analytics event. Always mirrored to the local inspector; only
 * sent over the network when a key is configured.
 */
export function captureAnalyticsEvent(event: string, properties: AnalyticsProperties = {}) {
  try {
    recordInspectorEvent(`analytics.${event}`, properties);
  } catch {
    // Inspector unavailable (non-browser context).
  }
  if (!posthogKey) return;
  enqueue(event, currentDistinctId(), properties);
}

/**
 * Link this device to the signed-in OmniRush account (its opaque UUID, never
 * an e-mail or name). Sends `$identify` once per account; later events use
 * the account id as their distinct id.
 */
export function identifyAnalyticsAccount(accountId: string | null | undefined): boolean {
  const id = accountId?.trim() ?? "";
  if (!ACCOUNT_ID.test(id)) return false;
  if (getAnalyticsAccountId() === id) return false;
  const anonymous = getAnalyticsDistinctId();
  try {
    storage()?.setItem(ACCOUNT_ID_STORAGE_KEY, id);
  } catch {
    // Storage unavailable: the identify below still links this run.
  }
  try {
    recordInspectorEvent("analytics.$identify", {});
  } catch {
    // Inspector unavailable.
  }
  if (posthogKey) enqueue("$identify", id, { $anon_distinct_id: anonymous });
  return true;
}

/** Sign-out: forget the account and start over with a new random device id. */
export function resetAnalyticsAccount(): boolean {
  const store = storage();
  const had = getAnalyticsAccountId() !== null;
  try {
    store?.removeItem(ACCOUNT_ID_STORAGE_KEY);
    store?.setItem(DISTINCT_ID_STORAGE_KEY, crypto.randomUUID());
  } catch {
    // Storage unavailable.
  }
  if (had) {
    try {
      recordInspectorEvent("analytics.$reset", {});
    } catch {
      // Inspector unavailable.
    }
  }
  return had;
}

/**
 * Follow the account status (/device/me): identify when signed in with an
 * account id, reset when the app is signed out.
 */
export function syncAnalyticsAccount(status: { connected: boolean; accountId?: string | null } | null | undefined) {
  if (!status) return;
  if (status.connected) {
    if (status.accountId) identifyAnalyticsAccount(status.accountId);
    return;
  }
  if (getAnalyticsAccountId() !== null) resetAnalyticsAccount();
}

export async function flushAnalytics(): Promise<void> {
  if (queue.length === 0 || !posthogKey) return;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    await fetch(`${posthogHost}/batch/`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: posthogKey,
        batch: batch.map((entry) => ({
          event: entry.event,
          distinct_id: entry.distinctId,
          timestamp: entry.timestamp,
          properties: entry.properties,
        })),
      }),
    });
  } catch {
    // Network failure — drop silently. Analytics must never surface errors.
  }
}

/** The onboarding survey's event: the chosen source and the answer's length, never the free text. */
export function attributionSurveyProperties(source: string, aiPrompt?: string | null): AnalyticsProperties {
  return { source, ai_prompt_length: aiPrompt?.trim().slice(0, 500).length ?? 0 };
}

// Task run duration tracking: sendDraft marks the start, the session.idle
// sync event takes it. Also acts as a dedupe guard so idle events that do
// not correspond to an instrumented run (or arrive from a second workspace
// sync) emit nothing.
const taskRunStarts = new Map<string, number>();

// The last prompt this window sent per session (kept after the run ends):
// in-app feedback only asks about turns a person started here, never about
// Workflows, automations or sub-agents.
const promptsSentHere = new Map<string, number>();

export function markTaskRunStart(sessionId: string) {
  if (!sessionId.trim()) return;
  taskRunStarts.set(sessionId, Date.now());
  promptsSentHere.set(sessionId, Date.now());
}

/** When this window last sent a prompt to `sessionId` (ms), or null. */
export function promptSentHereAt(sessionId: string): number | null {
  return promptsSentHere.get(sessionId) ?? null;
}

export function takeTaskRunStart(sessionId: string): number | null {
  const startedAt = taskRunStarts.get(sessionId);
  if (startedAt === undefined) return null;
  taskRunStarts.delete(sessionId);
  return startedAt;
}

/**
 * `first_run` once per profile: a profile that had no saved preferences when
 * the app started. Profiles from earlier versions are marked without an event.
 */
export function captureFirstRunOnce(hadPreferences = hadPreferencesAtStart): boolean {
  const store = storage();
  if (!store) return false;
  try {
    if (store.getItem(FIRST_RUN_STORAGE_KEY)) return false;
    store.setItem(FIRST_RUN_STORAGE_KEY, new Date().toISOString());
  } catch {
    return false;
  }
  if (hadPreferences) return false;
  captureAnalyticsEvent("first_run", {});
  return true;
}

/**
 * One-time setup: flush loop, unload flush, first run, and the Den cloud
 * sign-in listener. Mounted from AppRoot.
 */
export function initAnalytics() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  flushTimer = setInterval(() => void flushAnalytics(), FLUSH_INTERVAL_MS);

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushAnalytics();
  });

  captureFirstRunOnce();

  // A Den (organization cloud) sign-in: counted, but the distinct id stays
  // the OmniRush account id (identifyAnalyticsAccount), never a Den user id.
  window.addEventListener(denSessionUpdatedEvent, ((event: CustomEvent<DenSessionUpdatedDetail>) => {
    if (event.detail?.status !== "success") return;
    captureAnalyticsEvent("cloud_signed_in", {});
  }) as EventListener);
}

export function disposeAnalytics() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  initialized = false;
  queue = [];
}
