import { useCallback, useEffect, useRef, useState } from "react";

import type { OmniRushAgentAssist, OmniRushAgentAssistChange, OmniRushAgentAssistFeature, OmniRushServerClient } from "@/app/lib/omnirush-server";

export type AgentAssistClient = Pick<OmniRushServerClient, "getAgentAssist" | "setAgentAssist">;

/** Settings > General > Agent: the four switches, in order, with their help lines. */
export const AGENT_ASSIST_ITEMS: { key: OmniRushAgentAssistFeature; title: string; help: string }[] = [
  {
    key: "selfCheck",
    title: "Check work before finishing",
    help: "After changing code, the agent runs the project's tests, linter or type check and fixes what fails (at most 3 rounds). Say \"skip the tests\" to skip it once.",
  },
  {
    key: "projectNotes",
    title: "Project notes (AGENTS.md)",
    help: "/init writes AGENTS.md with the build, test and run commands and conventions; the app offers to add what a session found. Your own lines are never removed without asking.",
  },
  {
    key: "diagnostics",
    title: "Code diagnostics",
    help: "Language servers for TypeScript/JavaScript, Python, Go and Rust tell the agent about errors right after each edit.",
  },
  {
    key: "compaction",
    title: "Detailed summaries",
    help: "When a long chat is summarized, keep your preferences, decisions, open to-dos, commands that worked and the files changed.",
  },
];

export function agentAssistChangeMessage(result: OmniRushAgentAssistChange): string {
  switch (result.engine.status) {
    case "applied":
      return "Saved. Applies to the next request.";
    case "deferred":
      return "Saved. Code diagnostics change once the engine is idle.";
    case "failed":
      return "Saved. The engine change could not be confirmed. Use Reload in Settings to apply it.";
    case "unconfigured":
      return "Saved. Applies when the engine starts.";
  }
}

export function useAgentAssist(client: AgentAssistClient | null) {
  const [setting, setSetting] = useState<OmniRushAgentAssist | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // A GET begun before a PUT must not replace the newly saved choice.
  const sequence = useRef(0);

  useEffect(() => {
    sequence.current += 1;
    const startedAt = sequence.current;
    let cancelled = false;
    setSetting(null);
    setBusy(false);
    setStatus("");
    if (client) {
      void client.getAgentAssist()
        .then((value) => {
          if (!cancelled && sequence.current === startedAt) setSetting(value);
        })
        .catch(() => {
          if (!cancelled && sequence.current === startedAt) setStatus("Agent settings could not be loaded. Try opening Settings again.");
        });
    }
    return () => { cancelled = true; };
  }, [client]);

  const setFeature = useCallback(async (key: OmniRushAgentAssistFeature, enabled: boolean) => {
    if (!client || busy) return;
    sequence.current += 1;
    const startedAt = sequence.current;
    setBusy(true);
    setStatus("Saving…");
    try {
      const result = await client.setAgentAssist({ [key]: enabled });
      if (sequence.current !== startedAt) return;
      setSetting({ features: result.features, forced: result.forced });
      setStatus(agentAssistChangeMessage(result));
    } catch {
      if (sequence.current !== startedAt) return;
      const saved = await client.getAgentAssist().catch(() => null);
      if (sequence.current !== startedAt) return;
      if (saved) setSetting(saved);
      setStatus("The change could not be saved. Open Settings again to check it.");
    } finally {
      if (sequence.current === startedAt) setBusy(false);
    }
  }, [busy, client]);

  return { setting, busy, status, setFeature };
}
