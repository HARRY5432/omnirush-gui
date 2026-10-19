/**
 * Resolve the PostHog project key. `raw` is VITE_OMNIRUSH_POSTHOG_KEY.
 * There is no built-in key: analytics stay off unless a build sets one.
 * Explicit strings are used after trim; unset or blank disables analytics.
 *
 * Only a packaged build stamped with a release version sends: a dev or
 * unpackaged build (`pnpm dev`, a source checkout, the "0.0.0-dev"
 * placeholder version) never does, even with the key in its environment,
 * like the CLI's source checkout.
 */
export function resolvePosthogKey(raw: unknown, build: { appVersion?: string | null; packaged?: boolean } = {}): string {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key || build.packaged !== true) return "";
  const version = (build.appVersion ?? "").trim();
  const release = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!release || /^0\.0\.0(?:-|$)/.test(version) || /-dev(?:[.-]|$)/i.test(version)) return "";
  return key;
}
