import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { OmniRushWorkspaceBox } from "../src/app/lib/omnirush-server";
import { LinuxSandboxCard } from "../src/react-app/domains/settings/pages/general-view";
import { LINUX_SANDBOX_HELP, linuxSandboxBackendLine, linuxSandboxOthersLine, linuxSandboxStatusLine } from "../src/react-app/domains/settings/linux-sandbox";

function box(overrides: Partial<OmniRushWorkspaceBox> = {}): OmniRushWorkspaceBox {
  return {
    mode: null,
    serverDefault: "off",
    on: false,
    source: "default",
    offer: false,
    state: "off",
    runtime: { ok: true, name: "docker", flavor: "desktop", version: "27.1", reason: null },
    backend: {
      id: "docker-desktop", label: "Docker Desktop", version: "27.1", flavor: "desktop", why: "the first that works here, in order: apple > orbstack > colima > docker-desktop",
      alternatives: [
        { id: "apple", label: "Apple container", ok: false, reason: "Apple container needs macOS 26 or later (this is macOS 25)" },
        { id: "docker-desktop", label: "Docker Desktop", ok: true, reason: null },
        { id: "colima", label: "colima", ok: true, reason: null },
      ],
      allowed: null,
    },
    backendSetting: { value: "auto", source: "auto", choices: [{ id: "auto", label: "Automatic" }, { id: "apple", label: "Apple container" }, { id: "docker-desktop", label: "Docker Desktop" }, { id: "native", label: "Off (this computer)" }] },
    image: { ref: "ghcr.io/omnirush-ai/box-base:2026.10.1", stack: "base", present: true, downloading: false },
    container: null,
    notice: null,
    error: null,
    ...overrides,
  };
}

function switchMarkup(markup: string): string {
  const match = markup.match(/<[a-z]+[^>]*role="switch"[^>]*>/);
  if (!match) throw new Error(`no switch in ${markup}`);
  return match[0];
}

describe("Linux sandbox card", () => {
  test("off: the switch, its help, and the offer line when the server suggests it", () => {
    const markup = renderToStaticMarkup(<LinuxSandboxCard box={box({ serverDefault: "offer", source: "server", offer: true })} busy={false} status="" onToggle={() => {}} onReset={() => {}} />);
    expect(markup).toContain("Run commands in a Linux sandbox (beta)");
    expect(markup).toContain(LINUX_SANDBOX_HELP);
    expect(markup).toContain("suggests turning this on");
    expect(switchMarkup(markup)).toContain('aria-checked="false"');
    expect(markup).not.toContain("Reset sandbox");
  });

  test("on: what the sandbox is doing, and Reset once a container exists", () => {
    const ready = renderToStaticMarkup(<LinuxSandboxCard box={box({ mode: "on", on: true, source: "project", state: "ready", container: { name: "omnirush-box-abc", exists: true, running: true } })} busy={false} status="" onToggle={() => {}} onReset={() => {}} />);
    expect(switchMarkup(ready)).toContain('aria-checked="true"');
    expect(ready).toContain("Ready (docker, desktop), container running.");
    expect(ready).toContain("Reset sandbox");
    // Nothing is claimed before the server answers.
    const loading = renderToStaticMarkup(<LinuxSandboxCard box={null} busy={false} status="" onToggle={() => {}} onReset={() => {}} />);
    expect(switchMarkup(loading)).toContain('aria-disabled="true"');
  });

  test("status lines: unavailable, downloading, failed, forced by the environment", () => {
    expect(linuxSandboxStatusLine(box({ on: true, state: "unavailable", runtime: { ok: false, name: null, flavor: null, version: null, reason: "Docker is installed but not running" } }))).toBe("Not available: Docker is installed but not running. Commands run on this computer.");
    expect(linuxSandboxStatusLine(box({ on: true, state: "downloading" }))).toContain("Downloading the sandbox image (once)");
    expect(linuxSandboxStatusLine(box({ on: true, state: "failed", error: "could not start the sandbox: x" }))).toBe("The sandbox could not start: could not start the sandbox: x. Commands run on this computer.");
    expect(linuxSandboxStatusLine(box({ source: "env" }))).toContain("OMNIRUSH_BOX");
  });

  test("backend: the chosen one with its version and why, the others with why not, and the override", () => {
    const value = box({ mode: "on", on: true, source: "project", state: "ready" });
    expect(linuxSandboxBackendLine(value)).toBe("Backend: Docker Desktop 27.1");
    expect(linuxSandboxOthersLine(value)).toBe("Others: Apple container (Apple container needs macOS 26 or later (this is macOS 25)); colima (available)");
    const markup = renderToStaticMarkup(<LinuxSandboxCard box={value} busy={false} status="" onToggle={() => {}} onReset={() => {}} onBackend={() => {}} />);
    expect(markup).toContain("Backend: Docker Desktop 27.1");
    expect(markup).toContain("in order: apple &gt; orbstack");
    expect(markup).toContain('aria-label="Sandbox backend"');
    expect(linuxSandboxBackendLine(box({ backend: { id: null, label: null, version: null, flavor: null, why: "no sandbox backend works here", alternatives: [], allowed: null } }))).toBe("Backend: none available");
    expect(linuxSandboxBackendLine(box({ backendSetting: { value: "native", source: "setting", choices: [] } }))).toBe("Backend: off (commands run on this computer)");
  });
});
