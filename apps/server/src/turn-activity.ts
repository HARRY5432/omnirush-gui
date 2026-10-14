// Whether the agent is working: from a prompt dispatch until the engine
// reports no running session. The desktop keeps the computer awake while it
// is (apps/desktop/electron/keep-awake.mjs); the embedding app gets every
// change through `onTurnActivity`.
//
// A dispatch marks it running at once (before the prompt's hooks, so "from
// the prompt sent") and again when the engine has taken the prompt. While it
// runs, the engine's session status is read every `pollMs`; once no session
// runs and the last dispatch is older than `graceMs`, it stops. Unreadable
// status counts as running, for at most `unknownLimitMs`.

export type TurnActivityOptions = {
  busy: () => Promise<{ sessions: string[]; unknown: number }>;
  onChange: (running: boolean) => void;
  pollMs?: number;
  graceMs?: number;
  unknownLimitMs?: number;
  now?: () => number;
};

export type TurnActivity = {
  promptDispatched: () => void;
  readonly running: boolean;
  stop: () => void;
};

export function createTurnActivity(options: TurnActivityOptions): TurnActivity {
  const pollMs = options.pollMs ?? 2_000;
  const graceMs = options.graceMs ?? 5_000;
  const unknownLimitMs = options.unknownLimitMs ?? 120_000;
  const now = options.now ?? Date.now;
  let running = false;
  let stopped = false;
  let lastDispatch = 0;
  let unknownSince: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = (value: boolean) => {
    if (running === value) return;
    running = value;
    try {
      options.onChange(value);
    } catch {
      // The listener never stops the server.
    }
  };

  const schedule = () => {
    if (timer || stopped || !running) return;
    timer = setTimeout(() => void check(), pollMs);
    timer.unref?.();
  };

  const check = async () => {
    timer = null;
    if (stopped || !running) return;
    const busy = await options.busy().catch(() => null);
    const at = now();
    if (busy && busy.sessions.length > 0) {
      unknownSince = null;
    } else if (!busy || busy.unknown > 0) {
      unknownSince ??= at;
      if (at - unknownSince >= unknownLimitMs && at - lastDispatch >= graceMs) emit(false);
    } else if (at - lastDispatch >= graceMs) {
      unknownSince = null;
      emit(false);
    }
    schedule();
  };

  return {
    promptDispatched() {
      if (stopped) return;
      lastDispatch = now();
      unknownSince = null;
      emit(true);
      schedule();
    },
    get running() {
      return running;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      emit(false);
    },
  };
}
