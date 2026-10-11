import { useCallback, useEffect, useRef, useState } from "react";

import type { OmniRushServerClient, OmniRushWorkspaceBox } from "@/app/lib/omnirush-server";

export type LinuxSandboxClient = Pick<OmniRushServerClient, "getWorkspaceBox" | "setWorkspaceBox" | "setWorkspaceBoxBackend" | "resetWorkspaceBox">;

export const LINUX_SANDBOX_HELP = "Commands run in a Linux container for this project. Your files stay in this folder; installs are kept per project.";

/** The one line under the switch: what the sandbox is doing now, or why it is not used. */
export function linuxSandboxStatusLine(box: OmniRushWorkspaceBox): string {
  if (!box.on) {
    if (box.offer) return "Your omnirush.ai server suggests turning this on for this project.";
    if (box.source === "env") return "Turned off for this app (OMNIRUSH_BOX).";
    return "Off. Commands run on this computer.";
  }
  const runtime = box.runtime?.ok ? [box.runtime.name, box.runtime.flavor && box.runtime.flavor !== "engine" ? box.runtime.flavor : null].filter(Boolean).join(", ") : null;
  switch (box.state) {
    case "unavailable":
      return box.notice ?? `Not available: ${box.runtime?.reason ?? "no container runtime found"}. Commands run on this computer.`;
    case "downloading":
      return "Downloading the sandbox image (once). Commands run on this computer until it is ready.";
    case "starting":
      return runtime ? `Starting the sandbox (${runtime})…` : "Starting the sandbox…";
    case "ready":
      return `Ready${runtime ? ` (${runtime})` : ""}${box.container?.running ? ", container running" : ""}.`;
    case "failed":
      return `The sandbox could not start${box.error ? `: ${box.error}` : ""}. Commands run on this computer.`;
    case "off":
      return box.notice ?? "Off. Commands run on this computer.";
  }
}

/** "Backend: <label> <version>": what runs the sandbox on this computer. */
export function linuxSandboxBackendLine(box: OmniRushWorkspaceBox): string {
  if (box.backendSetting.value === "native") return "Backend: off (commands run on this computer)";
  const backend = box.backend;
  if (!backend?.id) return "Backend: none available";
  return `Backend: ${[backend.label ?? backend.id, backend.version].filter(Boolean).join(" ")}`;
}

/** The other backends here, one short entry each: available, or why not. */
export function linuxSandboxOthersLine(box: OmniRushWorkspaceBox): string | null {
  const others = (box.backend?.alternatives ?? []).filter((alt) => alt.id !== box.backend?.id);
  if (!others.length) return null;
  return `Others: ${others.map((alt) => `${alt.label} (${alt.ok ? "available" : alt.reason ?? "not available"})`).join("; ")}`;
}

/** States that change on their own: the card asks again while it shows one. */
const MOVING = new Set<OmniRushWorkspaceBox["state"]>(["downloading", "starting"]);
const POLL_MS = 5_000;

/** The selected workspace's sandbox: its status (polled while it moves), the switch and Reset. */
export function useLinuxSandbox(client: LinuxSandboxClient | null, workspaceId: string | null) {
  const [box, setBox] = useState<OmniRushWorkspaceBox | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const sequence = useRef(0);

  const load = useCallback(async (fresh = false) => {
    if (!client || !workspaceId) return;
    const startedAt = sequence.current;
    const value = await client.getWorkspaceBox(workspaceId, { fresh }).catch(() => null);
    if (sequence.current !== startedAt) return;
    if (value) setBox(value);
    else setStatus("The sandbox status could not be loaded.");
  }, [client, workspaceId]);

  useEffect(() => {
    sequence.current += 1;
    setBox(null);
    setBusy(false);
    setStatus("");
    void load(true);
  }, [load]);

  useEffect(() => {
    if (!box || !box.on || !MOVING.has(box.state)) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [box, load]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!client || !workspaceId || busy) return;
    sequence.current += 1;
    const startedAt = sequence.current;
    setBusy(true);
    setStatus(enabled ? "Turning the sandbox on…" : "Turning the sandbox off…");
    try {
      const result = await client.setWorkspaceBox(workspaceId, enabled ? "on" : "off");
      if (sequence.current !== startedAt) return;
      setBox(result);
      setStatus(result.engine.status === "failed" ? "Saved. The engine change could not be confirmed: use Reload in Settings." : "");
    } catch {
      if (sequence.current !== startedAt) return;
      setStatus("The choice could not be saved. Try again.");
    } finally {
      if (sequence.current === startedAt) setBusy(false);
    }
  }, [busy, client, workspaceId]);

  const reset = useCallback(async () => {
    if (!client || !workspaceId || busy) return;
    sequence.current += 1;
    const startedAt = sequence.current;
    setBusy(true);
    setStatus("Resetting the sandbox…");
    try {
      const result = await client.resetWorkspaceBox(workspaceId);
      if (sequence.current !== startedAt) return;
      setStatus(result.removed ? "Sandbox reset. The next chat starts a fresh one." : "There was no sandbox to reset.");
    } catch {
      if (sequence.current !== startedAt) return;
      setStatus("The sandbox could not be reset. Try again.");
    } finally {
      if (sequence.current === startedAt) setBusy(false);
    }
    await load(true);
  }, [busy, client, load, workspaceId]);

  const setBackend = useCallback(async (backend: string) => {
    if (!client || !workspaceId || busy) return;
    sequence.current += 1;
    const startedAt = sequence.current;
    setBusy(true);
    setStatus("Saving the backend…");
    try {
      const result = await client.setWorkspaceBoxBackend(workspaceId, backend);
      if (sequence.current !== startedAt) return;
      setBox(result);
      setStatus("");
    } catch {
      if (sequence.current !== startedAt) return;
      setStatus("The backend could not be saved. Try again.");
    } finally {
      if (sequence.current === startedAt) setBusy(false);
    }
  }, [busy, client, workspaceId]);

  return { box, busy, status, setEnabled, setBackend, reset };
}
