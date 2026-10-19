/**
 * Agent assist: self-check after edits, project notes (/init, AGENTS.md), code
 * diagnostics and fuller compaction summaries. The hooks are the CLI's too
 * (../agent-assist/, PARITY). The server names the features that are on in the
 * file OMNIRUSH_AGENT_ASSIST_FILE points at (agent-assist-config.ts), so a
 * change in Settings applies without restarting the engine.
 */
import { agentAssistHooks } from "../agent-assist/agent-assist-hooks.js";

export const OmniRushAgentAssist = async (input: { client?: unknown; directory?: string; worktree?: string }) => agentAssistHooks(input);

export default OmniRushAgentAssist;
