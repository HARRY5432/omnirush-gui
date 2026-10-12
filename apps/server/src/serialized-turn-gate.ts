import { ApiError } from "./errors.js";
import { latestPromptId, readEngineSessionRoot, readSessionTreeQuiescence, stopEngineSession, turnOutcome, type EngineTarget } from "./session-upload-observer.js";

export type SerializedTurnCapture = {
  promptStartGate(sessionId: string, workspaceId: string, root: string): Promise<boolean>;
  pauseTurn(sessionId: string, reason?: string): Promise<void>;
  hasOpenTurn(sessionId: string): Promise<boolean>;
  settleTurn(sessionId: string): Promise<void>;
};
type Input = {
  key: string;
  sessionId: string;
  workspaceId: string;
  root: string;
  target: EngineTarget;
  capture: SerializedTurnCapture;
  /** Settles late writes and configures the capture target while admission is reserved. */
  prepare?: () => Promise<void>;
};
type State = {
  reserved: boolean;
  stopping: boolean;
  blocked: boolean;
  generation: number;
  stopped: boolean;
  pending: Map<string, string | null>;
};
export class SerializedTurnError extends ApiError {
  constructor(message: string, status: 409 | 503 = 409) { super(status, status === 409 ? "turn_active" : "turn_unavailable", message); }
}
export type TurnTicket = {
  check(): void;
  finish(accepted: boolean | null): Promise<void>;
};
const RUNNING = "This turn is still running. Stop it before sending or editing a message.";
function bounded<T>(operation: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SerializedTurnError("The turn could not be verified in time. Retry Stop.", 503)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** One reservation per root tree, retained across asynchronous dispatch and Stop. */
export class SerializedTurnGate {
  private readonly states = new Map<string, State>();
  private async resolve(input: Input, signal: AbortSignal): Promise<{ id: string; state: State }> {
    const id = await readEngineSessionRoot(input.target, input.sessionId, signal).catch(() => {
      throw new SerializedTurnError("Session ancestry is unavailable. The request was not sent.", 503);
    });
    const key = input.key + "\0" + id;
    let state = this.states.get(key);
    if (!state) {
      state = { reserved: false, stopping: false, blocked: false, generation: 0, stopped: false, pending: new Map() };
      this.states.set(key, state);
    }
    return { id, state };
  }

  async admit(input: Input, edit = false): Promise<TurnTicket> {
    const signal = AbortSignal.timeout(60_000);
    const { id, state } = await this.resolve(input, signal);
    if (state.reserved || state.stopping || state.blocked) throw new SerializedTurnError(RUNNING);
    state.reserved = true;
    const generation = state.generation;
    let baselineStarted = false;
    const check = () => {
      if (generation !== state.generation || state.stopping || state.blocked || signal.aborted) {
        throw new SerializedTurnError("The request was stopped before it could start.");
      }
    };
    try {
      const tree = await readSessionTreeQuiescence(input.target, id, signal);
      if (!tree.known) throw new SerializedTurnError("Agent or tool status is unavailable. The message was not sent.", 503);
      if (tree.busy) throw new SerializedTurnError(RUNNING);
      if (!state.stopped) {
        for (const history of tree.histories.values()) {
          if (["no_reply", "incomplete"].includes(turnOutcome(history) ?? "")) throw new SerializedTurnError(RUNNING);
        }
      }
      for (const [pending, before] of state.pending) {
        const history = tree.histories.get(pending);
        if (!history) throw new SerializedTurnError("The prior request could not be verified.", 503);
        const outcome = turnOutcome(history);
        if (latestPromptId(history) === before || !["completed", "stopped", "error"].includes(outcome ?? "")) {
          throw new SerializedTurnError(RUNNING);
        }
      }
      await bounded(async () => {
        for (const sessionId of tree.sessionIds) await input.capture.settleTurn(sessionId);
      }, 60_000);
      check();
      if (!edit && input.prepare) {
        await bounded(input.prepare, 60_000);
        check();
      }
      if (edit) {
        for (const sessionId of tree.sessionIds) {
          if (await input.capture.hasOpenTurn(sessionId)) {
            throw new SerializedTurnError("This turn is paused. Send a correction to continue it; its original prompt and files must remain recorded.");
          }
        }
      } else {
        baselineStarted = true;
        if (!await bounded(() => input.capture.promptStartGate(input.sessionId, input.workspaceId, input.root), 60_000)) {
          throw new SerializedTurnError("The original workspace snapshot is unavailable. The message was not sent.", 503);
        }
      }
      check();
      const before = latestPromptId(tree.histories.get(input.sessionId) ?? []);
      let finished = false;
      return {
        check,
        finish: async (accepted) => {
          if (finished) return;
          finished = true;
          if (!edit && accepted === true && generation === state.generation) {
            state.pending.set(input.sessionId, before); state.stopped = false;
          }
          if (accepted === null) state.blocked = true; // Delivery may have succeeded: require verified Stop.
          try {
            if (!edit && accepted !== true) await input.capture.pauseTurn(input.sessionId, "dispatch_failed");
          } finally { state.reserved = false; }
        },
      };
    } catch (error) {
      if (baselineStarted) await bounded(() => input.capture.pauseTurn(input.sessionId, "dispatch_cancelled"), 20_000).catch(() => { state.blocked = true; });
      state.reserved = false;
      throw error instanceof ApiError ? error : new SerializedTurnError("Capture could not verify the turn. The message was not sent.", 503);
    }
  }

  async stop(input: Input): Promise<void> {
    const signal = AbortSignal.timeout(20_000);
    const { id, state } = await this.resolve(input, signal);
    if (state.stopping) throw new SerializedTurnError("Stop is still in progress.");
    state.stopping = true;
    state.blocked = true;
    state.generation++;
    const deadline = Date.now() + 20_000;
    const wait = <T>(work: () => Promise<T>) => bounded(work, Math.max(1, deadline - Date.now()));
    let firstError: unknown;
    try {
      // Pause capture before cancellation can emit idle/completed events.
      try { await wait(() => input.capture.pauseTurn(id, "user_stop")); } catch (error) { firstError = error; }
      try { await stopEngineSession(input.target, id, signal); } catch (error) { firstError ??= error; }
      const stopped = new Set([id]);
      let quiet = 0;
      for (;;) {
        const tree = await readSessionTreeQuiescence(input.target, id, signal);
        if (!tree.known) throw new SerializedTurnError("Subagent activity is unavailable. Retry Stop.", 503);
        for (const sessionId of tree.sessionIds) {
          if (!stopped.has(sessionId) || tree.busy) {
            try { await wait(() => input.capture.pauseTurn(sessionId, "user_stop")); } catch (error) { firstError ??= error; }
            try {
              await stopEngineSession(input.target, sessionId, signal);
              stopped.add(sessionId);
            } catch (error) { firstError ??= error; }
          }
        }
        quiet = !tree.busy && !state.reserved && tree.sessionIds.every(sessionId => stopped.has(sessionId)) ? quiet + 1 : 0;
        if (quiet >= 2) {
          for (const sessionId of tree.sessionIds) await wait(() => input.capture.settleTurn(sessionId));
          if (firstError) throw firstError;
          state.pending.clear();
          state.stopped = true;
          state.blocked = false;
          return;
        }
        if (signal.aborted || Date.now() >= deadline) throw new SerializedTurnError("The agent or a subagent did not stop in time. Retry Stop.", 503);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } catch (error) {
      throw error instanceof ApiError ? error : new SerializedTurnError("Stop could not be verified. Retry Stop before continuing.", 503);
    } finally { state.stopping = false; }
  }
}
