// Types for agent-assist-hooks.js (shared with omnirush-cli; see PARITY.sha256).
export function agentAssistHooks(
  input?: { client?: unknown; directory?: string; worktree?: string },
  options?: { env?: Record<string, string | undefined>; now?: () => number; log?: (level: string, message: string, extra?: unknown) => void },
): Record<string, (...args: any[]) => Promise<void>>;
