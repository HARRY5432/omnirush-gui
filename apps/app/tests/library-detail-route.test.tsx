/** @jsxImportSource react */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});

// McpView reads the Cloud session and Den sign-in; signed out is enough here.
const signedOutClient = new Proxy({}, { get: () => async () => [] });
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({
  useCloudSession: () => ({
    isSignedIn: false,
    authToken: "",
    activeOrganization: null,
    activeOrgName: null,
    client: signedOutClient,
  }),
}));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  useDenAuth: () => ({ isSignedIn: false, status: "signed_out" }),
}));

const { Profiler, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const { McpView, sameExtensionDetailTarget } = await import("../src/react-app/domains/settings/pages/mcp-view");
const { libraryCommandDetailId } = await import("../src/react-app/domains/settings/library");

type McpViewProps = Parameters<typeof McpView>[0];

const initCommand = { id: "cmd:init", name: "init", description: "guided AGENTS.md setup", template: "Create AGENTS.md" };
const reviewCommand = { id: "cmd:review", name: "review", description: "review changes", template: "Review" };

function props(detailId: string | null, onDetailIdChange: (id: string | null) => void): McpViewProps {
  return {
    busy: false,
    selectedWorkspaceRoot: "/tmp/project",
    isRemoteWorkspace: false,
    mcpServers: [],
    mcpStatus: null,
    mcpLastUpdatedAt: null,
    mcpStatuses: {},
    mcpConnectingName: null,
    allowManageExtensions: true,
    selectedMcp: null,
    setSelectedMcp: () => {},
    quickConnect: [],
    connectMcp: async () => ({ ok: true }) as never,
    authorizeMcp: () => {},
    logoutMcpAuth: () => {},
    removeMcp: () => {},
    // The parent's lists keep their identity between renders (state and memos in settings-route).
    installedCommands: COMMANDS,
    installedAgents: [],
    detailId,
    onDetailIdChange,
  };
}
const COMMANDS = [initCommand, reviewCommand];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Library item page", () => {
  test("an item page settles instead of rendering again and again", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let commits = 0;
    const view = (detailId: string | null) =>
      createElement(Profiler, { id: "library", onRender: () => { commits += 1; } }, createElement(McpView, props(detailId, () => {})));

    flushSync(() => root.render(view(libraryCommandDetailId(initCommand))));
    await sleep(400);
    const settled = commits;
    await sleep(400);
    // Before the fix every render made new list arrays, the routed detail effect ran again and
    // set a new target object: hundreds of commits a second, and route changes never got through.
    expect(commits - settled).toBe(0);
    expect(settled).toBeLessThan(20);
    expect(host.textContent).toContain("/init");

    // Leaving the page (the back link or any navigation) shows the list again.
    flushSync(() => root.render(view(null)));
    await sleep(100);
    expect(host.textContent).not.toContain("guided AGENTS.md setupAvailable in composer");
    flushSync(() => root.unmount());
    host.remove();
    // Let the unmount's passive effects run while the DOM globals are still registered.
    await sleep(50);
  });

  test("the same item object is the same target; another object is not", () => {
    const a = { kind: "command" as const, command: initCommand };
    expect(sameExtensionDetailTarget(a, { kind: "command", command: initCommand })).toBe(true);
    expect(sameExtensionDetailTarget(a, { kind: "command", command: { ...initCommand } })).toBe(false);
    expect(sameExtensionDetailTarget(a, { kind: "command", command: reviewCommand })).toBe(false);
    expect(sameExtensionDetailTarget(a, null)).toBe(false);
    expect(sameExtensionDetailTarget(null, null)).toBe(true);
  });
});
