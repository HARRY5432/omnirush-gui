/**
 * Handoff (wrap) offer rules, shared by the desktop app and the CLI.
 * The same file ships in omnirush-cli and omnirush-gui (PARITY.sha256).
 *
 * The gateway offers a wrap once the allowance nears its end
 * (`x-omnirush-wrap-required`, keyed by `x-omnirush-wrap-offer-id`). These
 * rules keep that offer to one question per session and offer:
 *   - it is asked only while the session is idle, never over a running turn;
 *   - any answer is final for that offer: "Keep working", closing the
 *     question, a finished wrap or a failed one;
 *   - a failed wrap becomes a quiet notice with a retry action, never the
 *     question again;
 *   - an accepted wrap waits for the session to be idle before it starts.
 */

export type WrapChoice = "pending" | "accept" | "decline" | "done" | "failed";

/** Choices that end the question for this session and offer. */
export const FINAL_WRAP_CHOICES: readonly WrapChoice[] = ["decline", "done", "failed"];

export function isFinalWrapChoice(choice: string | undefined): boolean {
  return FINAL_WRAP_CHOICES.includes(choice as WrapChoice);
}

/** Whether the question may be on screen now. */
export function showWrapQuestion(input: { choice: string | undefined; busy: boolean }): boolean {
  return input.choice === "pending" && !input.busy;
}

/** Whether an accepted wrap may start now (never over a running turn). */
export function startWrapNow(input: { choice: string | undefined; busy: boolean; inFlight: boolean }): boolean {
  return input.choice === "accept" && !input.busy && !input.inFlight;
}

/**
 * Whether a wrap finished: the engine answered and reported the session
 * compacted (it only does so after a summary without error). The gateway's
 * own confirmation (`x-omnirush-wrap-up`) is not required: a wrap served
 * from bonus tokens is just as complete.
 */
export function wrapFinished(input: { ok: boolean; compacted: boolean }): boolean {
  return input.ok && input.compacted;
}

/** What an offer becomes after its wrap fails: final, retried only on request. */
export const WRAP_FAILED_CHOICE: WrapChoice = "failed";

/** Whether a new offer from the gateway replaces the remembered one. */
export function replacesWrapOffer(previous: { offerID: string } | undefined, offerID: string): boolean {
  return !previous || previous.offerID !== offerID;
}

export const WRAP_TEXT = {
  title: "Save a handoff for this session?",
  body: "A wrap saves a summary of this session so you can resume it later. You can keep working while tokens remain, whether you wrap or not.",
  accept: "Wrap up",
  decline: "Keep working",
  started: "Saving a handoff for this session.",
  finished: "Your handoff is saved. You can keep working while tokens remain.",
  failedTitle: "Wrap up did not finish",
  failedBody: "Your session is unchanged. You can retry, or keep working.",
  retry: "Retry",
} as const;
