// What's new: the release notes bundled with the app (whats-new.json, the same
// file as the CLI's; PARITY.sha256), which version the person has seen, and
// whether to point them at the notes after an update.
import { create } from "zustand";

import { captureAnalyticsEvent } from "@/app/lib/analytics";
import whatsNewData from "./whats-new.json";

export type WhatsNewRelease = {
  version: string;
  date: string;
  new: string[];
  improved: string[];
  fixed: string[];
};

export type WhatsNewSource = "menu" | "palette" | "toast" | "native_menu";

export const WHATS_NEW_CHANGELOG_URL = "https://omnirush.ai/changelog";
/** The version the app last started on (the update toast). */
export const LAST_VERSION_STORAGE_KEY = "omnirush.whatsNew.lastVersion";
/** The version whose notes were last opened (the dot on the menu entries). */
export const OPENED_VERSION_STORAGE_KEY = "omnirush.whatsNew.openedVersion";
/** Main process → window (app-menu.mjs, Help > What's New). */
export const NATIVE_MENU_WHATS_NEW_EVENT = "omnirush:native-menu:whats-new";

export const desktopReleases: readonly WhatsNewRelease[] = (whatsNewData as { desktop: WhatsNewRelease[] }).desktop;

/**
 * The build's version, or empty for a dev build: vite.config.ts falls back to
 * the repo's package.json ("0.0.0-dev") or "0.0.0" when no release version is set.
 */
export function normalizeAppVersion(value: unknown): string {
  const version = typeof value === "string" ? value.trim() : "";
  if (!version || version === "0.0.0" || version.startsWith("0.0.0-")) return "";
  return version;
}

const BUILD_VERSION = normalizeAppVersion(import.meta.env?.VITE_OMNIRUSH_APP_VERSION);

/** The packaged version; empty in dev builds. */
export function buildAppVersion(): string {
  return BUILD_VERSION;
}

/** The version the notes are shown for: the build's, or the newest entry in a dev build. */
export function displayVersion(appVersion: string = BUILD_VERSION, releases: readonly WhatsNewRelease[] = desktopReleases): string {
  return appVersion || releases[0]?.version || "";
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function isSemver(value: string): boolean {
  return SEMVER.test(value);
}

/** Negative when a < b, 0 when equal, positive when a > b; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const left = SEMVER.exec(a.trim());
  const right = SEMVER.exec(b.trim());
  if (!left || !right) return null;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff;
  }
  // A pre-release sorts before its release.
  const lp = left[4] ?? "";
  const rp = right[4] ?? "";
  if (lp === rp) return 0;
  if (!lp) return 1;
  if (!rp) return -1;
  return lp < rp ? -1 : 1;
}

export type UpdateDecision = {
  /** Show "Updated to …" now (or once no turn is running). */
  toast: boolean;
  /** What to remember as the last version, or null to leave the stored one. */
  store: string | null;
};

/**
 * After a start: toast only on an upgrade from a version this profile ran
 * before. A fresh install (nothing stored, or junk) just remembers the
 * version; a downgrade or the same version shows nothing and keeps the
 * higher stored one; a dev build (no version) never toasts or stores.
 */
export function updateDecision(stored: string | null, appVersion: string): UpdateDecision {
  const current = appVersion.trim();
  if (!current || !isSemver(current)) return { toast: false, store: null };
  const previous = stored?.trim() ?? "";
  const order = previous ? compareVersions(current, previous) : null;
  if (order === null) return { toast: false, store: current };
  if (order > 0) return { toast: true, store: current };
  return { toast: false, store: null };
}

/** The dot on the menu entries: until the notes were opened on this version. */
export function hasUnseenNotes(openedVersion: string | null, version: string): boolean {
  return Boolean(version) && openedVersion !== version;
}

export type InlinePart = { code: boolean; text: string };

/** Split `inline code` out of an item; an unmatched backtick stays as text. */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /`([^`]+)`/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ code: false, text: text.slice(last, at) });
    parts.push({ code: true, text: match[1] ?? "" });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}

// --- state -----------------------------------------------------------------------------

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readStored(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    storage()?.setItem(key, value);
  } catch {
    // A full or blocked storage only costs a repeat of the dot or the toast.
  }
}

type WhatsNewState = {
  open: boolean;
  openedVersion: string | null;
};

export const useWhatsNewStore = create<WhatsNewState>(() => ({
  open: false,
  openedVersion: readStored(OPENED_VERSION_STORAGE_KEY),
}));

export function useWhatsNewUnseen(): boolean {
  const openedVersion = useWhatsNewStore((state) => state.openedVersion);
  return hasUnseenNotes(openedVersion, displayVersion());
}

export function openWhatsNew(source: WhatsNewSource) {
  const version = displayVersion();
  if (version) writeStored(OPENED_VERSION_STORAGE_KEY, version);
  useWhatsNewStore.setState({ open: true, openedVersion: version || null });
  captureAnalyticsEvent("whats_new_opened", { source });
}

export function closeWhatsNew() {
  useWhatsNewStore.setState({ open: false });
}

/** Reads and applies the start-up decision for this build; true when the toast is due. */
export function takeUpdateDecision(appVersion: string = BUILD_VERSION): boolean {
  const decision = updateDecision(readStored(LAST_VERSION_STORAGE_KEY), appVersion);
  // An upgrade is remembered only once the toast is shown (markUpdateToastShown).
  if (decision.store && !decision.toast) writeStored(LAST_VERSION_STORAGE_KEY, decision.store);
  return decision.toast;
}

export function markUpdateToastShown(appVersion: string = BUILD_VERSION) {
  if (appVersion) writeStored(LAST_VERSION_STORAGE_KEY, appVersion);
}

/** Tests only: reload the stored marker. */
export function resetWhatsNewStoreForTests() {
  useWhatsNewStore.setState({ open: false, openedVersion: readStored(OPENED_VERSION_STORAGE_KEY) });
}
