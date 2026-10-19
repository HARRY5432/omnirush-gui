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
import { messageFacts } from "./good-session";

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

/**
 * How the last turn of a transcript ended, or null when it has no answer
 * yet. Uses the same reading as the Good-session checklist (messageFacts):
 * a normal finish is "ok"; the Stop button "stopped"; a gateway refusal,
 * a spent allowance or any other error "error".
 */
export function finishedTurn(messages: readonly UIMessage[]): FinishedTurn | null {
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.role !== "user") start -= 1;
  if (start === 0) return null;
  const prompt = messages[start - 1]!;
  if (opencodeMeta(prompt).compaction === true) return null;
  const answer = messages.slice(start).filter((message) => message.role === "assistant");
  const last = answer.at(-1);
  if (!last) return null;
  // A compaction (its summary) is no agent turn: never rated.
  if (answer.some((message) => opencodeMeta(message).compaction === true)) return null;
  const facts = messageFacts(messages);
  if (facts.replyOpen || facts.ended === "none") return null;
  let outcome: OmniRushFeedbackTurnOutcome;
  if (facts.ended === "pass" || facts.ended === "awaiting") outcome = "ok";
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
  const turn = messages.slice(0, start).filter((message) => message.role === "user" && opencodeMeta(message).compaction !== true).length;
  return { outcome, toolCalls, durationMs, text: text.trim().slice(0, 700), turn, messageId: last.id };
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
};

export type FeedbackDialogState = {
  open: boolean;
  trigger: "menu" | "command";
  /** The session open when the dialog opened (offered as "Include this session's id"). */
  sessionId: string | null;
  category: GeneralCategoryId;
  text: string;
  /** null: the default for the category (on for Bug); true/false: the person's own choice. */
  includeSession: boolean | null;
  sending: boolean;
};

type FeedbackState = {
  prompt: TurnPrompt | null;
  dialog: FeedbackDialogState;
};

const closedDialog: FeedbackDialogState = { open: false, trigger: "menu", sessionId: null, category: "bug", text: "", includeSession: null, sending: false };

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

/** A turn started in this session: the pulse counts sessions; an open prompt goes (its rating is sent). */
export function feedbackTurnStarted(sessionId: string) {
  void bridge.sessionStarted({ sessionId }).catch(() => undefined);
  if (useFeedbackStore.getState().prompt) void closePrompt();
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
    sessionId: prompt.sessionId,
    turn: prompt.turn,
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
  setPrompt({ comment: comment.slice(0, COMMENT_MAX) });
}

/** Send, or Skip (the rating alone, without reasons or comment). Without a rating the prompt just goes. */
export async function sendPrompt({ skip = false } = {}): Promise<OmniRushFeedbackResult | null> {
  const prompt = useFeedbackStore.getState().prompt;
  useFeedbackStore.setState({ prompt: null });
  if (!prompt || prompt.rating === null) return null;
  const input = skip ? { ...promptInput(prompt), categories: [], comment: null } : promptInput(prompt);
  return send(input);
}

/**
 * The prompt goes (×, Esc, the next turn, typing a new prompt, another
 * session): a rating already chosen still counts (the click is the
 * signal) and is sent quietly, without the follow-up's extras (as Skip).
 */
export function closePrompt(): Promise<OmniRushFeedbackResult | null> {
  const prompt = useFeedbackStore.getState().prompt;
  useFeedbackStore.setState({ prompt: null });
  if (!prompt || prompt.rating === null) return Promise.resolve(null);
  return send({ ...promptInput(prompt), categories: [], comment: null }, { toast: false });
}

// --- "Send feedback" ----------------------------------------------------------------------

/** Whether "Include this session's id" is ticked: the person's own choice, else on for Bug. */
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
  useFeedbackStore.setState({ dialog: { ...closedDialog, open: true, trigger: input.trigger, sessionId } });
}

export function closeFeedbackDialog() {
  setDialog({ open: false, sending: false });
}

export function setDialogCategory(category: GeneralCategoryId) {
  setDialog({ category });
}

export function setDialogText(text: string) {
  setDialog({ text });
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
  if (result.ok) useFeedbackStore.setState({ dialog: closedDialog });
  else setDialog({ sending: false });
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
