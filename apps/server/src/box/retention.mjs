// Which sandbox images stay on disk across box-version updates. The same file
// in omnirush-cli (src/box/retention.mjs) and omnirush-gui
// (apps/server/src/box/retention.mjs); see PARITY.sha256 in both.
//
// Kept: the images of the current pins and of the box version before them
// (so going back one app version does not download again), and every image a
// box still uses. Only OmniRush box images (omnirush-ai/box-<stack>, by tag
// or by digest) are ever removed; nothing is pruned.

import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PINS_SEEN_FILE = "pins-seen.json";
/** Box versions remembered: the current one and the one before it. */
export const KEEP_BOX_VERSIONS = 2;
/** Downloads a killed pull left behind are removed once this old. */
export const STALE_PULL_MS = 24 * 3_600_000;

/** The repository of an image reference, without its tag or digest. */
export function imageRepo(ref) {
  let text = String(ref || "").trim();
  const at = text.indexOf("@");
  if (at >= 0) text = text.slice(0, at);
  const slash = text.lastIndexOf("/");
  const colon = text.lastIndexOf(":");
  if (colon > slash) text = text.slice(0, colon);
  return text.replace(/^docker\.io\//, "");
}

/** The digest in a reference (`repo@sha256:…`), else null. */
export function refDigest(ref) {
  const m = /@(sha256:[0-9a-f]{64})$/.exec(String(ref || "").trim());
  return m ? m[1] : null;
}

/** An OmniRush box image (`…/omnirush-ai/box-<stack>`, by tag or by digest). */
export function isBoxImage(ref) {
  return /(^|\/)omnirush-ai\/box-[a-z]+$/.test(imageRepo(ref));
}

function pinEntry(pins) {
  const images = Object.values(pins?.images ?? {});
  const refs = images.map((pin) => String(pin?.ref || "")).filter(Boolean);
  const digests = images.map((pin) => String(pin?.digest || "")).filter((d) => /^sha256:[0-9a-f]{64}$/.test(d));
  return { version: String(pins?.version || ""), refs, digests };
}

function readSeen(home) {
  try {
    const value = JSON.parse(readFileSync(path.join(home, PINS_SEEN_FILE), "utf8"));
    return Array.isArray(value?.versions) ? value.versions.filter((v) => v && typeof v.version === "string" && Array.isArray(v.refs) && Array.isArray(v.digests)) : [];
  } catch {
    return [];
  }
}

/**
 * The images to keep: the current pins and the box version seen before them.
 * Records the current pins in `<home>/pins-seen.json` (unless `write` is false),
 * so the next box version knows which one came before it.
 */
export function keptImages(home, pins, { write = true, now = Date.now() } = {}) {
  const current = pinEntry(pins);
  const seen = readSeen(home);
  const firstRun = seen.length === 0;
  const versions = current.version
    ? [{ ...current, seen_at: now }, ...seen.filter((v) => v.version !== current.version)].slice(0, KEEP_BOX_VERSIONS)
    : seen.slice(0, KEEP_BOX_VERSIONS);
  if (write && current.version && (seen[0]?.version !== current.version || seen.length > KEEP_BOX_VERSIONS)) {
    try {
      mkdirSync(home, { recursive: true });
      const file = path.join(home, PINS_SEEN_FILE);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, versions }));
      renameSync(tmp, file);
    } catch { /* best effort: only the current pins are known then */ }
  }
  const refs = new Set();
  const digests = new Set();
  for (const v of versions) {
    for (const ref of v.refs) refs.add(String(ref));
    for (const digest of v.digests) digests.add(String(digest));
  }
  // The legacy "current" set some callers pass (refs only) is covered by refs.
  for (const ref of current.refs) refs.add(ref);
  return { refs, digests, versions: versions.map((v) => v.version), firstRun };
}

/** Records the pins a box starts on (a box start or pull), so the next box version knows the one before it. Never throws. */
export function rememberPins(home, pins) {
  try { keptImages(home, pins); } catch { /* best effort */ }
}

/** Images unpacked this recently are never removed (another app may be about to make a box on it). */
export const YOUNG_IMAGE_MS = 7 * 24 * 3_600_000;

/**
 * Whether an image may be removed: an OmniRush box image that is neither
 * kept (current or previous pins) nor used by a box. `image`: { ref, digest, id }
 * where ref is `repo:tag`, `repo@digest` or `repo:<none>`; `used` holds the
 * refs, ids and digests boxes run on.
 */
export function removableImage(image, { keep = { refs: new Set(), digests: new Set() }, used = new Set() } = {}) {
  const ref = String(image?.ref || "");
  if (!ref || !isBoxImage(ref)) return false;
  const repo = imageRepo(ref);
  // The listed digest and the one in the reference (a store may record another digest than the pin's).
  const digests = [...new Set([/^sha256:[0-9a-f]{64}$/.test(String(image?.digest || "")) ? String(image.digest) : null, refDigest(ref)].filter(Boolean))];
  const id = String(image?.id || "");
  const tagged = /:[^/@]+$/.test(ref) && !/:<none>$/.test(ref) && !refDigest(ref) ? ref : null;
  const names = [ref, tagged, ...digests, ...digests.map((d) => `${repo}@${d}`), id, id && `sha256:${id}`].filter(Boolean);
  if (names.some((name) => used.has(name))) return false;
  if (tagged && keep.refs?.has(tagged)) return false;
  if (digests.some((d) => keep.digests?.has(d))) return false;
  // An id that is a prefix of a used full id (docker prints 12 characters).
  if (id && [...used].some((u) => typeof u === "string" && (u.startsWith(id) || u.startsWith(`sha256:${id}`)))) return false;
  return true;
}

/** What to name in `rmi`: repo@digest when known (a digest pull has no tag), else repo:tag, else the id. */
export function removalTarget({ ref, digest, id }) {
  const repo = imageRepo(ref);
  const d = /^sha256:[0-9a-f]{64}$/.test(String(digest || "")) ? digest : refDigest(ref);
  if (d) return `${repo}@${d}`;
  if (ref && /:[^/@]+$/.test(ref) && !/:<none>$/.test(ref)) return ref;
  return id || null;
}

/**
 * Remove a folder tree this user owns, also when parts are read-only (an
 * unpacked rootfs). Returns false when something stayed (a locked file on
 * Windows, a file of another user); never throws.
 */
export function removeTree(dir) {
  try {
    const walk = (p) => {
      let st;
      try { st = lstatSync(p); } catch { return; }
      if (!st.isDirectory()) return;
      try { chmodSync(p, 0o700); } catch { /* not ours */ }
      let names = [];
      try { names = readdirSync(p); } catch { return; }
      for (const name of names) walk(path.join(p, name));
    };
    walk(dir);
    rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
    return true;
  } catch {
    return false;
  }
}

/** Entries of `dir` (a pull's download folder) older than `maxAgeMs`: [{ name, path, mtimeMs }]. */
export function staleEntries(dir, { now = Date.now(), maxAgeMs = STALE_PULL_MS, match = () => true } = {}) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!match(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = statSync(p);
      if (now - st.mtimeMs > maxAgeMs) out.push({ name, path: p, mtimeMs: st.mtimeMs });
    } catch { /* gone */ }
  }
  return out;
}
