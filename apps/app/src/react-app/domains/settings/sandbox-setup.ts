import type { OmniRushWorkspaceBox, OmniRushWorkspaceBoxSetupAction } from "@/app/lib/omnirush-server";

import { linuxSandboxNextStep, linuxSandboxProgress, type LinuxSandboxNextStep, type LinuxSandboxPending } from "./linux-sandbox";

/** Microsoft's page for turning virtualization on and other WSL problems. */
export const WSL_TROUBLESHOOTING_URL = "https://learn.microsoft.com/windows/wsl/troubleshooting";

/** One step of the setup's progress list. */
export type SandboxSetupStep = {
  id: "download" | "import" | "vm" | "start";
  label: string;
  state: "done" | "active" | "todo";
  /** The download bar (bytes, parts), on the active download step. */
  progress?: { value: number | null; label: string } | null;
};

export type SandboxSetupButton = { action: OmniRushWorkspaceBoxSetupAction | "retry" | "consent" | "cancel" | "later" | "settings"; label: string; primary?: boolean; disabled?: boolean; hint?: string };

/**
 * What the chat's setup panel shows: `kind` picks its layout. "progress" (the
 * steps), "action" (one thing to do, with its buttons), "blocked" (the box
 * cannot run on this computer; numbered steps when there is something to
 * try), "line" (one calm line: chats run here meanwhile), "ready" (a short
 * confirmation).
 */
export type SandboxSetupView = {
  kind: "progress" | "action" | "blocked" | "line" | "ready";
  tone: "busy" | "attention" | "error" | "ready" | "off";
  title: string;
  detail: string | null;
  steps: SandboxSetupStep[];
  /** Numbered things to do (turning virtualization on in the firmware). */
  howTo: string[];
  link: { label: string; href: string } | null;
  /** Explicit consent before the app changes Windows features. */
  consent: string | null;
  buttons: SandboxSetupButton[];
  /** A command to copy (the usual next step when no backend works). */
  next: LinuxSandboxNextStep | null;
  /** The last setup step's answer (the password prompt, the install), one line. */
  result: { ok: boolean; message: string } | null;
  /** While it cannot run: where chats run meanwhile. */
  fallbackLine: string | null;
};

const RUNS_HERE = "Chats run on this computer meanwhile.";

const FIRMWARE_STEPS = [
  "Restart the computer and open its BIOS/UEFI settings (often F2, F10, Del or Esc right at start; on Windows also Settings › System › Recovery › Advanced startup › UEFI Firmware Settings).",
  "Find Intel Virtualization Technology (VT-x) or AMD SVM Mode, usually under CPU, Advanced or Security.",
  "Turn it on, save and restart. Then choose Check again here.",
];

function base(): Omit<SandboxSetupView, "kind" | "tone" | "title"> {
  return { detail: null, steps: [], howTo: [], link: null, consent: null, buttons: [], next: null, result: null, fallbackLine: null };
}

/** The progress list: download, the WSL distro (Windows) or the VM (macOS), start. */
function progressSteps(box: OmniRushWorkspaceBox, vm: boolean): SandboxSetupStep[] {
  const downloading = box.state === "downloading";
  const wsl = box.backend?.id === "wsl" || box.runtime?.name === "wsl";
  // WSL: the distro is added first (no byte count yet), then the image comes down inside it.
  const importing = wsl && downloading && !box.progress?.bytesDone;
  const steps: SandboxSetupStep[] = [];
  if (vm) steps.push({ id: "vm", label: "Start the OmniRush VM", state: box.state === "unavailable" ? "active" : "done" });
  if (wsl) steps.push({ id: "import", label: "Add the OmniRush Linux distro to WSL", state: importing ? "active" : "done" });
  steps.push({ id: "download", label: "Download the sandbox (once)", state: importing || (vm && box.state === "unavailable") ? "todo" : downloading ? "active" : "done", progress: downloading && !importing ? linuxSandboxProgress(box.progress) : null });
  steps.push({ id: "start", label: "Start the sandbox", state: box.state === "starting" ? "active" : box.state === "ready" ? "done" : "todo" });
  return steps;
}

/**
 * The chat's "Setting up the sandbox" panel for the selected project, or
 * null when there is nothing to show (not required, off, or ready).
 * `chatRunning`: a chat runs now ("Restart now" waits for it). `consenting`:
 * the user chose "Set up (one restart)" and sees what it changes.
 */
export function sandboxSetupView(box: OmniRushWorkspaceBox | null, { pending = null, chatRunning = false, consenting = false, justReady = false }: { pending?: LinuxSandboxPending; chatRunning?: boolean; consenting?: boolean; justReady?: boolean } = {}): SandboxSetupView | null {
  if (!box?.required || !box.on) return null;
  if (box.state === "ready") return justReady ? { ...base(), kind: "ready", tone: "ready", title: "The sandbox is ready", detail: box.requiredText?.line ?? null } : null;
  const setup = box.setup ?? null;
  const result = setup?.result ? { ok: setup.result.ok, message: setup.result.message } : null;
  const busy = pending !== null;
  if (box.state === "downloading" || box.state === "starting") {
    return { ...base(), kind: "progress", tone: "busy", title: "Setting up the sandbox", detail: "New chats in this project start as soon as it is ready. This happens once.", steps: progressSteps(box, false) };
  }
  if (box.state === "failed") {
    return { ...base(), kind: "action", tone: "error", title: "The sandbox could not start", detail: box.error ?? box.notice, buttons: [{ action: "retry", label: "Try again", primary: true, disabled: busy }], fallbackLine: RUNS_HERE };
  }
  if (!setup || setup.need === "none") {
    return { ...base(), kind: "progress", tone: "busy", title: "Setting up the sandbox", detail: "Checking this computer…", steps: progressSteps(box, false) };
  }
  if (setup.declined && setup.need !== "cannot_run") {
    return { ...base(), kind: "line", tone: "off", title: "Sandbox setup postponed", detail: "Chats run on this computer until it is set up.", buttons: [{ action: "check", label: "Set up now", disabled: busy }] };
  }
  switch (setup.need) {
    case "linux_allow":
      return {
        ...base(), kind: "action", tone: "attention", title: "Allow the sandbox on this computer",
        detail: "Ubuntu blocks the sandbox until an administrator allows it once. This installs OmniRush's own sandbox helper for this computer and allows only that helper; nothing else changes. Your password is asked once.",
        buttons: [{ action: "linux_allow", label: "Allow the sandbox", primary: true, disabled: busy }, { action: "decline", label: "Not now", disabled: busy }],
        result, fallbackLine: RUNS_HERE,
      };
    case "win_install":
      if (consenting) {
        return {
          ...base(), kind: "action", tone: "attention", title: "Turn on WSL 2?",
          detail: null,
          consent: "This turns on two Windows features, Windows Subsystem for Linux and Virtual Machine Platform, with one Windows administrator prompt, and downloads WSL from Microsoft. Windows then needs one restart; OmniRush opens again afterwards and finishes the setup. Your files and other apps are not changed.",
          buttons: [{ action: "win_install", label: "Turn on and continue", primary: true, disabled: busy }, { action: "cancel", label: "Cancel", disabled: busy }],
        };
      }
      return {
        ...base(), kind: "action", tone: "attention", title: "Set up the sandbox",
        detail: "The sandbox runs in WSL 2, which is not turned on on this PC yet. OmniRush can set it up for you: one administrator prompt, then one restart.",
        buttons: [{ action: "consent", label: "Set up (one restart)", primary: true, disabled: busy }, { action: "decline", label: "Not now", disabled: busy }],
        result, fallbackLine: RUNS_HERE,
      };
    case "win_restart":
      return {
        ...base(), kind: "action", tone: "attention", title: "Restart needed",
        detail: "WSL 2 is installed. Restart Windows to finish; OmniRush opens again afterwards and completes the setup.",
        buttons: [
          { action: "win_restart", label: "Restart now", primary: true, disabled: busy || chatRunning, ...(chatRunning ? { hint: "Waits until the running chat has finished." } : {}) },
          { action: "later", label: "Later", disabled: busy },
        ],
        fallbackLine: RUNS_HERE,
      };
    case "win_update":
      return { ...base(), kind: "action", tone: "attention", title: "Update WSL", detail: "WSL needs an update before the sandbox can start. Windows may ask for permission.", buttons: [{ action: "win_update", label: "Update WSL", primary: true, disabled: busy }, { action: "check", label: "Check again", disabled: busy }], fallbackLine: RUNS_HERE };
    case "mac_vm":
      return { ...base(), kind: "progress", tone: "busy", title: "Setting up the sandbox", detail: "OmniRush starts its own small Linux VM on this Mac (once, no admin password).", steps: progressSteps(box, true) };
    case "cannot_run":
      return cannotRun(box, busy);
    case "runtime": {
      const next = linuxSandboxNextStep(box);
      return { ...base(), kind: "action", tone: "attention", title: next.title, detail: next.detail, next, buttons: [{ action: "check", label: "Check again", disabled: busy }, { action: "settings", label: "Sandbox settings" }], fallbackLine: RUNS_HERE };
    }
  }
}

/** The box cannot run on this computer: why, what to try when there is something, and that chats run here. */
function cannotRun(box: OmniRushWorkspaceBox, busy: boolean): SandboxSetupView {
  const setup = box.setup;
  const why = setup?.why ?? null;
  const check: SandboxSetupButton = { action: "check", label: "Check again", disabled: busy };
  const line = setup?.whyText ?? box.runtime?.reason ?? null;
  switch (why) {
    case "firmware_off":
      return { ...base(), kind: "blocked", tone: "error", title: "Turn on virtualization", detail: "The sandbox needs virtualization, which is turned off in this computer's BIOS/UEFI settings (Intel VT-x or AMD SVM).", howTo: FIRMWARE_STEPS, link: { label: "Microsoft's guide", href: WSL_TROUBLESHOOTING_URL }, buttons: [check], fallbackLine: RUNS_HERE };
    case "nested_vm":
      return { ...base(), kind: "blocked", tone: "error", title: "This Windows runs in a virtual machine", detail: "The sandbox needs nested virtualization, which this virtual machine's host does not offer. Whoever runs the host (Hyper-V, VMware, VirtualBox, a cloud PC) has to turn on nested virtualization for this machine.", link: { label: "Microsoft's guide", href: WSL_TROUBLESHOOTING_URL }, buttons: [check], fallbackLine: RUNS_HERE };
    case "s_mode":
      return { ...base(), kind: "blocked", tone: "error", title: "Windows in S mode", detail: "Windows in S mode can't run WSL, which the sandbox needs. Switching out of S mode (free, in the Microsoft Store) lets it run.", buttons: [check], fallbackLine: RUNS_HERE };
    case "old_windows":
      return { ...base(), kind: "blocked", tone: "error", title: "Windows update needed", detail: "The sandbox needs Windows 10 version 2004 (build 19041) or later. Update Windows, then check again.", buttons: [check], fallbackLine: RUNS_HERE };
    case "policy":
      return { ...base(), kind: "blocked", tone: "error", title: "Blocked by your organisation", detail: "Your organisation's settings block WSL, which the sandbox needs. Ask your IT team to allow Windows Subsystem for Linux and Virtual Machine Platform.", buttons: [check], fallbackLine: RUNS_HERE };
    case "old_macos":
      return { ...base(), kind: "blocked", tone: "error", title: "macOS update needed", detail: "The sandbox needs macOS 13 or later.", buttons: [check], fallbackLine: RUNS_HERE };
    default:
      return { ...base(), kind: "line", tone: "off", title: setup?.line ?? (line ? `The sandbox can't run on this computer: ${line.replace(/\.$/, "")}.` : "The sandbox can't run on this computer."), detail: RUNS_HERE, buttons: [check] };
  }
}
