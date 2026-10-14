// Buildathon, renderer side. The Electron main process reads
// GET /me/buildathon (apps/desktop/electron/buildathon.mjs) and answers null
// for anyone not enrolled, offline or on any error; everything here then
// renders nothing. Nothing in this file is awaited on the way to the first
// screen.

import { create } from "zustand";

import type {
  OmniRushBuildathonEvent,
  OmniRushBuildathonSession,
  OmniRushBuildathonStatus,
  OmniRushBuildathonTagResult,
  OmniRushBuildathonTrack,
} from "@omnirush/types/desktop-ipc";

export type BuildathonStatus = OmniRushBuildathonStatus;
export type BuildathonEvent = OmniRushBuildathonEvent;
export type BuildathonSession = OmniRushBuildathonSession;
export type BuildathonTrack = OmniRushBuildathonTrack;

export const BUILDATHON_REFRESH_MS = 10 * 60_000;
export const ONLY_TOOL_RULE = "OmniRush must be the only generative AI tool you use.";
export const BUILDATHON_TRACKS_STORAGE_KEY = "omnirush.buildathon.tracks.v1";
export const BUILDATHON_TAGGED_STORAGE_KEY = "omnirush.buildathon.tagged.v1";
export const BUILDATHON_REMINDERS_STORAGE_KEY = "omnirush.buildathon.reminders.v1";
const MAX_TAGGED_REMEMBERED = 500;
const HOUR_MS = 3_600_000;

// --- Countdown --------------------------------------------------------------

export type BuildathonCountdown =
  | { kind: "upcoming"; remainingMs: number; urgent: false }
  | { kind: "open"; remainingMs: number; urgent: boolean }
  | { kind: "closed"; remainingMs: 0; urgent: false };

const pad = (value: number) => String(value).padStart(2, "0");

/** "5d 03h", "4h 07m", "42m 09s" (never negative). */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${pad(hours)}h`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  return `${minutes}m ${pad(seconds)}s`;
}

/** Milliseconds to add to the local clock to read the server's (0 without a server time). */
export function clockOffsetMs(serverTime: string | null | undefined, receivedAtMs: number): number {
  const server = serverTime ? Date.parse(serverTime) : Number.NaN;
  return Number.isFinite(server) ? server - receivedAtMs : 0;
}

/** Where the event stands at `nowMs` (server clock). */
export function buildathonCountdown(event: BuildathonEvent, nowMs: number): BuildathonCountdown {
  const deadline = Date.parse(event.deadlineAt);
  if (event.phase === "judging" || event.phase === "results" || event.phase === "closed" || !(deadline > nowMs)) {
    return { kind: "closed", remainingMs: 0, urgent: false };
  }
  const starts = event.startsAt ? Date.parse(event.startsAt) : Number.NaN;
  if (Number.isFinite(starts) && starts > nowMs) {
    return { kind: "upcoming", remainingMs: starts - nowMs, urgent: false };
  }
  const remainingMs = deadline - nowMs;
  return { kind: "open", remainingMs, urgent: remainingMs < HOUR_MS };
}

/** The chip's words: "Buildathon · 5d 03h left". */
export function buildathonChipText(countdown: BuildathonCountdown): string {
  if (countdown.kind === "closed") return "Buildathon · Submissions closed";
  if (countdown.kind === "upcoming") return `Buildathon · starts in ${formatRemaining(countdown.remainingMs)}`;
  return `Buildathon · ${formatRemaining(countdown.remainingMs)} left`;
}

/** "20 Oct, 23:59 IST", plus the local time when the machine is not on IST. */
export function formatEventTime(iso: string | null | undefined, locale?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  const ist = new Intl.DateTimeFormat(locale ?? "en-GB", { ...options, timeZone: "Asia/Kolkata" }).format(date);
  let localZone = "";
  try {
    localZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    localZone = "";
  }
  if (localZone === "Asia/Kolkata" || localZone === "Asia/Calcutta") return `${ist} IST`;
  const local = new Intl.DateTimeFormat(locale ?? "en-GB", { ...options, timeZoneName: "short" }).format(date);
  return `${ist} IST · ${local} your time`;
}

export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.max(0, Math.floor(value)));
}

/** The event's rules with the only-tool rule first (the server's wording when it has one). */
export function rulesWithToolRuleFirst(rules: string[]): string[] {
  const index = rules.findIndex((rule) => /only generative/i.test(rule));
  if (index < 0) return [ONLY_TOOL_RULE, ...rules];
  return [rules[index]!, ...rules.filter((_, at) => at !== index)];
}

// --- Reminders: each once --------------------------------------------------

export function reminderKey(eventId: string, beforeSeconds: number): string {
  return `${eventId}:${beforeSeconds}`;
}

/**
 * The reminder due now, once: the tightest one whose window has opened.
 * Every wider one is marked too, so opening the app with 10 minutes left
 * shows only the 15-minute text.
 */
export function reminderToShow(
  event: BuildathonEvent,
  countdown: BuildathonCountdown,
  shown: ReadonlySet<string>,
): { text: string; keys: string[] } | null {
  if (countdown.kind !== "open") return null;
  const remainingSeconds = countdown.remainingMs / 1000;
  const due = event.reminders.filter((reminder) => remainingSeconds <= reminder.beforeSeconds);
  if (!due.length) return null;
  const keys = due.map((reminder) => reminderKey(event.id, reminder.beforeSeconds));
  const tightest = due.reduce((best, reminder) => (reminder.beforeSeconds < best.beforeSeconds ? reminder : best));
  if (shown.has(reminderKey(event.id, tightest.beforeSeconds))) return null;
  return { text: tightest.text, keys };
}

// --- Local storage ---------------------------------------------------------

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): KeyValueStore | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readJson<T>(key: string, fallback: T, storage: KeyValueStore | null): T {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown, storage: KeyValueStore | null): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked storage: the worst case is asking or tagging once more.
  }
}

/** The key a project folder is stored under: trimmed, without trailing separators. */
export function projectKey(path: string | null | undefined): string | null {
  const trimmed = (path ?? "").trim().replace(/[\\/]+$/, "");
  return trimmed || null;
}

/**
 * A folder's answer: its track, or null when it was skipped ("No track");
 * `first`: when it was first answered. (CLI: the folder tracks file, the same
 * fields.) Older entries were the track alone.
 */
export type ProjectEntry = { track: string | null; first: string | null; at: string | null };

export function readProjectEntries(storage: KeyValueStore | null = defaultStorage()): Record<string, ProjectEntry> {
  const value = readJson<Record<string, unknown>>(BUILDATHON_TRACKS_STORAGE_KEY, {}, storage);
  const entries: Record<string, ProjectEntry> = {};
  for (const [path, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry) entries[path] = { track: entry, first: null, at: null };
    else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const raw = entry as Record<string, unknown>;
      const iso = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
      entries[path] = { track: typeof raw.track === "string" && raw.track ? raw.track : null, first: iso(raw.first), at: iso(raw.at) };
    }
  }
  return entries;
}

/** Folder -> track, for folders that have one. */
export function readProjectTracks(storage: KeyValueStore | null = defaultStorage()): Record<string, string> {
  const tracks: Record<string, string> = {};
  for (const [path, entry] of Object.entries(readProjectEntries(storage))) if (entry.track) tracks[path] = entry.track;
  return tracks;
}

export function readProjectTrack(path: string | null | undefined, storage: KeyValueStore | null = defaultStorage()): string | null {
  const key = projectKey(path);
  return key ? readProjectEntries(storage)[key]?.track ?? null : null;
}

/** Whether the folder was answered (a track or a skip). */
export function projectAnswered(path: string | null | undefined, storage: KeyValueStore | null = defaultStorage()): boolean {
  const key = projectKey(path);
  return Boolean(key && readProjectEntries(storage)[key]);
}

/** Saves a folder's track, or (null) its skip; the first answer's time is kept. */
export function writeProjectTrack(path: string | null | undefined, track: string | null, storage: KeyValueStore | null = defaultStorage(), now = Date.now()): void {
  const key = projectKey(path);
  if (!key) return;
  const entries = readProjectEntries(storage);
  const at = new Date(now).toISOString();
  entries[key] = { track, first: entries[key]?.first ?? entries[key]?.at ?? at, at };
  // A bounded list: the most recent 500 folders.
  const kept = Object.entries(entries).sort((a, b) => String(a[1].at).localeCompare(String(b[1].at))).slice(-500);
  writeJson(BUILDATHON_TRACKS_STORAGE_KEY, Object.fromEntries(kept), storage);
}

/**
 * The buildathon projects (contract "Reproducibility mode"): folders with a
 * track, and folders skipped whose first answer fell inside the event. The
 * server leaves out generic folders (home, temp, a root).
 */
export function buildathonProjectPaths(event: BuildathonEvent, entries: Record<string, ProjectEntry>): string[] {
  const starts = event.startsAt ? Date.parse(event.startsAt) : Number.NEGATIVE_INFINITY;
  const deadline = Date.parse(event.deadlineAt);
  const known = new Set(event.tracks.map((track) => track.id));
  const out: string[] = [];
  for (const [path, entry] of Object.entries(entries)) {
    if (entry.track && known.has(entry.track)) out.push(path);
    else if (!entry.track && entry.first) {
      const first = Date.parse(entry.first);
      if (first >= starts && first <= deadline) out.push(path);
    }
  }
  return out.sort();
}

/** The server's body for PUT /runtime-config/buildathon (null without an event). */
export function buildathonServerBody(status: BuildathonStatus | null, entries: Record<string, ProjectEntry>) {
  if (!status) return null;
  return {
    repro: { box: status.repro.box, agent_rules: status.repro.agentRules },
    projects: buildathonProjectPaths(status.event, entries),
    deadline_at: status.event.deadlineAt,
  };
}

export function readTaggedSessions(storage: KeyValueStore | null = defaultStorage()): Record<string, string> {
  return readJson<Record<string, string>>(BUILDATHON_TAGGED_STORAGE_KEY, {}, storage);
}

export function rememberTaggedSession(sessionId: string, track: string, storage: KeyValueStore | null = defaultStorage()): void {
  const tagged = readTaggedSessions(storage);
  delete tagged[sessionId];
  tagged[sessionId] = track;
  const ids = Object.keys(tagged);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TAGGED_REMEMBERED))) delete tagged[id];
  writeJson(BUILDATHON_TAGGED_STORAGE_KEY, tagged, storage);
}

export function readShownReminders(storage: KeyValueStore | null = defaultStorage()): Set<string> {
  const value = readJson<unknown>(BUILDATHON_REMINDERS_STORAGE_KEY, [], storage);
  return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []);
}

export function rememberShownReminders(keys: string[], storage: KeyValueStore | null = defaultStorage()): void {
  const shown = readShownReminders(storage);
  for (const key of keys) shown.add(key);
  writeJson(BUILDATHON_REMINDERS_STORAGE_KEY, [...shown].slice(-50), storage);
}

// --- Which sessions to tag ---------------------------------------------------

export type BuildathonProject = {
  id: string;
  path: string;
  name: string;
  local: boolean;
  sessions: Array<{ id: string; created: number | null; parentId: string | null }>;
};

/**
 * Root sessions of a project with a track, started inside the event, whose
 * track the server has not been told yet (or was told a different one).
 */
export function sessionsToTag(
  projects: BuildathonProject[],
  event: BuildathonEvent,
  tracks: Record<string, string>,
  tagged: Record<string, string>,
  limit = 20,
): Array<{ sessionId: string; track: string; project: string | null }> {
  const starts = event.startsAt ? Date.parse(event.startsAt) : Number.NEGATIVE_INFINITY;
  const deadline = Date.parse(event.deadlineAt);
  const known = new Set(event.tracks.map((track) => track.id));
  const out: Array<{ sessionId: string; track: string; project: string | null }> = [];
  for (const project of projects) {
    if (!project.local) continue;
    const key = projectKey(project.path);
    const track = key ? tracks[key] : undefined;
    if (!track || !known.has(track)) continue;
    for (const session of project.sessions) {
      if (session.parentId || tagged[session.id] === track) continue;
      const created = session.created ?? Number.NaN;
      if (!Number.isFinite(created) || created < starts || created > deadline) continue;
      out.push({ sessionId: session.id, track, project: key!.split(/[\\/]/).pop() || null });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// --- Store -------------------------------------------------------------------

type BuildathonStore = {
  status: BuildathonStatus | null;
  /** Server clock minus local clock, from the latest answer. */
  offsetMs: number;
  panelOpen: boolean;
  projects: BuildathonProject[];
  /** The project open in the app (the panel's checklist is about it). */
  selectedProjectId: string | null;
  /** Projects created in this run, waiting for the one-time track question. */
  newProjects: Array<{ path: string; name: string }>;
  /** Bumped on every track change so pickers re-read storage. */
  tracksVersion: number;
  setStatus: (status: BuildathonStatus | null, receivedAtMs?: number) => void;
  openPanel: () => void;
  closePanel: () => void;
  setProjects: (projects: BuildathonProject[], selectedProjectId?: string | null) => void;
  noteNewProject: (project: { path: string; name: string }) => void;
  dropNewProject: (path: string) => void;
  bumpTracks: () => void;
};

export const useBuildathonStore = create<BuildathonStore>((set) => ({
  status: null,
  offsetMs: 0,
  panelOpen: false,
  projects: [],
  selectedProjectId: null,
  newProjects: [],
  tracksVersion: 0,
  setStatus: (status, receivedAtMs = Date.now()) =>
    set((state) => ({
      status,
      offsetMs: status ? clockOffsetMs(status.serverTime, receivedAtMs) : 0,
      panelOpen: status ? state.panelOpen : false,
    })),
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  setProjects: (projects, selectedProjectId = null) => set({ projects, selectedProjectId }),
  noteNewProject: (project) =>
    set((state) => {
      const key = projectKey(project.path);
      if (!key || state.newProjects.some((entry) => projectKey(entry.path) === key)) return state;
      return { newProjects: [...state.newProjects, { path: key, name: project.name }] };
    }),
  dropNewProject: (path) =>
    set((state) => ({ newProjects: state.newProjects.filter((entry) => entry.path !== projectKey(path)) })),
  bumpTracks: () => set((state) => ({ tracksVersion: state.tracksVersion + 1 })),
}));

/** A project folder was just created (desktop); the event layer may ask for its track once. */
export function noteNewBuildathonProject(path: string | null | undefined, name?: string | null): void {
  const key = projectKey(path);
  if (!key) return;
  useBuildathonStore.getState().noteNewProject({ path: key, name: name?.trim() || key.split(/[\\/]/).pop() || key });
}

let refreshing: Promise<void> | null = null;

/** One read of the event; any failure hides everything. Never throws. */
export function refreshBuildathon(read: () => Promise<BuildathonStatus | null>): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const status = await read();
      useBuildathonStore.getState().setStatus(status?.enrolled === true ? status : null);
    } catch {
      useBuildathonStore.getState().setStatus(null);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Saves a folder's track and tells the server about its event sessions on the next pass. */
export function setProjectTrack(path: string | null | undefined, track: string | null): void {
  writeProjectTrack(path, track);
  useBuildathonStore.getState().bumpTracks();
}

/**
 * Tells the server the track of every session that needs it, one at a time
 * and fire-and-forget: a refusal is final, a failure is tried on a later pass.
 */
export async function tagSessions(
  pending: Array<{ sessionId: string; track: string; project?: string | null }>,
  tag: (input: { sessionId: string; track: string; project?: string | null }) => Promise<OmniRushBuildathonTagResult>,
): Promise<void> {
  for (const entry of pending) {
    let result: OmniRushBuildathonTagResult = "retry";
    try {
      result = await tag(entry);
    } catch {
      result = "retry";
    }
    if (result !== "retry") rememberTaggedSession(entry.sessionId, entry.track);
  }
}

export function sessionStatusLabel(status: BuildathonSession["status"]): string {
  if (status === "good") return "Counts";
  if (status === "incomplete") return "Incomplete";
  return "Pending";
}


type SessionGroupLike = {
  workspace: { id: string; path: string; name?: string | null; displayName?: string | null; workspaceType?: string | null };
  sessions: Array<{ id: string; parentID?: string | null; time?: { created?: number | null } | null }>;
};

/** The sidebar's groups as the layer needs them (local folders, root sessions, start times). */
export function buildathonProjects(groups: SessionGroupLike[]): BuildathonProject[] {
  return groups.map((group) => ({
    id: group.workspace.id,
    path: group.workspace.path,
    name: group.workspace.displayName?.trim() || group.workspace.name?.trim() || group.workspace.path,
    local: group.workspace.workspaceType === "local",
    sessions: group.sessions.map((session) => ({
      id: session.id,
      created: typeof session.time?.created === "number" ? session.time.created : null,
      parentId: session.parentID ?? null,
    })),
  }));
}

let lastSent: string | null = null;

/**
 * Tells the local server the buildathon projects and the event's `repro`
 * block when they changed since the last answer it took. Never throws; a
 * failure is tried again on the next call.
 */
export async function syncBuildathonServer(
  status: BuildathonStatus | null,
  send: (body: NonNullable<ReturnType<typeof buildathonServerBody>>) => Promise<unknown>,
  entries: Record<string, ProjectEntry> = readProjectEntries(),
): Promise<"sent" | "unchanged" | "skipped" | "failed"> {
  const body = buildathonServerBody(status, entries);
  if (!body) return "skipped";
  const key = JSON.stringify(body);
  if (key === lastSent) return "unchanged";
  try {
    await send(body);
    lastSent = key;
    return "sent";
  } catch {
    return "failed";
  }
}

export function resetBuildathonServerSync(): void {
  lastSent = null;
}
