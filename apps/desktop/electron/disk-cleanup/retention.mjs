// Disk retention rules shared by the CLI and the desktop app: the same file in
// omnirush-cli (src/disk-cleanup/retention.mjs) and omnirush-gui
// (apps/desktop/electron/disk-cleanup/retention.mjs); see PARITY.sha256.
//
// Every helper is best effort and never throws: a file another process holds
// open (Windows), one of another user, or one that vanished is skipped and
// reported, never retried in a loop. Nothing here decides WHAT is safe to
// remove; callers pass only app-owned caches, downloads, temp files and logs.

import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

export const MB = 1024 * 1024;
export const DAY_MS = 24 * 3_600_000;
/** One log file is rotated past this size (one rotated copy is kept). */
export const LOG_FILE_CAP_BYTES = 10 * MB;
/** All logs of a folder together stay under this. */
export const LOG_TOTAL_CAP_BYTES = 50 * MB;
/** Rotated logs older than this go. */
export const LOG_MAX_AGE_MS = 30 * DAY_MS;
/** Temp files of crashed runs are this old before they go. */
export const TEMP_MAX_AGE_MS = 3 * DAY_MS;

const LOCKED = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

/** Bytes under `p` (files, recursively; links are not followed). Never throws. */
export function sizeOf(p) {
  let st;
  try { st = lstatSync(p); } catch { return 0; }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let names = [];
  try { names = readdirSync(p); } catch { return 0; }
  for (const name of names) total += sizeOf(path.join(p, name));
  return total;
}

/** "1.2 GB" style sizes. */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/**
 * Remove a file or folder. { ok, bytes, locked, error }: `locked` when the OS
 * refused (a file open in another process on Windows, a read-only folder).
 * `dryRun` only measures.
 */
export function removePath(p, { dryRun = false } = {}) {
  const bytes = sizeOf(p);
  if (dryRun) return { ok: true, bytes, dryRun: true };
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    return { ok: true, bytes };
  } catch (error) {
    const code = String(error?.code || "");
    return { ok: false, bytes: 0, locked: LOCKED.has(code), error: code || String(error?.message || error) };
  }
}

/**
 * x.y.z[-pre.release] as [x, y, z, [pre identifiers]]; null when not a version. Build metadata (+...) is ignored.
 * @param {unknown} value
 * @returns {[number, number, number, string[]] | null}
 */
export function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split(".") : []] : null;
}

/** -1 / 0 / 1 in semver order (3.6.5-alpha.1 < 3.6.5-alpha.2 < 3.6.5); non-versions sort first. */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  const p = x[3], q = y[3];
  if (!p.length || !q.length) return p.length === q.length ? 0 : p.length ? -1 : 1;
  for (let i = 0; i < Math.max(p.length, q.length); i += 1) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    if (p[i] === q[i]) continue;
    const pn = /^\d+$/.test(p[i]), qn = /^\d+$/.test(q[i]);
    if (pn && qn) return Number(p[i]) < Number(q[i]) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Of `versions`, the ones to remove: everything older than the one previous
 * version kept. Kept: `current`, exactly one previous (the given `previous`
 * when it is still there, else the newest older one), anything newer than
 * `current` (a download not switched to yet), every name in `protect`, and
 * every name that is not a version.
 * @param {string[]} versions
 * @param {{ current: string, previous?: string | null, protect?: string[] }} options
 * @returns {string[]}
 */
export function versionsToRemove(versions, { current, previous = null, protect = [] }) {
  const list = [...new Set(versions.map(String))];
  if (!parseVersion(current)) return [];
  const older = list.filter((v) => parseVersion(v) && compareVersions(v, current) < 0).sort(compareVersions);
  const keepPrevious = previous && older.includes(String(previous)) ? String(previous) : older.at(-1) ?? null;
  const keep = new Set([String(current), keepPrevious, ...protect.map(String)].filter(Boolean));
  return older.filter((v) => !keep.has(v));
}

/**
 * Rotate `file` when it is over `maxBytes`: it becomes `file.1` (the previous
 * `file.1` goes). Writers that append by name start a new file. Returns
 * { rotated, bytes, locked } (bytes: what the old `file.1` freed) or null when
 * nothing was to do.
 */
export function rotateLog(file, { maxBytes = LOG_FILE_CAP_BYTES, dryRun = false } = {}) {
  let size;
  try { size = statSync(file).size; } catch { return null; }
  if (size <= maxBytes) return null;
  const old = `${file}.1`;
  const oldBytes = sizeOf(old);
  if (dryRun) return { rotated: false, bytes: oldBytes, wouldRotate: size, dryRun: true };
  try {
    rmSync(old, { force: true });
    renameSync(file, old);
    return { rotated: true, bytes: oldBytes };
  } catch (error) {
    // Windows: another process has it open without delete sharing; try again next time.
    const code = String(error?.code || "");
    return { rotated: false, bytes: 0, ...(LOCKED.has(code) ? { locked: true } : { error: code || "rotate-failed" }) };
  }
}

/**
 * Old logs in `dir` (names `match` accepts): ones past `maxAgeMs`, then the
 * oldest while the folder's logs are over `maxTotalBytes`. Files in `active`
 * (being written) are never removed. Returns [{ path, bytes, reason }].
 */
export function capLogs(dir, { match = (name) => /\.log(\.\d+)?$/.test(name), active = [], maxTotalBytes = LOG_TOTAL_CAP_BYTES, maxAgeMs = LOG_MAX_AGE_MS, now = Date.now(), dryRun = false } = {}) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const keep = new Set(active.map((p) => path.resolve(p)));
  const files = [];
  for (const name of names) {
    if (!match(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = lstatSync(p);
      if (st.isFile()) files.push({ path: p, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch { /* gone */ }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((sum, f) => sum + f.bytes, 0);
  const out = [];
  for (const f of files) {
    if (keep.has(path.resolve(f.path))) continue;
    const reason = now - f.mtimeMs > maxAgeMs ? "old log" : total > maxTotalBytes ? "logs over the size cap" : null;
    if (!reason) continue;
    const res = removePath(f.path, { dryRun });
    if (res.ok) { out.push({ path: f.path, bytes: f.bytes, reason, ...(dryRun ? { dryRun: true } : {}) }); total -= f.bytes; }
    else if (res.locked) out.push({ path: f.path, bytes: 0, reason, locked: true });
  }
  return out;
}

/**
 * Entries of `dir` whose name starts with one of `prefixes`, owned by this
 * user (a shared /tmp holds other users' too), that were not touched for
 * `maxAgeMs` (the folder and what is directly in it), and that hold no socket
 * (a live session's relay or approval channel).
 */
export function staleTemp(dir, prefixes, { now = Date.now(), maxAgeMs = TEMP_MAX_AGE_MS } = {}) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const out = [];
  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const p = path.join(dir, name);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || (uid !== null && st.uid !== uid)) continue;
      let newest = st.mtimeMs;
      let live = false;
      if (st.isDirectory()) {
        for (const child of readdirSync(p)) {
          try {
            const c = lstatSync(path.join(p, child));
            if (c.isSocket() || c.isFIFO()) { live = true; break; }
            newest = Math.max(newest, c.mtimeMs);
          } catch { /* gone */ }
        }
      }
      if (!live && now - newest > maxAgeMs) out.push(p);
    } catch { /* gone or unreadable */ }
  }
  return out;
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

/**
 * An exclusive lock file (`wx`): a release function, or null when another
 * live process holds it. A lock of a dead process, or older than `staleMs`, is
 * taken over.
 */
export function acquireLock(file, { staleMs = 30 * 60_000, now = Date.now() } = {}) {
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, nonce, at: now })); } finally { closeSync(fd); }
      return () => {
        try {
          const held = JSON.parse(readFileSync(file, "utf8"));
          if (held?.nonce === nonce) unlinkSync(file);
        } catch { /* gone */ }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") return null;
      let held = null;
      try { held = JSON.parse(readFileSync(file, "utf8")); } catch { /* half written */ }
      let age = 0;
      try { age = now - statSync(file).mtimeMs; } catch { continue; }
      if ((held && !alive(held.pid)) || age > staleMs) { try { unlinkSync(file); } catch { return null; } continue; }
      return null;
    }
  }
  return null;
}

/** What a run freed: { count, bytes, locked }. */
export function summarize(items) {
  const done = items.filter((item) => item && !item.locked && !item.error);
  return { count: done.length, bytes: done.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0), locked: items.filter((item) => item?.locked).length };
}
