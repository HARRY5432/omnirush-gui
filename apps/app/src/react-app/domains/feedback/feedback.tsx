/** @jsxImportSource react */
// In-app feedback (app/lib/in-app-feedback.ts; the main process decides).
//
// - After a finished, eligible turn, when the main process says so: a quiet
//   "How was this?" with thumbs up / down under the last answer, fading in.
//   Not modal, never while a turn runs; it goes when the next turn starts,
//   when a new prompt is typed, on × or Esc. Thumbs down opens reasons and
//   a one-line comment, thumbs up a one-line "What worked?"; the rating is
//   sent even when the follow-up is ignored. Or, instead, the 0-10 pulse.
// - Anytime: "Send feedback" (account menu, command palette) opens a small
//   dialog: category, text, "Include this chat's id".
// The prompt is drawn next to the transcript, never part of its messages.

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { UIMessage } from "ai";
import { ThumbsDown, ThumbsUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import {
  closeFeedbackDialog,
  closePrompt,
  COMMENT_MAX,
  feedbackTurnStarted,
  finishedTurn,
  GENERAL_CATEGORIES,
  lastAnswerId,
  includeSessionChecked,
  installFeedbackAnalytics,
  offerFeedbackAfterTurn,
  PULSE_QUESTION,
  RATING_NOTE,
  ratePulse,
  rateTurn,
  resultToast,
  sendFeedbackDialog,
  sendPrompt,
  setDialogCategory,
  setDialogIncludeSession,
  setDialogText,
  setFeedbackNotifier,
  setPromptComment,
  toggleTurnReason,
  TURN_REASONS,
  turnJustFinished,
  useFeedbackStore,
  type FeedbackDialogState,
  type GeneralCategoryId,
  type TurnPrompt,
  type TurnReasonId,
} from "../../../app/lib/in-app-feedback";
import { promptSentHereAt } from "../../../app/lib/analytics";

/** The engine says idle a moment before it writes a failed turn's error: the turn is read after this. */
const SETTLE_MS = 1_200;
/** …and waited for up to this long while the answer still looks open. */
const SETTLE_MAX_MS = 4_500;

// --- after a turn -----------------------------------------------------------------------

/** Typing in the composer this recently: not now. */
const QUIET_INPUT_MS = 3_000;
/** A toast or dialog on screen (the Good-session card, the finish guard): wait, at most this long, then let it be. */
const WAIT_FOR_CLEAR_MS = 20_000;

/** Something else is up on screen: a toast (the Good-session card) or a dialog. The thumbs never stack with it. */
function screenBusy(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector('[data-sonner-toast]:not([data-removed="true"]), [role="dialog"], [role="alertdialog"]'));
}

export type FeedbackTurnPromptProps = {
  sessionId: string;
  messages: readonly UIMessage[];
  turnRunning: boolean;
  /** The composer's draft: typing a new prompt puts the prompt away. */
  draft: string;
  modelId: string | null;
  effort: string | null;
  /** Follow-ups waiting to be sent: the next turn is coming, not now. */
  queuedCount: number;
  /** False for sessions a person does not drive here (sub-agents, automations). */
  askable: boolean;
  /** After Send, Skip or ×: focus back to the composer. */
  onDone?: () => void;
};

/**
 * Watches this session's turns: on the running → done edge it reads how
 * the turn ended and, when the moment is quiet (nothing typed, nothing
 * queued, no card or dialog up), asks the main process; draws the prompt it
 * gets under the last answer only.
 */
export function FeedbackTurnPrompt(props: FeedbackTurnPromptProps) {
  const prompt = useFeedbackStore((state) => state.prompt);
  const latest = useRef(props);
  latest.current = props;
  const edge = useRef({ sessionId: props.sessionId, running: props.turnRunning });
  const startedAt = useRef<number | null>(null);
  const lastInputAt = useRef(0);
  const draftSeen = useRef(props.draft);
  if (draftSeen.current !== props.draft) {
    draftSeen.current = props.draft;
    lastInputAt.current = Date.now();
  }

  useEffect(() => {
    const before = edge.current;
    const now = { sessionId: props.sessionId, running: props.turnRunning };
    edge.current = now;
    if (props.turnRunning) {
      if (!before.running || before.sessionId !== props.sessionId) {
        startedAt.current = Date.now();
        feedbackTurnStarted(props.sessionId);
      }
      return;
    }
    if (!turnJustFinished(before, now)) return;
    const sessionId = props.sessionId;
    const began = startedAt.current ?? Date.now();
    const settleBy = Date.now() + SETTLE_MAX_MS;
    const clearBy = Date.now() + WAIT_FOR_CLEAR_MS;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    // The same session, idle, the same last answer, nothing typed or queued.
    const quiet = (messageId: string) => {
      const current = latest.current;
      return current.sessionId === sessionId && !current.turnRunning && current.askable && !current.draft.trim()
        && current.queuedCount === 0 && lastAnswerId(current.messages) === messageId && Date.now() - lastInputAt.current >= QUIET_INPUT_MS;
    };
    const judge = () => {
      if (cancelled) return;
      const current = latest.current;
      if (current.sessionId !== sessionId || current.turnRunning || !current.askable) return;
      // Only turns a person started from this window (never Workflows, automations or sub-agents).
      const sent = promptSentHereAt(sessionId);
      if (sent === null || sent < began - 60_000) return;
      const turn = finishedTurn(current.messages);
      if (!turn) {
        if (Date.now() < settleBy) timer = setTimeout(judge, 150);
        return;
      }
      if (!quiet(turn.messageId) || screenBusy()) {
        if (Date.now() < clearBy) timer = setTimeout(judge, 400);
        return;
      }
      void offerFeedbackAfterTurn({
        sessionId,
        turn,
        fallbackDurationMs: Date.now() - began,
        modelId: current.modelId,
        effort: current.effort,
        stillCurrent: () => !cancelled && quiet(turn.messageId),
      });
    };
    timer = setTimeout(judge, SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [props.sessionId, props.turnRunning]);

  // This pane switches to another session, or goes: the prompt it showed goes (its rating, if chosen, is sent).
  const shownSession = useRef(props.sessionId);
  useEffect(() => {
    const left = shownSession.current;
    shownSession.current = props.sessionId;
    if (left !== props.sessionId) void closePrompt(left);
  }, [props.sessionId]);
  useEffect(() => () => void closePrompt(shownSession.current), []);

  const visible = prompt !== null && prompt.sessionId === props.sessionId && !props.turnRunning && prompt.messageId === lastAnswerId(props.messages);
  // Typing a new prompt (the draft changing after the prompt showed) puts it away.
  const draftAtShow = useRef<string | null>(null);
  useEffect(() => {
    if (!visible) {
      draftAtShow.current = null;
      return;
    }
    if (draftAtShow.current === null) {
      draftAtShow.current = props.draft;
      return;
    }
    if (props.draft !== draftAtShow.current && props.draft.trim()) void closePrompt(props.sessionId);
  }, [visible, props.draft, props.sessionId]);

  if (!visible || !prompt) return null;
  const done = () => latest.current.onDone?.();
  return (
    <FeedbackTurnPromptView
      prompt={prompt}
      onRate={rateTurn}
      onPulse={ratePulse}
      onToggleReason={toggleTurnReason}
      onComment={setPromptComment}
      onSend={() => void sendPrompt().then((result) => { if (!useFeedbackStore.getState().prompt && result) done(); })}
      onSkip={() => void sendPrompt({ skip: true }).then((result) => { if (!useFeedbackStore.getState().prompt && result) done(); })}
      onDismiss={() => {
        void closePrompt(props.sessionId);
        done();
      }}
    />
  );
}

export type FeedbackTurnPromptViewProps = {
  prompt: TurnPrompt;
  onRate: (rating: "up" | "down") => void;
  onPulse: (score: number) => void;
  onToggleReason: (id: TurnReasonId) => void;
  onComment: (text: string) => void;
  onSend: () => void;
  onSkip: () => void;
  onDismiss: () => void;
};

const thumbClass = "size-7 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground";
const chipClass = "h-7 px-2.5 text-[12px] text-muted-foreground aria-pressed:border-foreground/25 aria-pressed:text-foreground";

function CommentRow(props: { prompt: TurnPrompt; placeholder: string; onComment: (text: string) => void; onSend: () => void; onSkip: () => void; testId: string }) {
  // The pulse is about OmniRush, not this chat: it carries no chat id.
  const note = props.prompt.kind === "pulse" ? null : RATING_NOTE;
  return (
    <>
    <div className="flex w-full max-w-xl items-center gap-2">
      <Input
        autoFocus
        value={props.prompt.comment}
        maxLength={COMMENT_MAX}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        onChange={(event) => props.onComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            props.onSend();
          }
        }}
        className="h-8 flex-1 text-[13px]"
        data-testid={props.testId}
      />
      <Button size="sm" className="h-8" onClick={props.onSend} disabled={props.prompt.sending} data-testid="feedback-send">Send</Button>
      <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={props.onSkip} disabled={props.prompt.sending} data-testid="feedback-skip">Skip</Button>
    </div>
    {props.prompt.error ? (
      <p role="alert" className="text-[12px] leading-4 text-destructive" data-testid="feedback-error">{props.prompt.error}</p>
    ) : null}
    {note ? <p className="text-[11px] leading-4 text-muted-foreground/80" data-testid="feedback-note">{note}</p> : null}
    </>
  );
}

/** The prompt itself (tests render it directly). */
export function FeedbackTurnPromptView(props: FeedbackTurnPromptViewProps) {
  const { prompt } = props;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      props.onDismiss();
    }
  };
  const dismiss = (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Dismiss"
      title="Dismiss"
      onClick={props.onDismiss}
      className="text-muted-foreground/70 hover:text-foreground"
      data-testid="feedback-dismiss"
    >
      <X aria-hidden="true" />
    </Button>
  );
  return (
    <div
      role="group"
      aria-label={prompt.kind === "pulse" ? PULSE_QUESTION : "How was this?"}
      data-testid={prompt.kind === "pulse" ? "feedback-pulse" : "feedback-turn"}
      data-stage={prompt.stage}
      data-feedback-ui="true"
      onKeyDown={onKeyDown}
      className="not-prose mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 pb-2 duration-200 animate-in fade-in-0 motion-reduce:animate-none md:px-10"
    >
      {prompt.kind === "pulse" ? (
        <>
          <div className="flex w-full items-center gap-2">
            <span className="text-[12.5px] text-muted-foreground">{PULSE_QUESTION}</span>
            <span className="flex-1" />
            {dismiss}
          </div>
          <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="0 = not likely, 10 = very likely">
            <span className="me-1 text-[11px] text-muted-foreground/80">Not likely</span>
            {Array.from({ length: 11 }, (_, score) => (
              <button
                key={score}
                type="button"
                role="radio"
                aria-checked={prompt.rating === score}
                onClick={() => props.onPulse(score)}
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-lg border border-border text-[12px] tabular-nums text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground",
                  prompt.rating === score && "border-foreground bg-foreground text-background hover:text-background",
                )}
                data-testid={`feedback-pulse-${score}`}
              >
                {score}
              </button>
            ))}
            <span className="ms-1 text-[11px] text-muted-foreground/80">Very likely</span>
          </div>
          {typeof prompt.rating === "number" ? (
            <CommentRow prompt={prompt} placeholder="Why? (optional)" onComment={props.onComment} onSend={props.onSend} onSkip={props.onSkip} testId="feedback-comment" />
          ) : null}
        </>
      ) : (
        <>
          <div className="flex items-center gap-1">
            <span className="me-1 text-[12px] text-muted-foreground">How was this?</span>
            <Button variant="ghost" size="icon-xs" className={thumbClass} aria-label="Good answer" title={`Good answer. ${RATING_NOTE}`} aria-pressed={prompt.rating === "up"} onClick={() => props.onRate("up")} data-testid="feedback-up">
              <ThumbsUp className="size-3.5" aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="icon-xs" className={thumbClass} aria-label="Bad answer" title={`Bad answer. ${RATING_NOTE}`} aria-pressed={prompt.rating === "down"} onClick={() => props.onRate("down")} data-testid="feedback-down">
              <ThumbsDown className="size-3.5" aria-hidden="true" />
            </Button>
            {dismiss}
          </div>
          {prompt.stage === "down" ? (
            <>
              <ToggleGroup
                multiple
                aria-label="What went wrong?"
                variant="outline"
                size="sm"
                spacing={1.5}
                value={prompt.reasons}
                onValueChange={(value) => {
                  // The one reason pressed or released.
                  const next = value.filter((id): id is TurnReasonId => TURN_REASONS.some((r) => r.id === id));
                  const changed = TURN_REASONS.find((r) => next.includes(r.id) !== prompt.reasons.includes(r.id));
                  if (changed) props.onToggleReason(changed.id);
                }}
                className="flex-wrap"
              >
                {TURN_REASONS.map((reason) => (
                  <ToggleGroupItem key={reason.id} value={reason.id} className={chipClass} data-testid={`feedback-reason-${reason.id}`}>
                    {reason.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <CommentRow prompt={prompt} placeholder="Anything to add? (optional)" onComment={props.onComment} onSend={props.onSend} onSkip={props.onSkip} testId="feedback-comment" />
            </>
          ) : prompt.stage === "up" ? (
            <CommentRow prompt={prompt} placeholder="What worked? (optional)" onComment={props.onComment} onSend={props.onSend} onSkip={props.onSkip} testId="feedback-comment" />
          ) : null}
        </>
      )}
    </div>
  );
}

// --- "Send feedback" ----------------------------------------------------------------------

export type FeedbackFormViewProps = {
  dialog: FeedbackDialogState;
  onCategory: (category: GeneralCategoryId) => void;
  onText: (text: string) => void;
  onIncludeSession: (include: boolean) => void;
  onSend: () => void;
  onCancel: () => void;
};

export const FEEDBACK_DIALOG_DESCRIPTION = "Tell us what's working and what isn't. It goes to the OmniRush team with your account.";

/** The dialog's form under its title (tests render it directly). */
export function FeedbackFormView(props: FeedbackFormViewProps) {
  const { dialog } = props;
  const canSend = Boolean(dialog.text.trim()) && !dialog.sending;
  return (
    <>
      <div className="flex flex-col gap-3" data-testid="feedback-form">
        <ToggleGroup
          aria-label="Category"
          variant="outline"
          size="sm"
          value={[dialog.category]}
          onValueChange={(value) => {
            const next = value[0];
            if (GENERAL_CATEGORIES.some((c) => c.id === next)) props.onCategory(next as GeneralCategoryId);
          }}
          className="w-full"
        >
          {GENERAL_CATEGORIES.map((category) => (
            <ToggleGroupItem key={category.id} value={category.id} className="flex-1" data-testid={`feedback-category-${category.id}`}>
              {category.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Textarea
          autoFocus
          value={dialog.text}
          maxLength={COMMENT_MAX}
          rows={4}
          placeholder={dialog.category === "bug" ? "What happened, and what did you expect?" : dialog.category === "idea" ? "What would make OmniRush better for you?" : "Your feedback"}
          aria-label="Your feedback"
          onChange={(event) => props.onText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSend) {
              event.preventDefault();
              props.onSend();
            }
          }}
          className="min-h-24"
          data-testid="feedback-text"
        />
        {dialog.error ? (
          <p role="alert" className="text-[13px] text-destructive" data-testid="feedback-dialog-error">{dialog.error}</p>
        ) : null}
        {dialog.sessionId ? (
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-muted-foreground" data-testid="feedback-include-session">
            <Checkbox checked={includeSessionChecked(dialog)} onCheckedChange={(checked) => props.onIncludeSession(checked === true)} />
            Include this chat's id
          </label>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={props.onCancel} data-testid="feedback-cancel">Cancel</Button>
        <Button onClick={props.onSend} disabled={!canSend} data-testid="feedback-dialog-send">Send</Button>
      </DialogFooter>
    </>
  );
}

function notifyResult(result: Parameters<Parameters<typeof setFeedbackNotifier>[0]>[0]) {
  const words = resultToast(result);
  if (!words) return;
  if (words.kind === "sent") toast.success(words.title, { id: "feedback-result", duration: 3_000 });
  else toast(words.title, { id: "feedback-result", duration: 4_000 });
}

/** Mounted once in the app: the dialog, the toast after a send, the analytics hand-off. */
export function FeedbackDialog() {
  const dialog = useFeedbackStore((state) => state.dialog);
  useEffect(() => {
    installFeedbackAnalytics();
    setFeedbackNotifier(notifyResult);
  }, []);
  return (
    <Dialog open={dialog.open} onOpenChange={(open) => { if (!open) closeFeedbackDialog(); }}>
      <DialogContent className="lg:max-w-lg" data-testid="feedback-dialog">
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>{FEEDBACK_DIALOG_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        <FeedbackFormView
          dialog={dialog}
          onCategory={setDialogCategory}
          onText={setDialogText}
          onIncludeSession={setDialogIncludeSession}
          onSend={() => void sendFeedbackDialog()}
          onCancel={closeFeedbackDialog}
        />
      </DialogContent>
    </Dialog>
  );
}
