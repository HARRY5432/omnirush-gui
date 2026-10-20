// Types of home-view.mjs (the shared module itself is plain JavaScript).

export type StoredChat = { id: string; title?: string | null; directory: string; updatedAt: number; parentId?: string | null; archived?: boolean };
export type RecentChat = { id: string; title: string; directory: string; project: string; updatedAt: number };
export type RecentProject = { directory: string; name: string; updatedAt: number; chats: number; lastSessionId: string; task: boolean };
export type SearchHit = { sessionId: string; title?: string | null; directory: string; updatedAt: number; text?: string | null; role?: string | null };
export type RankedResult = { sessionId: string; title: string; directory: string; project: string; updatedAt: number; score: number; excerpt: string; role: string | null };

export const RECENT_SESSIONS: number;
export const RECENT_PROJECTS: number;
export const SEARCH_RESULTS: number;
export const SNIPPET_WIDTH: number;

export function projectName(directory: string): string;
export function isTaskFolder(directory: string): boolean;
export function relativeAge(ms: number, now?: number): string;
export function chatTitle(title: string | null | undefined): string;
export function recentView(sessions: StoredChat[], options?: { sessionLimit?: number; projectLimit?: number }): { sessions: RecentChat[]; projects: RecentProject[] };
export function searchTerms(query: string): string[];
export function matchesAll(text: string, terms: string[]): boolean;
export function snippet(text: string, terms: string[], width?: number): string;
export function rankHits(hits: SearchHit[], query: string, options?: { limit?: number }): RankedResult[];
