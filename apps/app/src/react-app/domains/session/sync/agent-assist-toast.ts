import { toast } from "@/components/ui/sonner";

/**
 * The engine's agent assist plugin (apps/server/src/agent-assist/) reports
 * through the engine's toast event: "Checked: 42 tests passed", "Check
 * failed", "Not checked", "Project notes". The app shows those, and only those
 * (NOTICE_TITLES in agent-assist.js; agent-assist-toast.test.ts keeps the list
 * equal), as its own toasts. One toast reaches every workspace stream of the
 * engine, so a repeat within a few seconds is dropped.
 */
export const AGENT_ASSIST_TOAST_TITLES = ["Checked", "Check failed", "Not checked", "Project notes"];
const REPEAT_MS = 3_000;
let last = { key: "", at: 0 };

export function agentAssistToast(properties: unknown, now = Date.now()): { title: string; message: string; variant: string } | null {
  if (!properties || typeof properties !== "object") return null;
  const { title, message, variant } = properties as Record<string, unknown>;
  if (typeof title !== "string" || !AGENT_ASSIST_TOAST_TITLES.includes(title) || typeof message !== "string") return null;
  const key = `${title}\n${message}`;
  if (last.key === key && now - last.at < REPEAT_MS) return null;
  last = { key, at: now };
  return { title, message, variant: typeof variant === "string" ? variant : "info" };
}

/** Shows an agent assist toast from an engine event; whether the event was one. */
export function showAgentAssistToast(event: { type: string; properties?: unknown }): boolean {
  if (event.type !== "tui.toast.show") return false;
  const shown = agentAssistToast(event.properties);
  if (!shown) return true;
  const text = shown.title === "Checked" || shown.title === "Check failed" ? `${shown.title}: ${shown.message}` : shown.title;
  const options = shown.title === "Checked" || shown.title === "Check failed" ? { duration: 6_000 } : { description: shown.message.replace(/`/g, ""), duration: 10_000 };
  if (shown.variant === "success") toast.success(text, options);
  else if (shown.variant === "warning") toast.warning(text, options);
  else if (shown.variant === "error") toast.error(text, options);
  else toast.info(text, options);
  return true;
}
