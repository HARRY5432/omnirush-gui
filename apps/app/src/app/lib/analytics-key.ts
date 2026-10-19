/**
 * Resolve the PostHog project key. `raw` is VITE_OMNIRUSH_POSTHOG_KEY.
 * There is no built-in key: analytics stay off unless a build sets one.
 * Explicit strings are used after trim; unset or blank disables analytics.
 */
export function resolvePosthogKey(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}
