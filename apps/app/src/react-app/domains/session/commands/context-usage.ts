// The context the chat uses: the newest assistant reply's tokens against its
// model's context window. The same rule and wording as the OmniRush CLI's
// /status (engine tui util/status-rows.ts).

type Tokens = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
type MessageInfo = { role?: string; tokens?: Tokens; providerID?: string; modelID?: string };

export type ContextUse = {
  used: number;
  max: number | null;
  percent: number | null;
  left: number | null;
  providerID: string | null;
  modelID: string | null;
  /** "21,000 of 400,000 tokens (5%) · 379,000 left", or "21,000 tokens" without a known window. */
  text: string;
  warning: boolean;
};

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const fmt = (value: number) => value.toLocaleString("en-US");

/** Context in use for the newest assistant message that produced output; null when there is none yet. */
export function contextUse(
  messages: readonly MessageInfo[],
  limit: (providerID: string, modelID: string) => number | null | undefined,
): ContextUse | null {
  const last = [...messages].reverse().find((item) => item.role === "assistant" && num(item.tokens?.output) > 0);
  if (!last?.tokens) return null;
  const t = last.tokens;
  const used = num(t.input) + num(t.output) + num(t.reasoning) + num(t.cache?.read) + num(t.cache?.write);
  const providerID = last.providerID ?? null;
  const modelID = last.modelID ?? null;
  const rawMax = providerID && modelID ? limit(providerID, modelID) : null;
  const max = typeof rawMax === "number" && rawMax > 0 ? rawMax : null;
  if (!max) return { used, max: null, percent: null, left: null, providerID, modelID, text: `${fmt(used)} tokens`, warning: false };
  const percent = Math.min(100, Math.round((used / max) * 100));
  const left = Math.max(0, max - used);
  return {
    used,
    max,
    percent,
    left,
    providerID,
    modelID,
    text: `${fmt(used)} of ${fmt(max)} tokens (${percent}%) · ${fmt(left)} left`,
    warning: percent >= 85,
  };
}

/** The Uploads row, in the CLI's words: "nothing waiting", "N waiting to be sent", or paused while signed out. */
export function uploadsLine(pending: { uploads?: number; archives?: number } | null | undefined, { signedOut = false } = {}): string | null {
  if (!pending) return null;
  const waiting = num(pending.uploads) + num(pending.archives);
  if (signedOut) return waiting ? `${waiting} waiting · sign in to send` : "paused · sign in to send";
  return waiting === 0 ? "nothing waiting" : `${waiting} waiting to be sent`;
}

type SandboxBox = {
  on: boolean;
  state?: string | null;
  backend?: { id?: string | null } | null;
  runtime?: { ok?: boolean; name?: string | null } | null;
};

/** The Sandbox row, in the CLI's words: "off", "on · docker", "off (fell back to this machine)". */
export function sandboxLabel(box: SandboxBox | null | undefined): string {
  if (!box?.on) return "off";
  if (box.state === "unavailable" || box.state === "failed") return "off (fell back to this machine)";
  const backend = box.backend?.id || (box.runtime?.ok ? box.runtime.name : null) || null;
  return backend ? `on · ${backend}` : "on";
}
