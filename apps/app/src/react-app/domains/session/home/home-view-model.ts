import type { SearchableSession } from "@/react-app/domains/session/search/session-search";

/** Same limits and titles as the shared home view (apps/server/src/workspace/home-view.mjs). */
export const HOME_RECENT_CHATS = 8;
export const HOME_RECENT_PROJECTS = 6;

export type HomeWorkspace = {
  id: string;
  name: string;
  /** A parallel task's own workspace: listed on its repository's task board, not here. */
  task: boolean;
};

export type HomeProject = {
  workspaceId: string;
  name: string;
  updatedAt: number;
  chats: number;
  lastSessionId: string;
};

/** A chat's title for lists (the engine's default "New session - <date>" reads "Untitled chat"). */
export function homeChatTitle(title: string | null | undefined): string {
  const text = String(title ?? "").replace(/\s+/g, " ").trim();
  if (!text || /^(new session|child session)\s*-\s*\d{4}-/i.test(text)) return "Untitled chat";
  return text.length > 72 ? `${text.slice(0, 69).trimEnd()}…` : text;
}

/** The newest chats across every workspace on this computer. */
export function recentChats(sessions: SearchableSession[], limit = HOME_RECENT_CHATS): SearchableSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/**
 * The projects with the newest chats, each with its latest chat (one click
 * opens it). Task workspaces are left out: their repository's board lists them.
 */
export function recentProjects(sessions: SearchableSession[], workspaces: HomeWorkspace[], limit = HOME_RECENT_PROJECTS): HomeProject[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const projects = new Map<string, HomeProject>();
  for (const session of recentChats(sessions, Number.POSITIVE_INFINITY)) {
    const workspace = byId.get(session.workspaceId);
    if (!workspace || workspace.task) continue;
    const known = projects.get(session.workspaceId);
    if (known) known.chats += 1;
    else projects.set(session.workspaceId, {
      workspaceId: session.workspaceId,
      name: workspace.name || session.workspaceTitle,
      updatedAt: session.updatedAt,
      chats: 1,
      lastSessionId: session.sessionId,
    });
  }
  return [...projects.values()].slice(0, limit);
}

/** Chats whose title contains the query (the message text is searched separately, on this computer). */
export function titleMatches(sessions: SearchableSession[], query: string): SearchableSession[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return recentChats(sessions, Number.POSITIVE_INFINITY).filter((session) => session.title.toLowerCase().includes(needle));
}
