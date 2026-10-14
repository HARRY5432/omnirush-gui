/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, Trophy, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

import {
  desktopNotificationShow,
  omnirushBuildathon,
  omnirushBuildathonLink,
  omnirushBuildathonSessions,
  omnirushBuildathonTagSession,
  openDesktopUrl,
} from "../../../app/lib/desktop";
import {
  BUILDATHON_REFRESH_MS,
  buildathonChipText,
  buildathonCountdown,
  compactTokens,
  formatEventTime,
  formatRemaining,
  readProjectTrack,
  readProjectTracks,
  readShownReminders,
  readTaggedSessions,
  refreshBuildathon,
  reminderToShow,
  rememberShownReminders,
  rulesWithToolRuleFirst,
  sessionStatusLabel,
  sessionsToTag,
  setProjectTrack,
  tagSessions,
  useBuildathonStore,
  type BuildathonCountdown,
  type BuildathonSession,
  type BuildathonStatus,
  type BuildathonTrack,
} from "../../../app/lib/buildathon";

const readStatus = () => omnirushBuildathon();

/** The server clock, re-read every `intervalMs`. */
function useServerNow(intervalMs: number): number {
  const offsetMs = useBuildathonStore((store) => store.offsetMs);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now + offsetMs;
}

function useCountdown(status: BuildathonStatus | null): BuildathonCountdown | null {
  const now = useServerNow(1_000);
  return status ? buildathonCountdown(status.event, now) : null;
}

/** Header chip: "Buildathon · 5d 03h left", red in the last hour. Nothing unless enrolled. */
export function BuildathonChip() {
  const status = useBuildathonStore((store) => store.status);
  const countdown = useCountdown(status);
  if (!status || !countdown) return null;
  return (
    <button
      type="button"
      onClick={() => useBuildathonStore.getState().openPanel()}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[11.5px] font-medium tabular-nums transition-colors mac:titlebar-no-drag",
        countdown.urgent
          ? "border-red-500/50 bg-red-500/10 text-red-600 hover:bg-red-500/15 dark:text-red-400"
          : countdown.kind === "closed"
            ? "border-border bg-muted/40 text-muted-foreground hover:bg-muted"
            : "border-[#b9f45a]/50 bg-[#b9f45a]/10 text-foreground hover:bg-[#b9f45a]/20",
      )}
      title={`${status.event.name}: deadline ${formatEventTime(status.event.deadlineAt)}`}
      data-testid="buildathon-chip"
      data-urgent={countdown.urgent ? "true" : undefined}
    >
      <Trophy className="size-3.5" />
      <span>{buildathonChipText(countdown)}</span>
    </button>
  );
}

function trackOptions(status: BuildathonStatus): BuildathonTrack[] {
  return status.event.tracks;
}

/** A plain select of the event's tracks; "" is no track. */
function TrackSelect(props: { tracks: BuildathonTrack[]; value: string | null; onChange: (track: string | null) => void; testId?: string }) {
  return (
    <select
      value={props.value ?? ""}
      onChange={(event) => props.onChange(event.target.value || null)}
      className="h-8 w-full rounded-lg border border-dls-border bg-dls-surface px-2 text-[12px] text-dls-text"
      data-testid={props.testId}
      aria-label="Buildathon track"
    >
      <option value="">Not part of the buildathon</option>
      {props.tracks.map((track) => (
        <option key={track.id} value={track.id}>{track.label}</option>
      ))}
    </select>
  );
}

/** Project settings: the folder's track. Nothing unless enrolled. */
export function BuildathonTrackCard(props: { projectPath: string | null | undefined; projectName?: string | null }) {
  const status = useBuildathonStore((store) => store.status);
  const tracksVersion = useBuildathonStore((store) => store.tracksVersion);
  const track = useMemo(() => readProjectTrack(props.projectPath), [props.projectPath, tracksVersion]);
  if (!status || !props.projectPath) return null;
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">Buildathon</div>
      <div className="flex items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4" data-testid="buildathon-track-card">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <Trophy size={17} className="text-dls-secondary" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <div className="text-[13px] font-medium text-dls-text">Track for {props.projectName || "this project"}</div>
            <div className="text-[11px] text-dls-secondary">
              Chats you start in this project during {status.event.name} are filed under this track.
            </div>
          </div>
          <TrackSelect
            tracks={trackOptions(status)}
            value={track}
            onChange={(next) => setProjectTrack(props.projectPath, next)}
            testId="buildathon-track-select"
          />
        </div>
      </div>
    </div>
  );
}

function NewProjectPrompt(props: { status: BuildathonStatus; project: { path: string; name: string }; onDone: () => void }) {
  const [track, setTrack] = useState<string | null>(null);
  return (
    <div
      className="fixed bottom-4 right-4 z-40 w-80 space-y-3 rounded-2xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-xl"
      role="dialog"
      aria-label="Buildathon track for this project"
      data-testid="buildathon-new-project-prompt"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 font-medium"><Trophy className="size-3.5" /> Building for the buildathon?</div>
          <div className="mt-0.5 text-xs text-muted-foreground">Pick a track for “{props.project.name}”. You can change it later in Settings.</div>
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Not now" onClick={props.onDone}><X /></Button>
      </div>
      <TrackSelect tracks={trackOptions(props.status)} value={track} onChange={setTrack} testId="buildathon-prompt-select" />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="xs" onClick={props.onDone}>Not now</Button>
        <Button
          size="xs"
          disabled={!track}
          onClick={() => {
            setProjectTrack(props.project.path, track);
            props.onDone();
          }}
        >
          Save track
        </Button>
      </div>
    </div>
  );
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("Copied");
  } catch {
    toast.error("Could not copy", { description: <span className="select-all font-mono">{value}</span>, duration: Infinity });
  }
}

const SESSION_TONE: Record<BuildathonSession["status"], string> = {
  good: "bg-[#b9f45a]/20 text-foreground",
  pending: "bg-muted text-muted-foreground",
  incomplete: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
};

function SessionsList(props: { sessions: BuildathonSession[] | null | undefined; tracks: BuildathonTrack[] }) {
  if (props.sessions === undefined) return <div className="text-xs text-muted-foreground">Loading…</div>;
  if (props.sessions === null) return <div className="text-xs text-muted-foreground">Your sessions could not be loaded right now.</div>;
  if (!props.sessions.length) return <div className="text-xs text-muted-foreground">No sessions yet. Chats you start during the event show up here.</div>;
  const label = (id: string | null) => props.tracks.find((track) => track.id === id)?.label ?? null;
  return (
    <ul className="flex flex-col gap-1.5" data-testid="buildathon-sessions">
      {props.sessions.map((session) => (
        <li key={session.sessionId} className="rounded-lg border border-border px-3 py-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate font-medium">{session.title ?? session.project ?? session.sessionId}</span>
            <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium", SESSION_TONE[session.status])}>
              {sessionStatusLabel(session.status)}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {[session.project, label(session.track), session.tokens ? `${compactTokens(session.tokens)} tokens` : null].filter(Boolean).join(" · ")}
          </div>
          {session.reasons.length ? (
            <ul className="mt-1 list-disc ps-4 text-[11px] text-muted-foreground">
              {session.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function LinkCodeForm() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await omnirushBuildathonLink({ code });
      if (result.ok) {
        useBuildathonStore.getState().setStatus(result.status);
        setCode("");
        setMessage({ ok: true, text: "Code linked." });
      } else {
        setMessage({ ok: false, text: result.error });
      }
    } catch {
      setMessage({ ok: false, text: "The code could not be checked. Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5" data-testid="buildathon-link">
      <div className="text-xs text-muted-foreground">Registered with a different email? Enter the code from your registration email.</div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim() && !busy) void submit();
        }}
      >
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="FB-XXXX-XX"
          className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 font-mono text-xs uppercase"
          aria-label="Link code"
          data-testid="buildathon-link-input"
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !code.trim()}>{busy ? "Linking…" : "Link"}</Button>
      </form>
      {message ? <div className={cn("text-xs", message.ok ? "text-foreground" : "text-red-600 dark:text-red-400")}>{message.text}</div> : null}
    </div>
  );
}

function Section(props: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="space-y-2" data-testid={props.testId}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{props.title}</div>
      {props.children}
    </section>
  );
}

/** "My Buildathon": countdown, tokens, rules, sessions, submission, link code. */
export function BuildathonPanel(props: { status: BuildathonStatus; onClose: () => void }) {
  const { event, participant, submission } = props.status;
  const countdown = useCountdown(props.status)!;
  const [sessions, setSessions] = useState<BuildathonSession[] | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void omnirushBuildathonSessions().catch(() => null).then((list) => {
      if (live) setSessions(list ?? null);
    });
    return () => {
      live = false;
    };
  }, []);

  const granted = participant?.tokensGranted ?? 0;
  const left = participant?.tokensLeft ?? 0;
  const percent = granted > 0 ? Math.min(100, Math.max(0, (left / granted) * 100)) : 0;
  const rules = rulesWithToolRuleFirst(event.rules);
  const submitUrl = event.submitUrl;
  const trackLabel = event.tracks.find((track) => track.id === submission?.track)?.label ?? submission?.track ?? null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="gap-5 lg:max-w-lg" data-testid="buildathon-panel">
        <div>
          <DialogTitle className="flex items-center gap-2 text-base"><Trophy className="size-4" /> My Buildathon</DialogTitle>
          <DialogDescription className="text-xs">{event.name}</DialogDescription>
        </div>

        <div className="grid max-h-[65vh] gap-5 overflow-y-auto pe-1">
          <div className="grid grid-cols-2 gap-2">
            <div className={cn("rounded-xl border p-3", countdown.urgent ? "border-red-500/50 bg-red-500/5" : "border-border")} data-testid="buildathon-countdown">
              <div className="text-[11px] text-muted-foreground">
                {countdown.kind === "closed" ? "Submissions" : countdown.kind === "upcoming" ? "Starts in" : "Time left"}
              </div>
              <div className={cn("text-lg font-semibold tabular-nums", countdown.urgent && "text-red-600 dark:text-red-400")}>
                {countdown.kind === "closed" ? "Closed" : formatRemaining(countdown.remainingMs)}
              </div>
              <div className="text-[10.5px] text-muted-foreground">Deadline {formatEventTime(event.deadlineAt)}</div>
            </div>
            <div className="rounded-xl border border-border p-3" data-testid="buildathon-tokens">
              <div className="text-[11px] text-muted-foreground">Event tokens left</div>
              <div className="text-lg font-semibold tabular-nums">
                {compactTokens(left)} <span className="text-xs font-normal text-muted-foreground">of {compactTokens(granted)}</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div className="h-full rounded-full bg-[#b9f45a]" style={{ width: `${percent}%` }} />
              </div>
            </div>
          </div>

          <Section title="Submission" testId="buildathon-submission">
            {submission ? (
              <div className="space-y-1.5 rounded-lg border border-border px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{submission.title ?? "Your project"}</span>
                  <span className="shrink-0 text-muted-foreground">{submission.locked ? "Final" : "Submitted"}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">ID</span>
                  <code className="select-all rounded bg-muted px-1.5 py-0.5 font-mono" data-testid="buildathon-submission-id">{submission.submissionId}</code>
                  <Button variant="ghost" size="icon-xs" aria-label="Copy submission ID" onClick={() => void copyText(submission.submissionId)}><Copy /></Button>
                </div>
                {trackLabel ? <div className="text-muted-foreground">Track: {trackLabel}</div> : null}
                {submission.checks.length ? (
                  <ul className="space-y-0.5">
                    {submission.checks.map((check) => (
                      <li key={check.id} className={check.ok ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}>
                        {check.ok ? "✓" : "!"} {check.text || check.id}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                {countdown.kind === "closed" ? "No submission was made." : "Not submitted yet. You need a public GitHub repo, README, demo video, live URL, a track and the sessions you built it in."}
              </div>
            )}
            {submitUrl && countdown.kind !== "closed" && !submission?.locked ? (
              <Button size="sm" onClick={() => void openDesktopUrl(submitUrl).catch(() => undefined)} data-testid="buildathon-submit">
                {submission ? "Update submission" : "Submit"} <ExternalLink className="size-3.5" />
              </Button>
            ) : null}
          </Section>

          <Section title="Rules" testId="buildathon-rules">
            <ul className="space-y-1 text-xs">
              {rules.map((rule, index) => (
                <li key={rule} className={cn("rounded-lg px-2.5 py-1.5", index === 0 ? "border border-[#b9f45a]/60 bg-[#b9f45a]/10 font-medium" : "text-muted-foreground")}>
                  {rule}
                </li>
              ))}
            </ul>
            {event.pageUrl ? (
              <button type="button" className="inline-flex items-center gap-1 text-xs text-primary hover:underline" onClick={() => void openDesktopUrl(event.pageUrl!).catch(() => undefined)}>
                Event page <ExternalLink className="size-3" />
              </button>
            ) : null}
          </Section>

          <Section title={`Your sessions${participant ? ` · ${participant.sessionsGood} of ${participant.sessionsTagged} count` : ""}`}>
            <SessionsList sessions={sessions} tracks={event.tracks} />
          </Section>

          <Section title="Link code">
            <LinkCodeForm />
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The event over the app (desktop): reads the event at start and every 10
 * minutes without holding anything up, shows each server reminder once,
 * files sessions under their project's track, asks once for a new project's
 * track, and hosts the panel. Renders nothing unless enrolled.
 */
export function BuildathonLayer() {
  const status = useBuildathonStore((store) => store.status);
  const panelOpen = useBuildathonStore((store) => store.panelOpen);
  const projects = useBuildathonStore((store) => store.projects);
  const newProjects = useBuildathonStore((store) => store.newProjects);
  const tracksVersion = useBuildathonStore((store) => store.tracksVersion);
  const now = useServerNow(15_000);

  useEffect(() => {
    // Deferred so the first screen never waits on it.
    const first = window.setTimeout(() => void refreshBuildathon(readStatus), 1_500);
    const timer = window.setInterval(() => void refreshBuildathon(readStatus), BUILDATHON_REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  // Reminders: the server's texts, each once.
  useEffect(() => {
    if (!status) return;
    const due = reminderToShow(status.event, buildathonCountdown(status.event, now), readShownReminders());
    if (!due) return;
    rememberShownReminders(due.keys);
    toast.info(status.event.name, { description: due.text, duration: 15_000 });
    void desktopNotificationShow({ title: status.event.name, body: due.text }).catch(() => undefined);
  }, [status, now]);

  // Tell the server each event session's track (fire-and-forget).
  useEffect(() => {
    if (!status) return;
    const pending = sessionsToTag(projects, status.event, readProjectTracks(), readTaggedSessions());
    if (!pending.length) return;
    void tagSessions(pending, (input) => omnirushBuildathonTagSession(input));
  }, [status, projects, tracksVersion]);

  const closePrompt = useCallback((path: string) => useBuildathonStore.getState().dropNewProject(path), []);
  const prompt = status && status.event && buildathonCountdown(status.event, now).kind !== "closed"
    ? newProjects.find((project) => !readProjectTrack(project.path)) ?? null
    : null;

  if (!status) return null;
  return (
    <>
      {prompt ? <NewProjectPrompt key={prompt.path} status={status} project={prompt} onDone={() => closePrompt(prompt.path)} /> : null}
      {panelOpen ? <BuildathonPanel status={status} onClose={() => useBuildathonStore.getState().closePanel()} /> : null}
    </>
  );
}
