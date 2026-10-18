import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let sentry = null;
let initialized = false;
// Reports leave only while signed in to a Den (session) and while the user's
// "Share anonymous usage" setting is on (consent, reported by the renderer).
let sessionActive = false;
let consentGranted = false;
let telemetryActive = false;
const __dirname = dirname(fileURLToPath(import.meta.url));

function updateTelemetryActive() {
  telemetryActive = sessionActive && consentGranted;
}

const FILTERED = "[Filtered]";
const SENSITIVE_KEY = /authorization|cookie|token|secret|passw(or)?d|api[-_]?key|credential|grant|session[-_]?id|signature|private[-_]?key/i;
/** @type {Array<[RegExp, string]>} */
const SECRET_PATTERNS = [
  // HTTP auth schemes and header-style assignments.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${FILTERED}`],
  [/\b(authorization|cookie|x-api-key|api[-_]?key)(["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, `$1$2${FILTERED}`],
  // Credentials in URLs: userinfo and secret-bearing query parameters.
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${FILTERED}@`],
  [/([?&#](?:access_token|token|grant|code|key|secret|password|signature|sig|auth|apikey|api_key)=)[^&#\s"']+/gi, `$1${FILTERED}`],
  // Well-known token shapes.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, FILTERED],
  [/\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|cpa-[A-Za-z0-9_-]{16,})/g, FILTERED],
  // E-mail addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} home
 * @returns {Array<[RegExp, string]>}
 */
function homePathPatterns(home) {
  /** @type {Array<[RegExp, string]>} */
  const patterns = [];
  const value = String(home ?? "").replace(/[\\/]+$/, "");
  if (value.length > 1) {
    // The same home written with either separator (file URLs, JSON escapes).
    const flexible = value.split(/[\\/]+/).map(escapeRegExp).join("[\\\\/]+");
    patterns.push([new RegExp(flexible, "gi"), "~"]);
  }
  // Other users' homes and paths seen through a different mount.
  patterns.push([/(^|[\s"'(=:]|file:\/\/\/?)(?:[A-Za-z]:)?[\\/]+(?:Users|home)[\\/]+[^\\/\s"'):]+/gi, "$1~"]);
  return patterns;
}

/**
 * Removes tokens, credentials, e-mail addresses and home-directory paths
 * (which carry the OS user name) from report text.
 * @param {string} value
 * @param {string} [home]
 */
export function scrubSentryText(value, home = homedir()) {
  let text = String(value);
  for (const [pattern, replacement] of [...SECRET_PATTERNS, ...homePathPatterns(home)]) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/**
 * Deep copy of a Sentry event or breadcrumb with secrets scrubbed. Values
 * under credential-like keys are dropped entirely.
 * @template T
 * @param {T} value
 * @param {string} [home]
 * @returns {T}
 */
export function scrubSentryPayload(value, home = homedir(), depth = 0) {
  if (typeof value === "string") return /** @type {T} */ (scrubSentryText(value, home));
  if (!value || typeof value !== "object" || depth > 12) return value;
  if (Array.isArray(value)) return /** @type {T} */ (value.map((item) => scrubSentryPayload(item, home, depth + 1)));
  /** @type {Record<string, unknown>} */
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) && entry !== null && entry !== undefined ? FILTERED : scrubSentryPayload(entry, home, depth + 1);
  }
  return /** @type {T} */ (output);
}

/**
 * @template {object} T
 * @param {T} event
 * @returns {T}
 */
export function scrubSentryEvent(event) {
  const scrubbed = scrubSentryPayload(event);
  const fields = /** @type {{ request?: Record<string, unknown>, user?: Record<string, unknown> }} */ (scrubbed);
  if (fields.request) {
    delete fields.request.cookies;
    delete fields.request.data;
  }
  if (fields.user) {
    delete fields.user.email;
    delete fields.user.ip_address;
    delete fields.user.username;
  }
  return scrubbed;
}
function envFlagEnabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeIdentifier(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

export function resolveOmniRushSentryAppVersion({ app, packageMetadata }) {
  const electronAppVersion = normalizeIdentifier(app?.getVersion?.());
  const packageVersion = normalizeIdentifier(packageMetadata?.version);
  if (app?.isPackaged) return electronAppVersion || packageVersion || "unknown";
  return packageVersion || electronAppVersion || "unknown";
}

export function resolveOmniRushSentryRelease({ appVersion, environmentRelease = process.env.SENTRY_RELEASE }) {
  return normalizeIdentifier(environmentRelease) || `omnirush-desktop@${normalizeIdentifier(appVersion) || "unknown"}`;
}

function parseBuildConfig(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const dsn = normalizeIdentifier(parsed?.dsn);
    const tracesSampleRate = Number(parsed?.tracesSampleRate);
    return {
      dsn,
      tracesSampleRate: Number.isFinite(tracesSampleRate) && tracesSampleRate >= 0 && tracesSampleRate <= 1
        ? tracesSampleRate
        : 0.01,
    };
  } catch {
    return { dsn: null, tracesSampleRate: 0.01 };
  }
}

function readBuildConfig(app) {
  if (app.isPackaged) {
    return parseBuildConfig(resolve(process.resourcesPath, "omnirush-sentry.json"));
  }
  return parseBuildConfig(resolve(__dirname, "..", ".electron-runtime", "omnirush-sentry.json"));
}

export async function initOmniRushSentry({ app, distribution, packageMetadata }) {
  const buildConfig = readBuildConfig(app);
  const dsn = buildConfig.dsn;
  if (!dsn || envFlagEnabled("OMNIRUSH_DESKTOP_SENTRY_DISABLED")) return false;

  sentry = await import("@sentry/electron/main");
  const appVersion = resolveOmniRushSentryAppVersion({ app, packageMetadata });
  const release = resolveOmniRushSentryRelease({ appVersion });
  const sampleRate = buildConfig.tracesSampleRate;

  sentry.init({
    dsn,
    release,
    environment: process.env.OMNIRUSH_DESKTOP_SENTRY_ENVIRONMENT?.trim() || (app.isPackaged ? "production" : "development"),
    sendDefaultPii: false,
    integrations: (defaultIntegrations) => defaultIntegrations.filter(
      (integration) => !["BrowserWindowSession", "ElectronMinidump", "MainProcessSession", "SentryMinidump"].includes(integration.name),
    ),
    tracesSampler: () => telemetryActive ? sampleRate : 0,
    beforeSend: (event) => telemetryActive ? scrubSentryEvent(event) : null,
    beforeSendTransaction: (event) => telemetryActive ? scrubSentryEvent(event) : null,
    beforeBreadcrumb: (breadcrumb) => telemetryActive ? scrubSentryPayload(breadcrumb) : null,
    initialScope: {
      tags: {
        app: "desktop",
        app_version: appVersion,
        distribution: distribution.flavor,
        packaged: String(app.isPackaged),
      },
      contexts: {
        app: {
          app_identifier: distribution.appIdentifier,
          app_name: distribution.appName,
          app_version: appVersion,
        },
      },
    },
  });

  initialized = true;
  globalThis.__omnirushDesktopTelemetry = {
    captureException,
    clearSession: clearOmniRushSentrySession,
    setSession: setOmniRushSentrySession,
  };
  return true;
}

export function setOmniRushSentrySession(input) {
  const userId = normalizeIdentifier(input?.userId);
  const orgId = normalizeIdentifier(input?.orgId);
  if (!initialized || !sentry || !userId || !orgId) return false;

  sessionActive = true;
  updateTelemetryActive();
  sentry.setUser({ id: userId });
  sentry.setTag("org_id", orgId);
  sentry.setContext("omnirush_cloud", {
    organization_id: orgId,
    user_id: userId,
  });
  return true;
}

/**
 * The renderer's "Share anonymous usage" setting (analyticsEnabled).
 * @param {boolean} enabled
 */
export function setOmniRushSentryConsent(enabled) {
  consentGranted = enabled === true;
  updateTelemetryActive();
  return telemetryActive;
}

export function clearOmniRushSentrySession() {
  sessionActive = false;
  updateTelemetryActive();
  if (!initialized || !sentry) return false;

  sentry.setUser(null);
  sentry.setContext("omnirush_cloud", null);
  return true;
}

export function captureException(error, context = {}) {
  if (!initialized || !sentry || !telemetryActive) return false;

  sentry.withScope((scope) => {
    if (context.surface) scope.setTag("surface", String(context.surface));
    if (context.route) scope.setTag("route", String(context.route));
    if (context.method) scope.setTag("method", String(context.method));
    sentry.captureException(error);
  });
  return true;
}
