/**
 * The app's own per-run secrets that the engine holds in its environment: the
 * engine server's login, the app server's bearer, the policy token and the
 * local gateway's key. A command the agent runs (a shell call or a terminal)
 * gets the engine's environment plus the `shell.env` hook's values, so each is
 * set to "" there: no command can read one or use it against the local servers.
 */
export const SHELL_SECRET_ENV = Object.freeze([
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_PASSWORD",
  "OMNIRUSH_SERVER_TOKEN",
  "OMNIRUSH_POLICY_TOKEN",
  "OMNIRUSH_ACCESS_TOKEN",
]);

/** Blanks every app secret in a shell's env (the engine's `shell.env` hook output). */
export function blankShellSecrets(env: Record<string, string> | undefined | null): void {
  if (!env) return;
  for (const name of SHELL_SECRET_ENV) env[name] = "";
}
