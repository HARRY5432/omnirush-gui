// omnirush: the home screen's model (recent projects and chats, local chat search).
//
// PARITY: byte-identical in omnirush-cli assets/extensions/omnirush/workspace/
// and omnirush-gui apps/server/src/workspace/ (see PARITY.sha256 there).
//
// Pure functions over the chats already stored on this computer. Searching
// reads only the local engine store: nothing here sends chat history anywhere.

import path from "node:path";

import { TASKS_SUFFIX } from "./worktree-tasks.mjs";

export const RECENT_SESSIONS = 8;
export const RECENT_PROJECTS = 6;
export const SEARCH_RESULTS = 30;
export const SNIPPET_WIDTH = 90;

/** A folder's display name; a task worktree reads "app › fix-login-3f2a". */
export function projectName(directory) {
  const dir = String(directory || "");
  if (!dir) return "";
  const base = path.basename(dir) || dir;
  const parent = path.basename(path.dirname(dir));
  if (parent.endsWith(TASKS_SUFFIX) && parent.length > TASKS_SUFFIX.length) return `${parent.slice(0, -TASKS_SUFFIX.length)} › ${base}`;
  return base;
}

/** Whether a folder is a task worktree (`<repo>-tasks/<name>`). */
export function isTaskFolder(directory) {
  const parent = path.basename(path.dirname(String(directory || "")));
  return parent.endsWith(TASKS_SUFFIX) && parent.length > TASKS_SUFFIX.length;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 d ago", then the date. */
export function relativeAge(ms, now = Date.now()) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86_400) return "yesterday";
  if (s < 14 * 86_400) return `${Math.round(s / 86_400)} d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** A chat's title for lists (the engine's default "New session - <date>" reads "Untitled chat"). */
export function chatTitle(title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  if (!text || /^(new session|child session)\s*-\s*\d{4}-/i.test(text)) return "Untitled chat";
  return text.length > 72 ? `${text.slice(0, 69).trimEnd()}…` : text;
}

/**
 * Recent chats and projects from a list of root sessions
 * ({ id, title, directory, updatedAt }), newest first; sub-agent sessions
 * (with a parentId) and archived ones are left out.
 */
export function recentView(sessions, { sessionLimit = RECENT_SESSIONS, projectLimit = RECENT_PROJECTS } = {}) {
  const roots = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && s.id && s.directory && !s.parentId && !s.archived)
    .map((s) => ({ ...s, updatedAt: Number(s.updatedAt) || 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const projects = new Map();
  for (const s of roots) {
    const p = projects.get(s.directory);
    if (p) p.chats += 1;
    else projects.set(s.directory, { directory: s.directory, name: projectName(s.directory), updatedAt: s.updatedAt, chats: 1, lastSessionId: s.id, task: isTaskFolder(s.directory) });
  }
  return {
    sessions: roots.slice(0, sessionLimit).map((s) => ({ id: s.id, title: chatTitle(s.title), directory: s.directory, project: projectName(s.directory), updatedAt: s.updatedAt })),
    projects: [...projects.values()].slice(0, projectLimit),
  };
}

/** The words of a search (lower case, at least one character, at most 8). */
export function searchTerms(query) {
  return String(query || "").toLowerCase().split(/\s+/).map((w) => w.trim()).filter(Boolean).slice(0, 8);
}

/** Whether every term occurs in the text (case-insensitive). */
export function matchesAll(text, terms) {
  const hay = String(text || "").toLowerCase();
  return terms.length > 0 && terms.every((term) => hay.includes(term));
}

/** A one-line excerpt around the first term found ("…before term after…"). */
export function snippet(text, terms, width = SNIPPET_WIDTH) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0 || flat.length <= width) return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/**
 * Ranks search hits ({ sessionId, title, directory, updatedAt, text, role })
 * into one result per chat: title matches first, then the newest; each result
 * carries the excerpt of its best hit.
 */
export function rankHits(hits, query, { limit = SEARCH_RESULTS } = {}) {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const best = new Map();
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!hit?.sessionId) continue;
    const inTitle = matchesAll(hit.title, terms);
    const inText = matchesAll(hit.text, terms);
    if (!inTitle && !inText) continue;
    const score = (inTitle ? 2 : 0) + (inText ? 1 : 0);
    const prev = best.get(hit.sessionId);
    if (!prev || score > prev.score || (score === prev.score && (hit.updatedAt || 0) > (prev.updatedAt || 0))) {
      best.set(hit.sessionId, {
        sessionId: hit.sessionId, title: chatTitle(hit.title), directory: hit.directory, project: projectName(hit.directory),
        updatedAt: Number(hit.updatedAt) || 0, score, excerpt: inText ? snippet(hit.text, terms) : "", role: inText ? hit.role || null : null,
      });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, limit);
}
