/** @jsxImportSource react */
import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { OmniRushApprovalMode, OmniRushRuntimeApprovals } from "../src/app/lib/omnirush-server";
import type { ApprovalsClient } from "../src/react-app/domains/settings/approval-mode";

// The composer switch reads the organization policy through the desktop-config
// provider and reports through the app toaster; neither is mounted here.
let policyLocked = false;
const toasts: string[] = [];
mock.module("@/react-app/domains/cloud/desktop-config-provider", () => ({
  useDesktopRestriction: () => policyLocked,
}));
mock.module("@/components/ui/sonner", () => ({
  toast: {
    success: (message: string) => toasts.push(`success:${message}`),
    warning: (message: string) => toasts.push(`warning:${message}`),
    error: (message: string) => toasts.push(`error:${message}`),
  },
}));

if (typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined") {
  GlobalRegistrator.register({ url: "http://localhost/" });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const [
  { FullPermissionsToggle, FULL_PERMISSIONS_POLICY_LOCK },
  { useApprovalMode, useApprovalModeStore },
  { ApprovalsCard },
  { TooltipProvider },
] = await Promise.all([
  import("../src/react-app/domains/session/surface/composer/full-permissions-toggle"),
  import("../src/react-app/domains/settings/approval-mode"),
  import("../src/react-app/domains/settings/pages/general-view"),
  import("../src/components/ui/tooltip"),
]);

function fakeClient(
  baseUrl: string,
  initial: OmniRushRuntimeApprovals,
  options: { reloadError?: Error; setError?: Error; holdSet?: boolean } = {},
) {
  const calls: string[] = [];
  let gets = 0;
  let approvals = initial;
  let release: (() => void) | null = null;
  const client: ApprovalsClient = {
    baseUrl,
    getRuntimeApprovals: async () => {
      gets += 1;
      return approvals;
    },
    setRuntimeApprovals: async (mode: OmniRushApprovalMode) => {
      calls.push(`set:${mode}`);
      if (options.holdSet) await new Promise<void>((resolve) => { release = resolve; });
      if (options.setError) throw options.setError;
      approvals = { mode, source: "settings", setting: mode };
      return { ...approvals, ok: true, changed: true };
    },
    reloadEngine: async (workspaceId: string) => {
      calls.push(`reload:${workspaceId}`);
      if (options.reloadError) throw options.reloadError;
      return { ok: true };
    },
  };
  return { client, calls, gets: () => gets, release: () => release?.() };
}

const mounted: { root: Root; container: HTMLElement }[] = [];

async function mount(ui: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(<TooltipProvider delay={0}>{ui}</TooltipProvider>));
  return container;
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  toasts.length = 0;
  policyLocked = false;
  useApprovalModeStore.setState({ byServer: {} });
});

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function toggleIn(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[data-testid="full-permissions-toggle"]');
  if (!button) throw new Error("the permissions menu is not rendered");
  return button;
}

async function click(button: HTMLElement) {
  await act(async () => {
    button.click();
  });
}

function item(mode: OmniRushApprovalMode): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="permission-mode-${mode}"]`);
}

/** Opens the menu and picks a mode. */
async function choose(container: HTMLElement, mode: OmniRushApprovalMode) {
  await click(toggleIn(container));
  await waitFor(() => item(mode) !== null, `the ${mode} item`);
  await click(item(mode)!);
}

const guardedByDefault: OmniRushRuntimeApprovals = { mode: "guarded", source: "default", setting: null };
const loaded = (container: HTMLElement) => toggleIn(container).dataset.state !== "loading";

test("shows the current mode on load; Auto reads as a warning", async () => {
  const guarded = fakeClient("http://guarded.test", guardedByDefault);
  const container = await mount(<FullPermissionsToggle client={guarded.client} workspaceId="ws_1" />);
  await waitFor(() => loaded(container), "the normal mode to load");
  const normal = toggleIn(container);
  expect(normal.dataset.state).toBe("guarded");
  expect(normal.getAttribute("aria-label")).toBe("Permissions: Normal");
  expect(normal.textContent).toContain("Normal");
  expect(normal.dataset.lockReason).toBeUndefined();
  expect(normal.className).not.toContain("text-orange-11");

  const full = fakeClient("http://full.test", { mode: "full", source: "settings", setting: "full" });
  const active = await mount(<FullPermissionsToggle client={full.client} workspaceId="ws_1" />);
  await waitFor(() => toggleIn(active).dataset.state === "full", "the auto mode to load");
  expect(toggleIn(active).textContent).toContain("Auto");
  expect(toggleIn(active).className).toContain("text-orange-11");

  const careful = fakeClient("http://careful.test", { mode: "careful", source: "settings", setting: "careful" });
  const asking = await mount(<FullPermissionsToggle client={careful.client} workspaceId="ws_1" />);
  await waitFor(() => toggleIn(asking).dataset.state === "careful", "the careful mode to load");
  expect(toggleIn(asking).textContent).toContain("Careful");
  expect(toggleIn(asking).className).not.toContain("text-orange-11");

  // Nothing renders without a server client.
  const none = await mount(<FullPermissionsToggle client={null} workspaceId="ws_1" />);
  expect(none.querySelector('[data-testid="full-permissions-toggle"]')).toBeNull();
});

test("lists the three modes and disables them while the environment or the organisation forces the mode", async () => {
  const env = fakeClient("http://env.test", { mode: "full", source: "environment", setting: "guarded" });
  const container = await mount(<FullPermissionsToggle client={env.client} workspaceId="ws_1" />);
  await waitFor(() => toggleIn(container).dataset.state === "full", "the environment mode to load");
  expect(toggleIn(container).dataset.lockReason).toBe("Set by environment (OMNIRUSH_APPROVALS=full); change it where the app is launched.");
  await choose(container, "careful");
  expect(item("careful")?.textContent).toContain("Asks before every file change");
  expect(item("guarded")?.textContent).toContain("Normal");
  expect(item("full")?.getAttribute("aria-checked")).toBe("true");
  expect(item("careful")?.getAttribute("aria-disabled")).toBe("true");
  expect(document.querySelector('[data-testid="permission-mode-lock"]')?.textContent).toContain("Set by environment");
  expect(env.calls).toEqual([]);
  expect(toasts).toEqual([]);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

  policyLocked = true;
  const guarded = fakeClient("http://policy.test", guardedByDefault);
  const locked = await mount(<FullPermissionsToggle client={guarded.client} workspaceId="ws_1" />);
  await waitFor(() => toggleIn(locked).dataset.lockReason === FULL_PERMISSIONS_POLICY_LOCK, "the policy lock");
  await choose(locked, "full");
  expect(guarded.calls).toEqual([]);
});

test("choosing persists the mode, reloads the engine and stays busy while the reload is in flight", async () => {
  const held = fakeClient("http://toggle.test", guardedByDefault, { holdSet: true });
  const container = await mount(<FullPermissionsToggle client={held.client} workspaceId="ws_1" />);
  await waitFor(() => loaded(container), "the normal mode to load");

  await choose(container, "full");
  await waitFor(() => toggleIn(container).getAttribute("aria-busy") === "true", "the in-flight state");
  expect(held.calls).toEqual(["set:full"]);

  await act(async () => held.release());
  await waitFor(() => toggleIn(container).dataset.state === "full", "the auto mode");
  expect(held.calls).toEqual(["set:full", "reload:ws_1"]);
  expect(toggleIn(container).getAttribute("aria-busy")).toBeNull();
  expect(toasts).toEqual(["success:Auto mode. Engine reloaded."]);

  await choose(container, "careful");
  await act(async () => held.release());
  await waitFor(() => toggleIn(container).dataset.state === "careful", "the careful mode");
  expect(held.calls.slice(2)).toEqual(["set:careful", "reload:ws_1"]);
  expect(toasts[1]).toBe("success:Careful mode. Engine reloaded.");
});

test("reports a failed reload or a refused change without losing the mode", async () => {
  const reloadFails = fakeClient("http://reload-fails.test", guardedByDefault, { reloadError: new Error("engine busy") });
  const container = await mount(<FullPermissionsToggle client={reloadFails.client} workspaceId="ws_1" />);
  await waitFor(() => loaded(container), "the normal mode to load");
  await choose(container, "full");
  await waitFor(() => toggleIn(container).dataset.state === "full", "the saved auto mode");
  expect(toasts).toEqual(["warning:Auto mode. Engine reload failed: engine busy Use Reload in Settings to apply it."]);

  const refused = fakeClient("http://refused.test", guardedByDefault, { setError: new Error("settings are locked") });
  const other = await mount(<FullPermissionsToggle client={refused.client} workspaceId="ws_1" />);
  await waitFor(() => loaded(other), "the second normal mode to load");
  await choose(other, "careful");
  await waitFor(() => toasts.length === 2, "the error toast");
  expect(toasts[1]).toBe("error:settings are locked");
  expect(toggleIn(other).dataset.state).toBe("guarded");
  expect(refused.calls).toEqual(["set:careful"]);
});

/** The Settings card exactly as GeneralSettingsView wires it. */
function SettingsCard(props: { client: ApprovalsClient }) {
  const mode = useApprovalMode(props.client, "ws_1");
  return (
    <ApprovalsCard
      approvals={mode.approvals}
      busy={mode.busy}
      status={mode.status}
      onSelect={(next) => void mode.setApprovalMode(next)}
    />
  );
}

test("shares its state with the Settings card, so a change in either shows in the other", async () => {
  const shared = fakeClient("http://shared.test", guardedByDefault);
  const container = await mount(
    <>
      <FullPermissionsToggle client={shared.client} workspaceId="ws_1" />
      <SettingsCard client={shared.client} />
    </>,
  );
  const cardButton = (mode: OmniRushApprovalMode) => {
    const element = container.querySelector<HTMLButtonElement>(`[data-testid="approval-mode-${mode}"]`);
    if (!element) throw new Error("the Settings card is not rendered");
    return element;
  };
  await waitFor(() => loaded(container), "the shared load");
  expect(shared.gets()).toBe(1);
  expect(cardButton("guarded").getAttribute("aria-checked")).toBe("true");

  await choose(container, "full");
  await waitFor(() => cardButton("full").getAttribute("aria-checked") === "true", "the card to follow the composer");
  expect(container.querySelector('[data-testid="approvals-status"]')?.textContent).toBe("Auto mode. Engine reloaded.");
  expect(toasts).toEqual(["success:Auto mode. Engine reloaded."]);

  await click(cardButton("careful"));
  await waitFor(() => toggleIn(container).dataset.state === "careful", "the composer to follow the card");
  expect(shared.calls).toEqual(["set:full", "reload:ws_1", "set:careful", "reload:ws_1"]);
  // Settings changes report inline, not through the composer toast.
  expect(toasts).toHaveLength(1);
  expect(toggleIn(container).dataset.lockReason).toBeUndefined();
});
