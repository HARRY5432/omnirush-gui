import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { OmniRushWorkspaceBox, OmniRushWorkspaceBoxSetup } from "../src/app/lib/omnirush-server";
import { LinuxSandboxCard } from "../src/react-app/domains/settings/linux-sandbox-card";
import { linuxSandboxView } from "../src/react-app/domains/settings/linux-sandbox";
import { sandboxSetupView, WSL_TROUBLESHOOTING_URL } from "../src/react-app/domains/settings/sandbox-setup";

const TEXT = {
  line: "New chats run in the OmniRush sandbox, set up for you.",
  optOut: "Required for new chats on this account. Chats started before keep running where they started.",
  keptOldChat: "Started on this computer before the sandbox was required: it stays here.",
};

function box(overrides: Partial<OmniRushWorkspaceBox> = {}): OmniRushWorkspaceBox {
  return {
    mode: null,
    serverDefault: "on",
    on: true,
    source: "required",
    offer: false,
    state: "unavailable",
    runtime: { ok: false, name: null, flavor: null, version: null, reason: "no backend" },
    backend: { id: null, label: null, version: null, flavor: null, why: null, alternatives: [], allowed: null },
    backendSetting: { value: "auto", source: "auto", choices: [{ id: "auto", label: "Automatic" }, { id: "bwrap", label: "bubblewrap" }, { id: "native", label: "Off (this computer)" }] },
    image: { ref: "ghcr.io/omnirush-ai/box-base:2026.10.2", stack: "base", present: false, downloading: false },
    progress: null,
    container: null,
    platform: "linux",
    notice: null,
    error: null,
    required: true,
    requiredText: TEXT,
    hostOnly: null,
    setup: null,
    ...overrides,
  };
}

function setup(overrides: Partial<OmniRushWorkspaceBoxSetup>): OmniRushWorkspaceBoxSetup {
  return { need: "none", why: null, whyText: null, declined: false, result: null, fallback: "native", ...overrides };
}

describe("sandbox setup panel: what it shows", () => {
  test("nothing unless the sandbox is required, on and not ready (ready: a moment after it was shown)", () => {
    expect(sandboxSetupView(box({ required: false }))).toBeNull();
    expect(sandboxSetupView(box({ on: false, source: "env" }))).toBeNull();
    expect(sandboxSetupView(box({ state: "ready" }))).toBeNull();
    expect(sandboxSetupView(box({ state: "ready" }), { justReady: true })).toMatchObject({ kind: "ready", tone: "ready", title: "The sandbox is ready", detail: TEXT.line });
  });

  test("downloading and starting: the steps with bytes; WSL adds its distro step", () => {
    const view = sandboxSetupView(box({ state: "downloading", runtime: { ok: true, name: "bwrap", flavor: "overlayfs", version: "0.11", reason: null }, progress: { bytesDone: 120_000_000, bytesTotal: 300_000_000, layersDone: 2, layersTotal: 5, startedAt: 1 } }));
    expect(view).toMatchObject({ kind: "progress", title: "Setting up the sandbox" });
    expect(view?.steps.map((step) => `${step.id}:${step.state}`)).toEqual(["download:active", "start:todo"]);
    expect(view?.steps[0]?.progress).toEqual({ value: 40, label: "120 of 300 MB · 40%" });
    const wsl = sandboxSetupView(box({ state: "downloading", platform: "win32", runtime: { ok: true, name: "wsl", flavor: "omnirush-distro", version: "2.4", reason: null }, backend: { id: "wsl", label: "WSL", version: null, flavor: null, why: null, alternatives: [], allowed: null } }));
    expect(wsl?.steps.map((step) => `${step.id}:${step.state}`)).toEqual(["import:active", "download:todo", "start:todo"]);
    const starting = sandboxSetupView(box({ state: "starting", runtime: { ok: true, name: "bwrap", flavor: "", version: "", reason: null } }));
    expect(starting?.steps.map((step) => `${step.id}:${step.state}`)).toEqual(["download:done", "start:active"]);
  });

  test("Linux, AppArmor: Allow the sandbox and Not now, with the password prompt's answer", () => {
    const view = sandboxSetupView(box({ setup: setup({ need: "linux_allow", result: { ok: false, message: "The password prompt was dismissed; nothing changed.", at: 1 } }) }));
    expect(view).toMatchObject({ kind: "action", title: "Allow the sandbox on this computer", result: { ok: false } });
    expect(view?.buttons.map((b) => b.action)).toEqual(["linux_allow", "decline"]);
    expect(view?.fallbackLine).toBe("Chats on this computer run here meanwhile.");
  });

  test("Windows: Set up (one restart), then the explicit consent; Restart needed waits for a running chat", () => {
    const install = box({ platform: "win32", setup: setup({ need: "win_install" }) });
    expect(sandboxSetupView(install)?.buttons.map((b) => b.label)).toEqual(["Set up (one restart)", "Not now"]);
    const consent = sandboxSetupView(install, { consenting: true });
    expect(consent?.consent).toContain("Windows Subsystem for Linux and Virtual Machine Platform");
    expect(consent?.consent).toContain("one restart");
    expect(consent?.buttons.map((b) => b.action)).toEqual(["win_install", "cancel"]);
    const restart = box({ platform: "win32", setup: setup({ need: "win_restart" }) });
    expect(sandboxSetupView(restart)?.buttons).toEqual([{ action: "win_restart", label: "Restart now", primary: true, disabled: false }, { action: "later", label: "Later", disabled: false }]);
    expect(sandboxSetupView(restart, { chatRunning: true })?.buttons[0]).toMatchObject({ disabled: true, hint: "Waits until the running chat has finished." });
  });

  test("no virtualization: firmware steps with Microsoft's page, nested VM, S mode, old Windows, policy; each with Check again", () => {
    const firmware = sandboxSetupView(box({ platform: "win32", setup: setup({ need: "cannot_run", why: "firmware_off" }) }));
    expect(firmware).toMatchObject({ kind: "blocked", title: "Turn on virtualization", link: { href: WSL_TROUBLESHOOTING_URL } });
    expect(firmware?.howTo.join(" ")).toContain("Intel Virtualization Technology (VT-x) or AMD SVM Mode");
    for (const [why, title] of [["nested_vm", "This Windows runs in a virtual machine"], ["s_mode", "Windows in S mode"], ["old_windows", "Windows update needed"], ["policy", "Blocked by your organisation"]] as const) {
      const view = sandboxSetupView(box({ platform: "win32", setup: setup({ need: "cannot_run", why }) }));
      expect(view?.title).toBe(title);
      expect(view?.buttons.map((b) => b.action)).toEqual(["check"]);
      expect(view?.fallbackLine).toBe("Chats on this computer run here meanwhile.");
    }
    expect(WSL_TROUBLESHOOTING_URL).toBe("https://learn.microsoft.com/windows/wsl/troubleshooting");
  });

  test("cannot run, no known why: one calm line (the shared text); declined: postponed with Set up now", () => {
    const line = sandboxSetupView(box({ setup: setup({ need: "cannot_run", line: "The sandbox can't run on this computer: unprivileged user namespaces are off." }) }));
    expect(line).toMatchObject({ kind: "line", title: "The sandbox can't run on this computer: unprivileged user namespaces are off.", detail: "Chats on this computer run here meanwhile." });
    const declined = sandboxSetupView(box({ setup: setup({ need: "linux_allow", declined: true }) }));
    expect(declined).toMatchObject({ kind: "line", title: "Sandbox setup postponed" });
    expect(declined?.buttons.map((b) => b.label)).toEqual(["Set up now"]);
  });

  test("macOS VM progress (the VM backend's hook) and the usual next step when no backend works", () => {
    const mac = sandboxSetupView(box({ platform: "darwin", setup: setup({ need: "mac_vm" }) }));
    expect(mac?.steps.map((step) => `${step.id}:${step.state}`)).toEqual(["vm:active", "download:todo", "start:todo"]);
    const runtime = sandboxSetupView(box({ platform: "linux", setup: setup({ need: "runtime" }) }));
    expect(runtime).toMatchObject({ kind: "action", title: "Install Podman or Docker" });
    expect(runtime?.next?.command).toBe("sudo apt install podman");
  });
});

describe("required: the settings card and the status row", () => {
  test("the switch is disabled with the shared line; Off (this computer) cannot be picked", () => {
    const markup = renderToStaticMarkup(<LinuxSandboxCard box={box({ state: "ready", runtime: { ok: true, name: "bwrap", flavor: "", version: "0.11", reason: null } })} pending={null} problem={null} notice="" onToggle={() => {}} onRetry={() => {}} onReset={() => {}} onBackend={() => {}} defaultAdvancedOpen />);
    const toggle = /<[a-z]+[^>]*role="switch"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(toggle).toContain('aria-checked="true"');
    expect(toggle).toContain('aria-disabled="true"');
    expect(markup).toContain(TEXT.optOut);
    expect(markup).toContain('data-testid="linux-sandbox-backend-required"');
  });

  test("a host-only project says why its chats run here", () => {
    const view = linuxSandboxView(box({ on: false, source: "host-only", state: "off", hostOnly: { things: ["App.xcodeproj"], notice: "This project only builds on Mac (App.xcodeproj), so its chats run on this Mac." } }));
    expect(view).toMatchObject({ tone: "attention", title: "Runs on this computer", detail: "This project only builds on Mac (App.xcodeproj), so its chats run on this Mac." });
  });
});
