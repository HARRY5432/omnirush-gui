/**
 * Buildathon: the event block of GET /me/buildathon, the tagged sessions
 * (GET /me/buildathon/sessions), the submission and the link code.
 *
 * Only an `enrolled: true` answer with a usable event is shown; anything
 * else (false, 404, an error, a malformed body) reads as null and the app
 * shows nothing.
 */

export const BUILDATHON_TRACKS = /** @type {const} */ ([
  { id: "agents", label: "Agents & Automation" },
  { id: "devtools", label: "Developer Tools & Open Source" },
  { id: "research", label: "Research, Data & Scientific Computing" },
  { id: "systems", label: "Systems, Infrastructure & Cybersecurity" },
  { id: "human-ai", label: "Human × AI" },
  { id: "open-frontier", label: "Open Frontier" },
]);
export const BUILDATHON_PHASES = /** @type {const} */ (["upcoming", "building", "judging", "results", "closed"]);
const SESSION_STATES = ["good", "pending", "incomplete"];
/** @typedef {import("@omnirush/types/desktop-ipc").OmniRushBuildathonStatus} BuildathonStatus */
/** @typedef {import("@omnirush/types/desktop-ipc").OmniRushBuildathonEvent} BuildathonEvent */
/** @typedef {import("@omnirush/types/desktop-ipc").OmniRushBuildathonParticipant} BuildathonParticipant */
/** @typedef {import("@omnirush/types/desktop-ipc").OmniRushBuildathonSubmission} BuildathonSubmission */
/** @typedef {import("@omnirush/types/desktop-ipc").OmniRushBuildathonSession} BuildathonSession */
const TRACK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Link codes look like `FB-7KQ2-M9`; anything short and plain is passed on for the server to judge. */
const LINK_CODE = /^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/;

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function isoTime(value) {
  const raw = text(value);
  return raw && Number.isFinite(Date.parse(raw)) ? raw : null;
}

function httpsUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A track id the server could know; null otherwise. */
export function buildathonTrackId(value) {
  const id = text(value)?.toLowerCase() ?? null;
  return id && TRACK_ID.test(id) ? id : null;
}

/** A link code as typed (spaces dropped, upper case), or null when it cannot be one. */
export function buildathonLinkCode(value) {
  const code = typeof value === "string" ? value.replace(/\s+/g, "").toUpperCase() : "";
  return LINK_CODE.test(code) ? code : null;
}

function parseTracks(value) {
  const tracks = Array.isArray(value)
    ? value
      .filter((track) => track && typeof track === "object")
      .map((track) => ({ id: buildathonTrackId(track.id), label: text(track.label) }))
      .filter((track) => track.id && track.label)
    : [];
  return tracks.length ? tracks.slice(0, 12) : BUILDATHON_TRACKS.map((track) => ({ ...track }));
}

function parseReminders(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((reminder) => reminder && typeof reminder === "object")
    .map((reminder) => ({ beforeSeconds: count(reminder.before_s), text: text(reminder.text) }))
    .filter((reminder) => reminder.beforeSeconds > 0 && reminder.text)
    .sort((left, right) => right.beforeSeconds - left.beforeSeconds)
    .slice(0, 6);
}

/** @returns {BuildathonEvent | null} */
function parseEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = text(value.id);
  const deadlineAt = isoTime(value.deadline_at);
  if (!id || !deadlineAt) return null;
  const phase = text(value.phase);
  return {
    id,
    name: text(value.name) ?? "Buildathon",
    startsAt: isoTime(value.starts_at),
    registrationEndsAt: isoTime(value.registration_ends_at),
    deadlineAt,
    resultsAt: isoTime(value.results_at),
    phase: BUILDATHON_PHASES.includes(/** @type {any} */ (phase)) ? /** @type {BuildathonEvent["phase"]} */ (phase) : null,
    pageUrl: httpsUrl(value.page_url),
    submitUrl: httpsUrl(value.submit_url),
    rules: Array.isArray(value.rules) ? value.rules.map(text).filter((rule) => rule !== null).slice(0, 20) : [],
    tracks: parseTracks(value.tracks),
    reminders: parseReminders(value.reminders),
  };
}

/** @returns {BuildathonParticipant | null} */
function parseParticipant(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const granted = count(value.tokens_granted);
  const used = count(value.tokens_used);
  const left = value.tokens_left === undefined || value.tokens_left === null ? Math.max(0, granted - used) : count(value.tokens_left);
  return {
    enrolledAt: isoTime(value.enrolled_at),
    tokensGranted: granted,
    tokensUsed: used,
    tokensLeft: left,
    sessionsTagged: count(value.sessions_tagged),
    sessionsGood: count(value.sessions_good),
  };
}

/**
 * The submission object (POST/GET /me/buildathon/submission, `submission` of GET /me/buildathon); null when absent.
 * @returns {BuildathonSubmission | null}
 */
export function parseBuildathonSubmission(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const submissionId = text(value.submission_id);
  if (!submissionId) return null;
  return {
    submissionId,
    submittedAt: isoTime(value.submitted_at),
    updatedAt: isoTime(value.updated_at),
    track: buildathonTrackId(value.track),
    title: text(value.title),
    repoUrl: httpsUrl(value.repo_url),
    demoVideoUrl: httpsUrl(value.demo_video_url),
    liveUrl: httpsUrl(value.live_url),
    sessionIds: Array.isArray(value.session_ids) ? value.session_ids.map(text).filter((id) => id !== null).slice(0, 200) : [],
    checks: Array.isArray(value.checks)
      ? value.checks
        .filter((check) => check && typeof check === "object" && text(check.id))
        .map((check) => ({ id: text(check.id), ok: check.ok === true, text: text(check.text) ?? "" }))
        .slice(0, 20)
      : [],
    locked: value.locked === true,
  };
}

/**
 * GET /me/buildathon (or the link answer): null unless the account is
 * enrolled and the event names a deadline.
 * @returns {BuildathonStatus | null}
 */
export function parseBuildathonStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.enrolled !== true) return null;
  const event = parseEvent(value.event);
  if (!event) return null;
  return {
    enrolled: true,
    serverTime: isoTime(value.server_time),
    event,
    participant: parseParticipant(value.participant),
    submission: parseBuildathonSubmission(value.submission),
  };
}

/**
 * GET /me/buildathon/sessions; null on a malformed body.
 * @returns {BuildathonSession[] | null}
 */
export function parseBuildathonSessions(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.sessions)) return null;
  return value.sessions
    .filter((session) => session && typeof session === "object" && text(session.session_id))
    .slice(0, 200)
    .map((session) => ({
      sessionId: text(session.session_id),
      title: text(session.title),
      project: text(session.project),
      startedAt: isoTime(session.started_at),
      endedAt: isoTime(session.ended_at),
      track: buildathonTrackId(session.track),
      status: SESSION_STATES.includes(session.status) ? session.status : "pending",
      reasons: Array.isArray(session.reasons) ? session.reasons.map(text).filter((reason) => reason !== null).slice(0, 10) : [],
      tokens: count(session.tokens),
    }));
}

const LINK_ERRORS = {
  invalid_code: "That code was not found. Check it against your registration email.",
  code_already_used: "That code was already used.",
  already_enrolled: "This account is already enrolled.",
  not_available: "Linking is not available right now.",
  too_many_attempts: "Too many tries. Wait a few minutes and try again.",
};

/** A refused link as a sentence: the server's error code mapped, or its own words. */
export function buildathonLinkError(payload, status) {
  const message = payload && typeof payload === "object" ? text(payload.error) ?? text(payload.detail) : null;
  if (message && Object.hasOwn(LINK_ERRORS, message)) return LINK_ERRORS[message];
  if (status === 429) return LINK_ERRORS.too_many_attempts;
  if (message && !/^[a-z0-9_]+$/.test(message)) return message;
  if (status === 400 || status === 404) return LINK_ERRORS.invalid_code;
  return "The code could not be checked. Try again in a moment.";
}

/** A folder's last name, as the server takes it (never a full path). */
export function buildathonProjectName(value) {
  const name = text(value)?.split(/[\\/]/).filter(Boolean).pop() ?? null;
  return name && name.length <= 200 ? name : null;
}
