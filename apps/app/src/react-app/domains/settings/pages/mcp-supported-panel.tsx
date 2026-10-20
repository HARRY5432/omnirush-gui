/** @jsxImportSource react */
// Settings > MCP: the servers the account's list supports (one-click
// presets) and this project's configured servers with the engine plugin's
// decision for each: on (its version, and whether it runs in the sandbox) or
// blocked with the reason. Remote and account-linked services are not
// supported: a session that used them could not be repeated.
import { useState } from "react";
import { Loader2, Plus } from "lucide-react";

import type { OmniRushMcpDecision, OmniRushMcpPolicyView, OmniRushMcpPreset } from "../../../../app/lib/omnirush-server";
import type { McpServerEntry } from "../../../../app/types";
import { Button } from "@/components/ui/button";

export const MCP_REMOTE_NOT_SUPPORTED =
  "Remote services (Notion, Linear, GitHub, Slack and other sign-in connectors) are not supported: they answer from an outside account, so a session that used them could not be repeated.";

export const MCP_ENGINE_V2_NOTE =
  "MCP servers are off while the preview engine runs chats. Turn the preview engine off to use them.";

/** What to do about a blocked server, by decision code (the reason says why). */
export const MCP_BLOCKED_HINTS: Record<string, string> = {
  denied: "Not on the supported list.",
  not_allowed: "Not on the supported list.",
  remote: "Remote servers are not supported.",
  unknown_command: "Start it with npx or uvx.",
  outside_project: "Point it at a folder or file inside the project.",
  version: "Leave the version out to use the supported one.",
};

export type McpServerState =
  | { kind: "on"; detail: string }
  | { kind: "blocked"; reason: string; hint: string | null }
  | { kind: "off" }
  | { kind: "pending" };

/** The line a configured server shows, from the plugin's decision. */
export function mcpServerState(entry: Pick<McpServerEntry, "name" | "config">, decision: OmniRushMcpDecision | null | undefined): McpServerState {
  if (!decision) return { kind: "pending" };
  if (decision.status === "blocked") {
    const reason = decision.reason?.trim() || "This MCP server is not supported.";
    const hint = MCP_BLOCKED_HINTS[decision.code] ?? null;
    // No hint that only repeats what the reason already says.
    const said = (text: string) => text.toLowerCase().replace(/\bmcp /g, "").replace(/\.$/, "");
    return { kind: "blocked", reason, hint: hint && !said(reason).includes(said(hint)) ? hint : null };
  }
  if ((entry.config as { enabled?: unknown } | undefined)?.enabled === false) return { kind: "off" };
  const parts = [
    decision.package && decision.version ? `${decision.package}@${decision.version}` : null,
    decision.sandbox ? "runs in the sandbox" : null,
    decision.renamed_to && decision.renamed_to !== decision.name ? `tools named ${decision.renamed_to}_…` : null,
  ].filter((part): part is string => Boolean(part));
  return { kind: "on", detail: parts.join(" · ") };
}

/** Server text with `code` spans: the backticked parts as inline code, the rest as plain text. */
export function PlainText(props: { text: string }) {
  const parts = props.text.split("`");
  if (parts.length < 3) return <>{props.text.replace(/`/g, "")}</>;
  return (
    <>
      {parts.map((part, index) => (index % 2 === 1 && index < parts.length - 1
        ? <code key={index} className="rounded bg-dls-hover px-1 font-mono text-[11px]">{part}</code>
        : <span key={index}>{part}</span>))}
    </>
  );
}

/** The command a preset adds, as one line. */
export function presetCommandLine(preset: Pick<OmniRushMcpPreset, "command">): string {
  return preset.command.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`)).join(" ");
}

/** Whether a configured entry already starts the preset's package. */
export function presetConfigured(preset: Pick<OmniRushMcpPreset, "id">, servers: Array<Pick<McpServerEntry, "name">>, decisions: OmniRushMcpDecision[]): boolean {
  return servers.some((server) => server.name === preset.id)
    || decisions.some((decision) => decision.status === "allowed" && decision.id === preset.id);
}

export function McpSupportedPanel(props: {
  policy: OmniRushMcpPolicyView;
  servers: McpServerEntry[];
  canAdd: boolean;
  busy: boolean;
  addPreset: (preset: OmniRushMcpPreset) => Promise<{ ok: boolean; error?: string }>;
  removeServer?: (name: string) => void;
}) {
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<{ id: string; message: string } | null>(null);
  const decisionFor = (name: string) => props.policy.decisions.find((decision) => decision.name === name) ?? null;

  if (!props.policy.enabled) {
    return (
      <p data-testid="mcp-policy-off" className="mb-5 text-sm text-dls-secondary">
        {props.policy.message?.trim() || "MCP servers are turned off for this account."}
      </p>
    );
  }

  const add = async (preset: OmniRushMcpPreset) => {
    setAdding(preset.id);
    setAddError(null);
    try {
      const result = await props.addPreset(preset);
      if (!result.ok) setAddError({ id: preset.id, message: result.error ?? "Could not add this server." });
    } finally {
      setAdding(null);
    }
  };

  return (
    <div data-testid="mcp-supported-panel" className="mb-6 flex flex-col gap-5">
      {props.policy.engineV2 ? (
        <p data-testid="mcp-engine-v2-note" className="text-sm text-dls-secondary">{MCP_ENGINE_V2_NOTE}</p>
      ) : null}

      {props.servers.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-foreground">This project's MCP servers</h3>
          <ul className="flex flex-col divide-y divide-dls-border rounded-xl border border-dls-border">
            {props.servers.map((server) => {
              const state = mcpServerState(server, decisionFor(server.name));
              return (
                <li key={server.name} data-testid={`mcp-server-${server.name}`} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{server.name}</p>
                    {state.kind === "on" ? (
                      <p className="mt-0.5 text-xs text-dls-secondary">
                        <span className="font-medium text-green-11">On</span>
                        {state.detail ? ` · ${state.detail}` : null}
                      </p>
                    ) : state.kind === "blocked" ? (
                      <p className="mt-0.5 text-xs text-dls-secondary">
                        <span className="font-medium text-amber-11">Blocked</span>{` · ${state.reason}${state.hint ? ` ${state.hint}` : ""}`}
                      </p>
                    ) : state.kind === "off" ? (
                      <p className="mt-0.5 text-xs text-dls-secondary">Off</p>
                    ) : (
                      <p className="mt-0.5 text-xs text-dls-secondary">Checked when the project's next chat starts.</p>
                    )}
                    {server.source === "config.project" || server.source === "config.global" ? (
                      <p className="mt-0.5 text-xs text-dls-secondary">{server.source === "config.project" ? "From the project's opencode.json" : "From your global opencode config"}</p>
                    ) : null}
                  </div>
                  {props.removeServer && server.source === "config.remote" ? (
                    <Button variant="ghost" size="sm" disabled={props.busy} onClick={() => props.removeServer?.(server.name)}>
                      Remove
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {props.policy.supported.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-foreground">Supported servers</h3>
          <p className="text-xs text-dls-secondary">Local servers that work on this project's own files. Each runs a fixed version, inside the project's sandbox when it is on.</p>
          <ul className="flex flex-col divide-y divide-dls-border rounded-xl border border-dls-border">
            {props.policy.supported.map((preset) => {
              const configured = presetConfigured(preset, props.servers, props.policy.decisions);
              return (
                <li key={preset.id} data-testid={`mcp-preset-${preset.id}`} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{preset.title}</p>
                    {preset.why ? <p className="mt-0.5 text-xs text-dls-secondary"><PlainText text={preset.why} /></p> : null}
                    <code className="mt-1 block truncate rounded-md bg-dls-hover px-2 py-1 font-mono text-[11px] text-dls-secondary" title={presetCommandLine(preset)}>
                      {presetCommandLine(preset)}
                    </code>
                    <p className="mt-1 text-[11px] text-dls-secondary">
                      {preset.version ? `Runs ${preset.package}@${preset.version}` : preset.package}
                      {preset.localPagesOnly ? " · local pages only" : null}
                    </p>
                    {addError?.id === preset.id ? <p className="mt-1 text-xs text-red-11">{addError.message}</p> : null}
                  </div>
                  {configured ? (
                    <span className="shrink-0 pt-1 text-xs text-dls-secondary">Added</span>
                  ) : props.canAdd ? (
                    <Button variant="outline" size="sm" className="shrink-0" disabled={props.busy || adding !== null} onClick={() => void add(preset)}>
                      {adding === preset.id ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                      Add
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <p data-testid="mcp-remote-not-supported" className="text-xs text-dls-secondary">{MCP_REMOTE_NOT_SUPPORTED}</p>
    </div>
  );
}
