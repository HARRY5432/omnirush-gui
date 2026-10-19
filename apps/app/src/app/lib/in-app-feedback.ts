// In-app feedback, renderer side. The Electron main process decides and
// sends (apps/desktop/electron/feedback-desktop.mjs and the shared
// feedback/feedback.mjs, the same rules as the CLI's): whether to ask after
// a finished turn (the server's policy, once per session, once a day, the
// sample rate, the pulse), the payload, the queue (feedback.json in the app's
// data folder) and the analytics event names.
//
// Here: how the last turn ended (from the transcript the window already
// shows), the prompt under the last answer and the "Send feedback" dialog
// (both in a small store, never in a session's messages), and the toast after
// a send. Feedback never goes into the transcript, the composer, the model's
// context or anything a session uploads.

import type { UIMessage } from "ai";
import { create } from "zustand";

import type {
  OmniRushFeedbackInput,
  OmniRushFeedbackOffer,
  OmniRushFeedbackResult,
  OmniRushFeedbackTrigger,
  OmniRushFeedbackTurnOutcome,
} from "@omnirush/types/desktop-ipc";

import { captureAnalyticsEvent, type AnalyticsProperties } from "./analytics";
import {
  omnirushFeedbackOffer,
  omnirushFeedbackSessionStarted,
  omnirushFeedbackShown,
  omnirushFeedbackSubmit,
} from "./desktop";
import { messageFacts, promptsInTranscript } from "./good-session";

/** After a thumbs down (the shared module's TURN_REASONS, same ids and words). */
export const TURN_REASONS = [
  { id: "wrong", label: "Wrong" },
  { id: "slow", label: "Too slow" },
  { id: "instructions", label: "Didn't follow instructions" },
  { id: "broke", label: "Broke something" },
  { id: "ui", label: "UI problem" },
  { id: "other", label: "Other" },
] as const;
/** Anytime feedback (the shared module's GENERAL_CATEGORIES). */
export const GENERAL_CATEGORIES = [
  { id: "bug", label: "Bug" },
  { id: "idea", label: "Idea" },
  { id: "praise", label: "Praise" },
  { id: "other", label: "Other" },
] as const;
export const PULSE_QUESTION = "How likely are you to recommend OmniRush to a friend?";
export const COMMENT_MAX = 1_000;
export const SENT_TOAST = "Thanks, sent.";
/** Kept for later (offline, signed out, the server has none yet): never an error look. */
export const QUEUED_TOAST = "Thanks, saved for later.";
/** Under the follow-up: what the rating carries. */
export const RATING_NOTE = "Sent to the OmniRush team with this chat's id. Not part of the chat.";
export const TOO_LARGE_ERROR = "That's too long to send";
export const SEND_FAILED = "Couldn't send. Try again.";
/** The two analytics events the main process forwards (labels only). */
const EVENT_NAMES = new Set(["feedback_prompt_shown", "feedback_submitted"]);
const EVENT_CHANNEL = "omnirush:feedback:event";

export type TurnReasonId = (typeof TURN_REASONS)[number]["id"];
export type GeneralCategoryId = (typeof GENERAL_CATEGORIES)[number]["id"];

// --- how the last turn ended -------------------------------------------------------

export type FinishedTurn = {
  outcome: OmniRushFeedbackTurnOutcome;
  toolCalls: number;
  /** ms from the prompt to the end of the answer; null when the transcript does not say. */
  durationMs: number | null;
  /** The answer's final text (at most 700 characters): only to tell a refusal. */
  text: string;
  /** 1-based index of the prompt this answers. */
  turn: number;
  /** The last assistant message of the turn. */
  messageId: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function opencodeMeta(message: UIMessage): Record<string, unknown> {
  return record(record(message.metadata).opencode);
}

/** A prompt a person sent: a user message that is not a compaction request or only synthetic text ("Continue."). */
function isRealPrompt(message: UIMessage): boolean {
  return message.role === "user" && opencodeMeta(message).compaction !== true && promptsInTranscript([message]) === 1;
}

/**
 * How the last turn of a transcript ended, or null when there is nothing to
 * rate: no answer yet, an answer still open, an agent waiting for an answer
 * to its question, or a compaction. The turn starts at the last prompt a
 * person sent, past the synthetic "continue" and compaction messages an
 * automatic compaction adds. Uses the same reading as the Good-session
 * checklist (messageFacts): a normal finish is "ok"; the Stop button
 * "stopped"; a gateway refusal, a spent allowance or any other error "error".
 */
export function finishedTurn(messages: readonly UIMessage[]): FinishedTurn | null {
  let start = messages.length;
  while (start > 0 && !isRealPrompt(messages[start - 1]!)) start -= 1;
  if (start === 0) return null;
  const prompt = messages[start - 1]!;
  const assistants = messages.slice(start).filter((message) => message.role === "assistant");
  const last = assistants.at(-1);
  // The last answer is a compaction's summary: no agent turn to rate.
  if (!last || opencodeMeta(last).compaction === true) return null;
  const answer = assistants.filter((message) => opencodeMeta(message).compaction !== true);
  const facts = messageFacts(messages);
  // "awaiting": the agent asked the person something; the turn is not over.
  if (facts.replyOpen || facts.ended === "none" || facts.ended === "awaiting") return null;
  let outcome: OmniRushFeedbackTurnOutcome;
  if (facts.ended === "pass") outcome = "ok";
  else if (facts.ended === "stopped") outcome = "stopped";
  else outcome = "error";
  let toolCalls = 0;
  let text = "";
  for (const message of answer) {
    for (const part of message.parts) {
      if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
        toolCalls += 1;
        text = "";
      } else if (part.type === "text") {
        const value = (part as { text?: unknown }).text;
        if (typeof value === "string" && value.trim()) text = value;
      }
    }
  }
  const created = opencodeMeta(prompt).created;
  const completed = opencodeMeta(last).completed;
  const durationMs = typeof created === "number" && typeof completed === "number" && completed >= created ? completed - created : null;
  const turn = promptsInTranscript(messages.slice(0, start));
  return { outcome, toolCalls, durationMs, text: text.trim().slice(0, 700), turn, messageId: last.id };
}

/** The last assistant message's id (the prompt shows only under that answer). */
export function lastAnswerId(messages: readonly UIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]!.role === "assistant") return messages[i]!.id;
  return null;
}

/** The running → done edge of one session's turn. */
export function turnJustFinished(before: { sessionId: string; running: boolean }, now: { sessionId: string; running: boolean }): boolean {
  return before.sessionId === now.sessionId && before.running && !now.running;
}

// --- the store ---------------------------------------------------------------------

export type TurnPromptStage = "rate" | "down" | "up" | "pulse";

export type TurnPrompt = {
  sessionId: string;
  kind: "turn" | "pulse";
  stage: TurnPromptStage;
  /** The rated answer: its prompt's index, the model and effort of the turn. */
  turn: number;
  messageId: string;
  modelId: string | null;
  effort: string | null;
  rating: "up" | "down" | number | null;
  reasons: TurnReasonId[];
  comment: string;
  /** The server refused the last Send (shown inline; the prompt stays). */
  error: string | null;
  sending: boolean;
};

export type FeedbackDialogState = {
  open: boolean;
  trigger: "menu" | "command";
  /** The session open when the dialog opened (offered as "Include this chat's id"). */
  sessionId: string | null;
  category: GeneralCategoryId;
  text: string;
  /** null: the default for the category (on for Bug); true/false: the person's own choice. */
  includeSession: boolean | null;
  sending: boolean;
  /** The server refused the last Send (shown inline; the text stays). */
  error: string | null;
  /** Which opening this is: a late answer to an earlier one leaves a reopened dialog alone. */
  openId: number;
};

type FeedbackState = {
  prompt: TurnPrompt | null;
  dialog: FeedbackDialogState;
};

const closedDialog: FeedbackDialogState = { open: false, trigger: "menu", sessionId: null, category: "bug", text: "", includeSession: null, sending: false, error: null, openId: 0 };
let dialogOpens = 0;

export const useFeedbackStore = create<FeedbackState>(() => ({ prompt: null, dialog: closedDialog }));

function setPrompt(update: Partial<TurnPrompt>) {
  useFeedbackStore.setState((state) => ({ prompt: state.prompt ? { ...state.prompt, ...update } : null }));
}

function setDialog(update: Partial<FeedbackDialogState>) {
  useFeedbackStore.setState((state) => ({ dialog: { ...state.dialog, ...update } }));
}

// --- the main process ----------------------------------------------------------------

type Bridge = {
  offer: (input: { sessionId: string; outcome: OmniRushFeedbackTurnOutcome; toolCalls: number; durationMs: number; text?: string }) => Promise<OmniRushFeedbackOffer>;
  sessionStarted: (input: { sessionId: string }) => Promise<unknown>;
  shown: (input: { kind: "turn" | "pulse" }) => Promise<unknown>;
  submit: (input: OmniRushFeedbackInput) => Promise<OmniRushFeedbackResult>;
};

let bridge: Bridge = {
  offer: (input) => omnirushFeedbackOffer(input),
  sessionStarted: (input) => omnirushFeedbackSessionStarted(input),
  shown: (input) => omnirushFeedbackShown(input),
  submit: (input) => omnirushFeedbackSubmit(input),
};

type Notify = (result: OmniRushFeedbackResult) => void;
let notify: Notify = () => undefined;

/** The toast after a send (the feedback UI sets it). */
export function setFeedbackNotifier(next: Notify) {
  notify = next;
}

/** Tests: a stand-in for the main process, and a fresh state. */
export function setFeedbackBridgeForTests(next: Bridge | null): void {
  if (next) bridge = next;
  useFeedbackStore.setState({ prompt: null, dialog: closedDialog });
}

/**
 * Why the server refused a send, for the person to fix: a 422 names its
 * fields ("Couldn't send: comment: too long"), a 413 is too long. Null when
 * it was sent or kept for later.
 */
export function refusalText(result: OmniRushFeedbackResult): string | null {
  if (result.ok) return null;
  if (result.error === "too_large") return TOO_LARGE_ERROR;
  if (result.error !== "invalid") return null;
  const fields = Object.entries(result.errors ?? {}).filter(([, why]) => typeof why === "string").map(([field, why]) => `${field}: ${why}`);
  return fields.length ? `Couldn't send: ${fields.join("; ")}` : "Couldn't send: the server did not accept it";
}

/** The words of the toast after a send: sent, or kept for later (never an error look). */
export function resultToast(result: OmniRushFeedbackResult): { kind: "sent" | "queued"; title: string } | null {
  if (!result.ok) return null;
  return result.sent ? { kind: "sent", title: SENT_TOAST } : { kind: "queued", title: QUEUED_TOAST };
}

async function send(input: OmniRushFeedbackInput, { toast = true } = {}): Promise<OmniRushFeedbackResult> {
  let result: OmniRushFeedbackResult;
  try {
    result = await bridge.submit(input);
  } catch {
    result = { ok: false, error: "failed" };
  }
  if (toast) notify(result);
  return result;
}

// --- after a turn ----------------------------------------------------------------------

/** A turn started in this session: the pulse counts sessions; this session's open prompt goes (its rating is sent). */
export function feedbackTurnStarted(sessionId: string) {
  void bridge.sessionStarted({ sessionId }).catch(() => undefined);
  void closePrompt(sessionId);
}

/**
 * The turn of `sessionId` finished: ask the main process whether to ask
 * now. Shows the prompt (and reports it shown once) when it says so.
 */
export async function offerFeedbackAfterTurn(input: {
  sessionId: string;
  turn: FinishedTurn;
  fallbackDurationMs: number;
  modelId: string | null;
  effort: string | null;
  /** Checked again once the main process answers: same session, idle, the same last answer, nothing typed. */
  stillCurrent?: () => boolean;
}): Promise<OmniRushFeedbackOffer> {
  const { turn } = input;
  let offer: OmniRushFeedbackOffer = null;
  try {
    offer = await bridge.offer({
      sessionId: input.sessionId,
      outcome: turn.outcome,
      toolCalls: turn.toolCalls,
      durationMs: turn.durationMs ?? Math.max(0, input.fallbackDurationMs),
      text: turn.text,
    });
  } catch {
    offer = null;
  }
  if (!offer || (offer.kind !== "turn" && offer.kind !== "pulse")) return null;
  if (input.stillCurrent && !input.stillCurrent()) return null;
  useFeedbackStore.setState({
    prompt: {
      sessionId: input.sessionId,
      kind: offer.kind,
      stage: offer.kind === "pulse" ? "pulse" : "rate",
      turn: turn.turn,
      messageId: turn.messageId,
      modelId: input.modelId,
      effort: input.effort,
      rating: null,
      reasons: [],
      comment: "",
      error: null,
      sending: false,
    },
  });
  void bridge.shown({ kind: offer.kind }).catch(() => undefined);
  return offer;
}

function promptInput(prompt: TurnPrompt): OmniRushFeedbackInput {
  return {
    kind: prompt.kind,
    rating: prompt.rating,
    categories: prompt.kind === "turn" && prompt.rating === "down" ? [...prompt.reasons] : [],
    comment: prompt.comment.trim() ? prompt.comment.slice(0, COMMENT_MAX) : null,
    // The pulse is about OmniRush, not this chat: no chat id.
    sessionId: prompt.kind === "pulse" ? null : prompt.sessionId,
    turn: prompt.kind === "pulse" ? null : prompt.turn,
    trigger: prompt.kind === "pulse" ? "pulse" : "sampled",
    modelId: prompt.modelId,
    effort: prompt.effort,
  };
}

/** Thumbs up / down: the follow-up opens; the rating is sent with it, or when the prompt goes. */
export function rateTurn(rating: "up" | "down") {
  const prompt = useFeedbackStore.getState().prompt;
  if (!prompt || prompt.kind !== "turn") return;
  setPrompt({ rating, stage: rating, reasons: rating === "down" ? prompt.reasons : [] });
}

/** The pulse's 0-10 score. */
export function ratePulse(score: number) {
  const prompt = useFeedbackStore.getState().prompt;
  if (!prompt || prompt.kind !== "pulse" || !Number.isInteger(score) || score < 0 || score > 10) return;
  setPrompt({ rating: score });
}

export function toggleTurnReason(id: TurnReasonId) {
  const prompt = useFeedbackStore.getState().prompt;
  if (!prompt) return;
  setPrompt({ reasons: prompt.reasons.includes(id) ? prompt.reasons.filter((r) => r !== id) : [...prompt.reasons, id] });
}

export function setPromptComment(comment: string) {
  setPrompt({ comment: comment.slice(0, COMMENT_MAX), error: null });
}

/**
 * Send, or Skip (the rating alone, without reasons or comment). Without a
 * rating the prompt just goes. A refusal (422 / 413) keeps the prompt open
 * with its reason, so the comment can be fixed.
 */
export async function sendPrompt({ skip = false } = {}): Promise<OmniRushFeedbackResult | null> {
  const prompt = useFeedbackStore.getState().prompt;
  if (!prompt || prompt.rating === null) {
    useFeedbackStore.setState({ prompt: null });
    return null;
  }
  if (prompt.sending) return null;
  const input = skip ? { ...promptInput(prompt), categories: [], comment: null } : promptInput(prompt);
  setPrompt({ sending: true, error: null });
  const result = await send(input, { toast: false });
  const refused = result.ok ? null : refusalText(result) ?? SEND_FAILED;
  const current = useFeedbackStore.getState().prompt;
  if (refused && current?.sessionId === prompt.sessionId && current.messageId === prompt.messageId) {
    setPrompt({ sending: false, error: refused });
    return result;
  }
  if (current?.sessionId === prompt.sessionId && current.messageId === prompt.messageId) useFeedbackStore.setState({ prompt: null });
  notify(result);
  return result;
}

/**
 * The prompt goes (×, Esc, the next turn, typing a new prompt, another
 * session): a rating already chosen still counts (the click is the
 * signal) and is sent quietly with the reasons picked, without the unsent
 * comment. `sessionId`: only that session's prompt (split view).
 */
export function closePrompt(sessionId?: string): Promise<OmniRushFeedbackResult | null> {
  const prompt = useFeedbackStore.getState().prompt;
  if (!prompt || (sessionId !== undefined && prompt.sessionId !== sessionId)) return Promise.resolve(null);
  useFeedbackStore.setState({ prompt: null });
  // Not chosen, or already on its way (Send was pressed).
  if (prompt.rating === null || prompt.sending) return Promise.resolve(null);
  return send({ ...promptInput(prompt), comment: null }, { toast: false });
}

// --- "Send feedback" ----------------------------------------------------------------------

/** Whether "Include this chat's id" is ticked: the person's own choice, else on for Bug. */
export function includeSessionChecked(dialog: Pick<FeedbackDialogState, "category" | "includeSession">): boolean {
  return dialog.includeSession ?? dialog.category === "bug";
}

let currentSessionId: string | null = null;

/** The session open in the window (offered by "Send feedback" opened from a menu that does not know it). */
export function setFeedbackCurrentSession(sessionId: string | null | undefined) {
  currentSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId : null;
}

/** `sessionId` omitted: the session open in the window, if any. */
export function openFeedbackDialog(input: { trigger: "menu" | "command"; sessionId?: string | null }) {
  const given = input.sessionId === undefined ? currentSessionId : input.sessionId;
  const sessionId = typeof given === "string" && given.trim() ? given : null;
  dialogOpens += 1;
  useFeedbackStore.setState({ dialog: { ...closedDialog, open: true, trigger: input.trigger, sessionId, openId: dialogOpens } });
}

export function closeFeedbackDialog() {
  setDialog({ open: false, sending: false });
}

export function setDialogCategory(category: GeneralCategoryId) {
  setDialog({ category });
}

export function setDialogText(text: string) {
  setDialog({ text, error: null });
}

export function setDialogIncludeSession(include: boolean) {
  setDialog({ includeSession: include });
}

export async function sendFeedbackDialog(): Promise<OmniRushFeedbackResult | null> {
  const dialog = useFeedbackStore.getState().dialog;
  if (!dialog.open || dialog.sending || !dialog.text.trim()) return null;
  setDialog({ sending: true });
  const trigger: OmniRushFeedbackTrigger = dialog.trigger;
  const result = await send({
    kind: "general",
    rating: null,
    categories: [dialog.category],
    comment: dialog.text.slice(0, COMMENT_MAX),
    sessionId: dialog.sessionId && includeSessionChecked(dialog) ? dialog.sessionId : null,
    turn: null,
    trigger,
    modelId: null,
    effort: null,
  });
  // The dialog was closed or opened again meanwhile: this answer is not its business.
  if (useFeedbackStore.getState().dialog.openId !== dialog.openId) return result;
  if (result.ok) useFeedbackStore.setState({ dialog: { ...closedDialog, openId: dialog.openId } });
  else setDialog({ sending: false, error: refusalText(result) ?? SEND_FAILED });
  return result;
}

// --- analytics ----------------------------------------------------------------------------

function cleanProperties(value: unknown): AnalyticsProperties {
  const out: AnalyticsProperties = {};
  for (const [key, v] of Object.entries(record(value))) {
    // Labels only: the main process never sends the comment; anything long is dropped too.
    if (key === "comment") continue;
    if (v === null || typeof v === "boolean" || typeof v === "number" || (typeof v === "string" && v.length <= 120)) out[key] = v;
  }
  return out;
}

/** Pass the main process's two feedback events on to the app's analytics. */
export function handleFeedbackEvent(detail: unknown): boolean {
  const value = record(detail);
  if (typeof value.name !== "string" || !EVENT_NAMES.has(value.name)) return false;
  captureAnalyticsEvent(value.name, cleanProperties(value.properties));
  return true;
}

const NATIVE_MENU_SEND_FEEDBACK_EVENT = "omnirush:native-menu:send-feedback";

let installed = false;
/** Once per window: the analytics hand-off and Help > Send Feedback…. */
export function installFeedbackAnalytics() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(EVENT_CHANNEL, (event) => {
    handleFeedbackEvent((event as CustomEvent).detail);
  });
  window.addEventListener(NATIVE_MENU_SEND_FEEDBACK_EVENT, () => openFeedbackDialog({ trigger: "menu" }));
}
