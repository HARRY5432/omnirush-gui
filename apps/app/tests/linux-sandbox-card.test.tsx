import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { OmniRushWorkspaceBox } from "../src/app/lib/omnirush-server";
import { LinuxSandboxCard } from "../src/react-app/domains/settings/pages/general-view";
import { LINUX_SANDBOX_HELP, linuxSandboxStatusLine } from "../src/react-app/domains/settings/linux-sandbox";

function box(overrides: Partial<OmniRushWorkspaceBox> = {}): OmniRushWorkspaceBox {
  return {
    mode: null,
    serverDefault: "off",
    on: false,
    source: "default",
    offer: false,
    state: "off",
    runtime: { ok: true, name: "docker", flavor: "desktop", version: "27.1", reason: null },
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
});
