import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import type { OmniRushFeedbackInput } from "@omnirush/types/desktop-ipc";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}
const storage = new MemoryStorage();
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, addEventListener: () => undefined } });
}

const lib = await import("../src/app/lib/in-app-feedback");
const analytics = await import("../src/app/lib/analytics");
const { FeedbackFormView, FeedbackTurnPrompt, FeedbackTurnPromptView } = await import("../src/react-app/domains/feedback/feedback");

type Input = OmniRushFeedbackInput;

const MARKER = "MARKER-only-in-feedback-91c2";

function fakeMain(offer: { kind: "turn" | "pulse" } | null = { kind: "turn" }, result: unknown = { ok: true, sent: true, queued: false }) {
  const offers: unknown[] = [];
  const shown: unknown[] = [];
  const started: unknown[] = [];
  const submitted: Input[] = [];
  lib.setFeedbackBridgeForTests({
    offer: async (input) => { offers.push(input); return offer; },
    sessionStarted: async (input) => { started.push(input); return true; },
    shown: async (input) => { shown.push(input); return { ok: true }; },
    submit: async (input) => { submitted.push(input); return result as never; },
  });
  const toasts: unknown[] = [];
  lib.setFeedbackNotifier((r) => toasts.push(lib.resultToast(r)));
  return { offers, shown, started, submitted, toasts };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function user(id: string, text: string, created = 1_000): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }], metadata: { opencode: { created } } } as UIMessage;
}
function assistant(id: string, parts: unknown[], meta: Record<string, unknown> = { created: 1_100, completed: 41_000, finish: "stop" }): UIMessage {
  return { id, role: "assistant", parts, metadata: { opencode: meta } } as unknown as UIMessage;
}
const toolPart = { type: "dynamic-tool", toolName: "bash", toolCallId: "c1", state: "output-available", input: { command: "ls" }, output: "a\nb" };
const text = (t: string) => ({ type: "text", text: t, state: "done" });

const TURN = { outcome: "ok" as const, toolCalls: 1, durationMs: 4000, text: "Done.", turn: 2, messageId: "a2" };

afterEach(() => lib.setFeedbackBridgeForTests(null));

describe("in-app feedback: how the last turn ended", () => {
  test("a finished turn with a tool: ok, its tool count, duration and turn index", () => {
    const messages = [user("u1", "first"), assistant("a1", [text("hi")]), user("u2", "list files", 10_000), assistant("a2", [toolPart, text("Two files: a and b.")], { created: 10_100, completed: 25_000, finish: "stop" })];
    expect(lib.finishedTurn(messages)).toEqual({ outcome: "ok", toolCalls: 1, durationMs: 15_000, text: "Two files: a and b.", turn: 2, messageId: "a2" });
  });

  test("the agent asking the person a question is not a finished turn", () => {
    const asks = [user("u1", "set it up"), assistant("a1", [toolPart, text("Which database should I use, Postgres or SQLite?")])];
    expect(lib.finishedTurn(asks)).toBeNull();
  });

  test("after an automatic compaction: back to the real prompt (tools, duration, turn index)", () => {
    const cont = { id: "c1", role: "user", parts: [{ type: "text", text: "Continue.", synthetic: true }], metadata: { opencode: { created: 30_000 } } } as unknown as UIMessage;
    const compactReq = { ...user("cr", "compact"), metadata: { opencode: { created: 20_000, compaction: true } } } as UIMessage;
    const summary = assistant("s1", [text("summary")], { created: 20_100, completed: 25_000, finish: "stop", compaction: true });
    const messages = [user("u1", "first"), assistant("a1", [text("hi")]), user("u2", "build it", 10_000), assistant("a2", [toolPart], { created: 10_100, completed: 19_000, finish: "tool-calls" }), compactReq, summary, cont, assistant("a3", [toolPart, text("Built.")], { created: 30_100, completed: 50_000, finish: "stop" })];
    expect(lib.finishedTurn(messages)).toEqual({ outcome: "ok", toolCalls: 2, durationMs: 40_000, text: "Built.", turn: 2, messageId: "a3" });
    expect(lib.lastAnswerId(messages)).toBe("a3");
  });

  test("no answer yet, an open answer, a compaction: nothing", () => {
    expect(lib.finishedTurn([user("u1", "x")])).toBeNull();
    expect(lib.finishedTurn([user("u1", "x"), assistant("a1", [text("partial")], { created: 1 })])).toBeNull();
    const compaction = { ...user("u1", "compact"), metadata: { opencode: { created: 1, compaction: true } } } as UIMessage;
    expect(lib.finishedTurn([compaction, assistant("a1", [text("summary")])])).toBeNull();
    expect(lib.finishedTurn([user("u1", "x"), assistant("a1", [text("summary")], { created: 1, completed: 2, finish: "stop", compaction: true })])).toBeNull();
  });

  test("an error, a gateway refusal and the Stop button are not ok", () => {
    const failed = assistant("e1", [{ type: "text", text: "Model error", state: "done", providerMetadata: { opencode: { sessionError: { kind: "provider-error", title: "Model error", technicalDetails: "boom" } } } }]);
    expect(lib.finishedTurn([user("u1", "x"), failed])?.outcome).toBe("error");
    const refusal = assistant("e2", [{ type: "text", text: "OmniRush can't help with this request.", state: "done", providerMetadata: { opencode: { sessionError: { kind: "provider-error", title: "omnirush.ai: OmniRush can't help with this request.", technicalDetails: "Error type: APIError", omnirush: { code: "request_policy_refused", retry: false } } } } }]);
    expect(lib.finishedTurn([user("u1", "x"), refusal])?.outcome).toBe("error");
    const stopped = assistant("e3", [{ type: "text", text: "Stopped", state: "done", providerMetadata: { opencode: { sessionError: { kind: "aborted", title: "Stopped" } } } }]);
    expect(lib.finishedTurn([user("u1", "x"), stopped])?.outcome).toBe("stopped");
  });
});

describe("in-app feedback: after a turn", () => {
  test("the main process says turn: the prompt shows (once reported shown) with the turn's facts", async () => {
    const main = fakeMain();
    const offer = await lib.offerFeedbackAfterTurn({ sessionId: "ses_1", turn: TURN, fallbackDurationMs: 0, modelId: "gpt-6-astra", effort: "high" });
    expect(offer).toEqual({ kind: "turn" });
    expect(main.offers).toEqual([{ sessionId: "ses_1", outcome: "ok", toolCalls: 1, durationMs: 4000, text: "Done." }]);
    expect(main.shown).toEqual([{ kind: "turn" }]);
    expect(lib.useFeedbackStore.getState().prompt).toMatchObject({ sessionId: "ses_1", kind: "turn", stage: "rate", turn: 2, modelId: "gpt-6-astra", effort: "high", rating: null });
  });

  test("stale by the time the main process answers (typed, another answer, another session): dropped", async () => {
    const main = fakeMain();
    expect(await lib.offerFeedbackAfterTurn({ sessionId: "ses_1", turn: TURN, fallbackDurationMs: 0, modelId: null, effort: null, stillCurrent: () => false })).toBeNull();
    expect(lib.useFeedbackStore.getState().prompt).toBeNull();
    expect(main.shown).toEqual([]);
  });

  test("a send that fails outright says so inline; the prompt stays", async () => {
    fakeMain({ kind: "turn" }, { ok: false, error: "failed" });
    await lib.offerFeedbackAfterTurn({ sessionId: "ses_1", turn: TURN, fallbackDurationMs: 0, modelId: null, effort: null });
    lib.rateTurn("up");
    await lib.sendPrompt();
    expect(lib.useFeedbackStore.getState().prompt?.error).toBe("Couldn't send. Try again.");
  });

  test("the main process says no: nothing shows, nothing reported", async () => {
    const main = fakeMain(null);
    expect(await lib.offerFeedbackAfterTurn({ sessionId: "ses_1", turn: { ...TURN, durationMs: null }, fallbackDurationMs: 31_000, modelId: null, effort: null })).toBeNull();
    expect((main.offers[0] as { durationMs: number }).durationMs).toBe(31_000);
    expect(main.shown).toEqual([]);
    expect(lib.useFeedbackStore.getState().prompt).toBeNull();
  });

  test("thumbs down + reasons + comment: the payload input, then a thank-you", async () => {
    const main = fakeMain();
    await lib.offerFeedbackAfterTurn({ sessionId: "ses_1", turn: TURN, fallbackDurationMs: 0, modelId: "gpt-6-astra", effort: "high" });
    lib.rateTurn("down");
    expect(lib.useFeedbackStore.getState().prompt?.stage).toBe("down");
    lib.toggleTurnReason("wrong");
    lib.toggleTurnReason("broke");
    lib.toggleTurnReason("broke");
    lib.toggleTurnReason("slow");
    lib.setPromptComment(`It deleted the wrong file ${MARKER}`);
    await lib.sendPrompt();
    expect(main.submitted).toEqual([{ kind: "turn", rating: "down", categories: ["wrong", "slow"], comment: `It deleted the wrong file ${MARKER}`, sessionId: "ses_1", turn: 2, trigger: "sampled", modelId: "gpt-6-astra", effort: "high" }]);
    expect(main.toasts).toEqual([{ kind: "sent", title: "Thanks, sent." }]);
    expect(lib.useFeedbackStore.getState().prompt).toBeNull();
  });

  test("thumbs up then Skip: the rating alone", async () => {
    const main = fakeMain();
    await lib.offerFeedbackAfterTurn({ sessionId: "ses_1", turn: TURN, fallbackDurationMs: 0, modelId: null, effort: null });
    lib.rateTurn("up");
    lib.setPromptComment("typed but skipped");
    await lib.sendPrompt({ skip: true });
    expect(main.submitted[0]).toMatchObject({ kind: "turn", rating: "up", categories: [], comment: null });
  });

  test("a rating chosen and then left (next turn, typing, ×): the rating and the reasons picked, sent quietly, not the unsent comment", async () => {
    const main = fakeMain();
    await lib.offerFeedbackAfterTurn({ sessionId: "ses_1", turn: TURN, fallbackDurationMs: 0, modelId: null, effort: null });
    lib.rateTurn("down");
    lib.toggleTurnReason("ui");
    lib.setPromptComment("half typed");
    lib.feedbackTurnStarted("ses_other");
    await flush();
    expect(lib.useFeedbackStore.getState().prompt?.sessionId).toBe("ses_1");
    expect(main.submitted).toEqual([]);
    lib.feedbackTurnStarted("ses_1");
    await flush();
    expect(main.started).toEqual([{ sessionId: "ses_other" }, { sessionId: "ses_1" }]);
    expect(main.submitted[0]).toMatchObject({ rating: "down", categories: ["ui"], comment: null });
    expect(main.toasts).toEqual([]);
    expect(lib.useFeedbackStore.getState().prompt).toBeNull();
  });

  test("dismissed without a rating: nothing is sent", async () => {
    const main = fakeMain();
    await lib.offerFeedbackAfterTurn({ sessionId: "ses_1", turn: TURN, fallbackDurationMs: 0, modelId: null, effort: null });
    await lib.closePrompt();
    await lib.sendPrompt({ skip: true });
    expect(main.submitted).toEqual([]);
  });

  test("the pulse: a 0-10 score and why", async () => {
    const main = fakeMain({ kind: "pulse" });
    await lib.offerFeedbackAfterTurn({ sessionId: "ses_9", turn: TURN, fallbackDurationMs: 0, modelId: "m", effort: null });
    expect(main.shown).toEqual([{ kind: "pulse" }]);
    lib.rateTurn("up");
    lib.ratePulse(11);
    lib.ratePulse(9);
    lib.setPromptComment("fast and handy");
    await lib.sendPrompt();
    expect(main.submitted).toEqual([{ kind: "pulse", rating: 9, categories: [], comment: "fast and handy", sessionId: null, turn: null, trigger: "pulse", modelId: "m", effort: null }]);
  });

  test("queued (offline / the server has none yet): the saved wording, never an error", async () => {
    const main = fakeMain({ kind: "turn" }, { ok: true, sent: false, queued: true, reason: "unavailable" });
    await lib.offerFeedbackAfterTurn({ sessionId: "ses_1", turn: TURN, fallbackDurationMs: 0, modelId: null, effort: null });
    lib.rateTurn("up");
    await lib.sendPrompt();
    expect(main.toasts).toEqual([{ kind: "queued", title: "Thanks, saved for later." }]);
  });
});

describe("in-app feedback: refusals (422 / 413)", () => {
  test("the words: the fields a 422 names, a 413 too long, nothing for sent or queued", () => {
    expect(lib.refusalText({ ok: false, error: "invalid", errors: { comment: "too long", turn: "must be an integer" } })).toBe("Couldn't send: comment: too long; turn: must be an integer");
    expect(lib.refusalText({ ok: false, error: "invalid", errors: null })).toBe("Couldn't send: the server did not accept it");
    expect(lib.refusalText({ ok: false, error: "too_large" })).toBe("That's too long to send");
    expect(lib.refusalText({ ok: true, sent: true, queued: false })).toBeNull();
    expect(lib.refusalText({ ok: true, sent: false, queued: true, reason: "offline" })).toBeNull();
  });

  test("the follow-up: a 422 keeps the prompt open with its reason and the comment; no toast", async () => {
    const main = fakeMain({ kind: "turn" }, { ok: false, error: "invalid", errors: { comment: "too long" } });
    await lib.offerFeedbackAfterTurn({ sessionId: "ses_1", turn: TURN, fallbackDurationMs: 0, modelId: null, effort: null });
    lib.rateTurn("down");
    lib.setPromptComment("way too much");
    await lib.sendPrompt();
    expect(main.submitted).toHaveLength(1);
    expect(lib.useFeedbackStore.getState().prompt).toMatchObject({ rating: "down", comment: "way too much", error: "Couldn't send: comment: too long", sending: false });
    expect(main.toasts).toEqual([]);
    lib.setPromptComment("shorter");
    expect(lib.useFeedbackStore.getState().prompt?.error).toBeNull();
  });

  test("the dialog: a 422 or 413 keeps it open with the text and the reason", async () => {
    fakeMain(null, { ok: false, error: "invalid", errors: { comment: "too long" } });
    lib.openFeedbackDialog({ trigger: "menu", sessionId: null });
    lib.setDialogText("a long note");
    await lib.sendFeedbackDialog();
    expect(lib.useFeedbackStore.getState().dialog).toMatchObject({ open: true, text: "a long note", error: "Couldn't send: comment: too long", sending: false });
    fakeMain(null, { ok: false, error: "too_large" });
    lib.openFeedbackDialog({ trigger: "menu", sessionId: null });
    lib.setDialogText("huge");
    await lib.sendFeedbackDialog();
    expect(lib.useFeedbackStore.getState().dialog.error).toBe("That's too long to send");
  });

  test("the views show the reason", () => {
    const noop = () => undefined;
    const prompt = { sessionId: "ses_1", kind: "turn" as const, stage: "down" as const, turn: 2, messageId: "a2", modelId: null, effort: null, rating: "down" as const, reasons: [], comment: "x", error: "Couldn't send: comment: too long", sending: false };
    const html = renderToStaticMarkup(<FeedbackTurnPromptView prompt={prompt} onRate={noop} onPulse={noop} onToggleReason={noop} onComment={noop} onSend={noop} onSkip={noop} onDismiss={noop} />);
    expect(html).toContain("Couldn&#x27;t send: comment: too long");
    const dialog = { open: true, trigger: "menu" as const, sessionId: null, category: "bug" as const, text: "x", includeSession: null, sending: false, error: "That's too long to send", openId: 1 };
    const form = renderToStaticMarkup(<FeedbackFormView dialog={dialog} onCategory={noop} onText={noop} onIncludeSession={noop} onSend={noop} onCancel={noop} />);
    expect(form).toContain("That&#x27;s too long to send");
    expect(form).toContain('role="alert"');
  });
});

describe("in-app feedback: Send feedback", () => {
  test("Bug includes the open session by default; other categories do not; the person's choice wins", async () => {
    const main = fakeMain();
    lib.openFeedbackDialog({ trigger: "menu", sessionId: "ses_open" });
    expect(lib.includeSessionChecked(lib.useFeedbackStore.getState().dialog)).toBe(true);
    lib.setDialogCategory("idea");
    expect(lib.includeSessionChecked(lib.useFeedbackStore.getState().dialog)).toBe(false);
    lib.setDialogIncludeSession(true);
    lib.setDialogCategory("praise");
    expect(lib.includeSessionChecked(lib.useFeedbackStore.getState().dialog)).toBe(true);
    lib.setDialogCategory("bug");
    lib.setDialogIncludeSession(false);
    lib.setDialogText("  ");
    expect(await lib.sendFeedbackDialog()).toBeNull();
    lib.setDialogText("The sidebar flickers\nwhen I resize");
    await lib.sendFeedbackDialog();
    expect(main.submitted).toEqual([{ kind: "general", rating: null, categories: ["bug"], comment: "The sidebar flickers\nwhen I resize", sessionId: null, turn: null, trigger: "menu", modelId: null, effort: null }]);
    expect(lib.useFeedbackStore.getState().dialog.open).toBe(false);
  });

  test("from the palette, with the session", async () => {
    const main = fakeMain();
    lib.openFeedbackDialog({ trigger: "command", sessionId: "ses_open" });
    lib.setDialogText("crash on start");
    await lib.sendFeedbackDialog();
    expect(main.submitted[0]).toMatchObject({ kind: "general", categories: ["bug"], sessionId: "ses_open", trigger: "command" });
    expect(main.toasts).toEqual([{ kind: "sent", title: "Thanks, sent." }]);
  });

  test("a late answer to an earlier opening leaves a reopened dialog alone", async () => {
    let release: (v: unknown) => void = () => undefined;
    lib.setFeedbackBridgeForTests({
      offer: async () => null,
      sessionStarted: async () => true,
      shown: async () => ({ ok: true }),
      submit: () => new Promise((resolve) => { release = resolve; }) as never,
    });
    lib.openFeedbackDialog({ trigger: "menu", sessionId: null });
    lib.setDialogText("first");
    const pending = lib.sendFeedbackDialog();
    lib.closeFeedbackDialog();
    lib.openFeedbackDialog({ trigger: "command", sessionId: null });
    lib.setDialogText("second, being written");
    release({ ok: true, sent: true, queued: false });
    await pending;
    expect(lib.useFeedbackStore.getState().dialog).toMatchObject({ open: true, trigger: "command", text: "second, being written" });
  });

  test("a refused input keeps the dialog open", async () => {
    fakeMain(null, { ok: false, error: "comment" });
    lib.openFeedbackDialog({ trigger: "menu" });
    lib.setDialogText("x");
    await lib.sendFeedbackDialog();
    expect(lib.useFeedbackStore.getState().dialog).toMatchObject({ open: true, sending: false });
  });
});

describe("in-app feedback: analytics", () => {
  const realFetch = globalThis.fetch;
  let sent: Array<{ event: string; properties: Record<string, unknown> }> = [];
  beforeEach(() => {
    sent = [];
    analytics.disposeAnalytics();
    analytics.configureAnalyticsForTests({ key: "phc_test", host: "http://127.0.0.1:9/", appVersion: "3.6.1" });
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(...JSON.parse(String(init?.body)).batch);
      return new Response("{}");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("the two events pass on with labels only; anything else is dropped", async () => {
    expect(lib.handleFeedbackEvent({ name: "feedback_prompt_shown", properties: { kind: "turn", trigger: "sampled" } })).toBe(true);
    expect(lib.handleFeedbackEvent({ name: "feedback_submitted", properties: { kind: "turn", rating_bucket: "down", categories: "wrong+slow", has_comment: true, trigger: "sampled", comment: MARKER } })).toBe(true);
    expect(lib.handleFeedbackEvent({ name: "app_opened", properties: {} })).toBe(false);
    await analytics.flushAnalytics();
    expect(sent.map((e) => e.event)).toEqual(["feedback_prompt_shown", "feedback_submitted"]);
    expect(sent[1].properties).toMatchObject({ kind: "turn", rating_bucket: "down", categories: "wrong+slow", has_comment: true, trigger: "sampled" });
    expect(JSON.stringify(sent)).not.toContain(MARKER);
  });
});

describe("in-app feedback: the views", () => {
  const base = { sessionId: "ses_1", kind: "turn" as const, stage: "rate" as const, turn: 2, messageId: "a2", modelId: null, effort: null, rating: null, reasons: [], comment: "", error: null, sending: false };
  const noop = () => undefined;
  const handlers = { onRate: noop, onPulse: noop, onToggleReason: noop, onComment: noop, onSend: noop, onSkip: noop, onDismiss: noop };

  test("the rating row: muted label, two thumbs, ×, a gentle fade-in, no follow-up yet", () => {
    const html = renderToStaticMarkup(<FeedbackTurnPromptView prompt={base} {...handlers} />);
    expect(html).toContain("How was this?");
    expect(html).toContain('data-testid="feedback-up"');
    expect(html).toContain('data-testid="feedback-down"');
    expect(html).toContain('data-testid="feedback-dismiss"');
    expect(html).toContain("fade-in-0");
    expect(html).toContain("duration-200");
    expect(html).not.toContain("feedback-reason-");
    expect(html).not.toContain("feedback-comment");
    expect(html).not.toContain("feedback-note");
    expect(html).not.toContain('role="dialog"');
  });

  test("thumbs down: the six reasons (chosen ones pressed), a one-line comment, Send / Skip", () => {
    const html = renderToStaticMarkup(<FeedbackTurnPromptView prompt={{ ...base, stage: "down", rating: "down", reasons: ["slow"] }} {...handlers} />);
    for (const label of ["Wrong", "Too slow", "Didn&#x27;t follow instructions", "Broke something", "UI problem", "Other"]) expect(html).toContain(label);
    const chip = (id: string) => html.match(new RegExp(`<button[^>]*data-testid="feedback-reason-${id}"[^>]*>`))?.[0] ?? "";
    expect(chip("slow")).toContain('aria-pressed="true"');
    expect(chip("wrong")).toContain('aria-pressed="false"');
    expect(html).toContain('data-slot="toggle-group"');
    expect(html).toContain("Anything to add? (optional)");
    expect(html).toContain("Sent to the OmniRush team with this chat&#x27;s id. Not part of the chat.");
    expect(html).toContain('data-testid="feedback-send"');
    expect(html).toContain('data-testid="feedback-skip"');
  });

  test("thumbs up: What worked?", () => {
    const html = renderToStaticMarkup(<FeedbackTurnPromptView prompt={{ ...base, stage: "up", rating: "up" }} {...handlers} />);
    expect(html).toContain("What worked? (optional)");
    expect(html).toContain('data-testid="feedback-note"');
    expect(html).not.toContain("feedback-reason-");
  });

  test("the pulse: the question, 0 to 10, why after a score", () => {
    const before = renderToStaticMarkup(<FeedbackTurnPromptView prompt={{ ...base, kind: "pulse", stage: "pulse" }} {...handlers} />);
    expect(before).toContain("How likely are you to recommend OmniRush to a friend?");
    for (let i = 0; i <= 10; i++) expect(before).toContain(`data-testid="feedback-pulse-${i}"`);
    expect(before).not.toContain("Why? (optional)");
    const after = renderToStaticMarkup(<FeedbackTurnPromptView prompt={{ ...base, kind: "pulse", stage: "pulse", rating: 8 }} {...handlers} />);
    expect(after).toContain("Why? (optional)");
    expect(after).toMatch(/aria-checked="true"[^>]*data-testid="feedback-pulse-8"/);
  });

  test("the watcher draws nothing without a prompt, or while a turn runs", () => {
    fakeMain();
    expect(renderToStaticMarkup(<FeedbackTurnPrompt sessionId="ses_1" messages={[]} turnRunning={false} draft="" modelId={null} effort={null} />)).toBe("");
    lib.useFeedbackStore.setState({ prompt: base });
    expect(renderToStaticMarkup(<FeedbackTurnPrompt sessionId="ses_1" messages={[]} turnRunning draft="" modelId={null} effort={null} />)).toBe("");
    expect(renderToStaticMarkup(<FeedbackTurnPrompt sessionId="ses_other" messages={[]} turnRunning={false} draft="" modelId={null} effort={null} />)).toBe("");
  });

  test("the dialog form: categories, text, the session box only with a session, Send off while empty", () => {
    const dialog = { open: true, trigger: "menu" as const, sessionId: "ses_open", category: "bug" as const, text: "", includeSession: null, sending: false, error: null, openId: 1 };
    const props = { onCategory: noop, onText: noop, onIncludeSession: noop, onSend: noop, onCancel: noop };
    const html = renderToStaticMarkup(<FeedbackFormView dialog={dialog} {...props} />);
    for (const c of ["bug", "idea", "praise", "other"]) expect(html).toContain(`data-testid="feedback-category-${c}"`);
    expect(html).toContain("Include this chat&#x27;s id");
    expect(html).toMatch(/data-testid="feedback-dialog-send"[^>]*disabled=""|disabled=""[^>]*data-testid="feedback-dialog-send"/);
    const noSession = renderToStaticMarkup(<FeedbackFormView dialog={{ ...dialog, sessionId: null, text: "x" }} {...props} />);
    expect(noSession).not.toContain("Include this chat");
    expect(noSession).not.toMatch(/data-testid="feedback-dialog-send"[^>]*disabled=""/);
  });
});
