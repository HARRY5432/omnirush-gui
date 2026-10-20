/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { FolderGit2, Loader2, MessageSquare, Search } from "lucide-react";

import { formatRelativeTime } from "@/app/utils";
import { Input } from "@/components/ui/input";
import {
  createSessionSearcher,
  searchableSessionKey,
  type SearchableSession,
  type SessionMessageFetcher,
  type SessionSearchSnippet,
} from "@/react-app/domains/session/search/session-search";
import { homeChatTitle, recentChats, recentProjects, titleMatches, type HomeWorkspace } from "./home-view-model";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 200;
const RESULT_LIMIT = 8;

/** What the home screen needs; every read is of chats already on this computer. */
export type HomeViewContext = {
  sessions: SearchableSession[];
  workspaces: HomeWorkspace[];
  fetchMessages: SessionMessageFetcher | null;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
};

type SearchResult = { session: SearchableSession; snippet?: SessionSearchSnippet };

function useLocalChatSearch(context: HomeViewContext, query: string) {
  const searcher = useMemo(() => (context.fetchMessages ? createSessionSearcher(context.fetchMessages) : null), [context.fetchMessages]);
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (debounced.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setSearching(false);
      return;
    }
    const found = new Map<string, SearchResult>();
    for (const session of titleMatches(context.sessions, debounced)) found.set(searchableSessionKey(session), { session });
    setResults([...found.values()].slice(0, RESULT_LIMIT));
    if (!searcher) return;
    setSearching(true);
    const run = searcher.search({
      query: debounced,
      sessions: context.sessions,
      onMatch: (match) => {
        const key = searchableSessionKey(match.session);
        if (found.has(key) || found.size >= RESULT_LIMIT) return;
        found.set(key, { session: match.session, snippet: match.snippet });
        setResults([...found.values()]);
      },
      onProgress: (progress) => setSearching(!progress.done),
    });
    return () => run.cancel();
  }, [context.sessions, debounced, searcher]);

  return { results, searching, active: debounced.length >= MIN_QUERY_LENGTH };
}

export function HomeRecent({ context }: { context: HomeViewContext }) {
  const [query, setQuery] = useState("");
  const search = useLocalChatSearch(context, query);
  const projects = useMemo(() => recentProjects(context.sessions, context.workspaces), [context.sessions, context.workspaces]);
  const chats = useMemo(() => recentChats(context.sessions), [context.sessions]);
  if (!context.sessions.length) return null;

  return (
    <div className="space-y-4" data-testid="home-recent">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search your past chats"
          aria-label="Search your past chats"
          className="h-9 ps-8 text-[13px]"
          data-testid="home-search"
        />
        {search.searching ? <Loader2 className="absolute top-1/2 right-3 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" aria-label="Searching" /> : null}
      </div>

      {search.active ? (
        <section aria-label="Search results" className="space-y-1">
          {search.results.length ? search.results.map((result) => (
            <ChatRow key={searchableSessionKey(result.session)} session={result.session} snippet={result.snippet} onOpen={context.onOpenSession} />
          )) : (
            <p className="px-1 py-2 text-[12px] text-muted-foreground">{search.searching ? "Searching your chats…" : "No chat matches."}</p>
          )}
        </section>
      ) : (
        <>
          {projects.length ? (
            <section aria-label="Recent projects" className="space-y-1.5">
              <h3 className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Recent projects</h3>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {projects.map((project) => (
                  <button
                    key={project.workspaceId}
                    type="button"
                    className="flex min-w-0 flex-col items-start gap-0.5 rounded-lg border border-border/80 bg-background px-3 py-2 text-left transition-colors hover:bg-accent"
                    onClick={() => context.onOpenSession(project.workspaceId, project.lastSessionId)}
                    title={`Open the latest chat in ${project.name}`}
                    data-testid="home-project"
                  >
                    <span className="flex w-full min-w-0 items-center gap-1.5 text-[12px] font-medium text-foreground">
                      <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="truncate">{project.name}</span>
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {project.chats} chat{project.chats === 1 ? "" : "s"} · {formatRelativeTime(project.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <section aria-label="Recent chats" className="space-y-1">
            <h3 className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Recent chats</h3>
            {chats.map((session) => (
              <ChatRow key={searchableSessionKey(session)} session={session} onOpen={context.onOpenSession} />
            ))}
          </section>
        </>
      )}
    </div>
  );
}

function ChatRow(props: { session: SearchableSession; snippet?: SessionSearchSnippet; onOpen: (workspaceId: string, sessionId: string) => void }) {
  const { session, snippet } = props;
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
      onClick={() => props.onOpen(session.workspaceId, session.sessionId)}
      data-testid="home-chat"
    >
      <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[12px] font-medium text-foreground">{homeChatTitle(session.title)}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{formatRelativeTime(session.updatedAt)}</span>
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {snippet ? (
            <>
              {snippet.before}
              <mark className="rounded-sm bg-amber-3 px-0.5 text-foreground">{snippet.match}</mark>
              {snippet.after}
            </>
          ) : session.workspaceTitle}
        </span>
      </span>
    </button>
  );
}
