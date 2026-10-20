/** @jsxImportSource react */
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { OmniRushSessionMessage } from "../src/app/lib/omnirush-server";
import type { SearchableSession } from "../src/react-app/domains/session/search/session-search";

const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { HomeRecent } = await import("../src/react-app/domains/session/home/home-recent");
const { homeChatTitle, recentChats, recentProjects, titleMatches } = await import("../src/react-app/domains/session/home/home-view-model");

const now = Date.now();
const sessions: SearchableSession[] = [
  { workspaceId: "ws_app", sessionId: "ses_a1", title: "Fix the login redirect", workspaceTitle: "app", updatedAt: now - 60_000 },
  { workspaceId: "ws_site", sessionId: "ses_s1", title: "New session - 2026-10-19T10:00:00.000Z", workspaceTitle: "site", updatedAt: now - 120_000 },
  { workspaceId: "ws_app", sessionId: "ses_a0", title: "Older chat", workspaceTitle: "app", updatedAt: now - 3_600_000 },
  { workspaceId: "ws_task", sessionId: "ses_t1", title: "Add a greeting", workspaceTitle: "app › add-a-greeting-ab12", updatedAt: now - 30_000 },
];
const workspaces = [
  { id: "ws_app", name: "app", task: false },
  { id: "ws_site", name: "site", task: false },
  { id: "ws_task", name: "app › add-a-greeting-ab12", task: true },
];

function message(id: string, role: "user" | "assistant", text: string): OmniRushSessionMessage {
  return {
    info: { id, role, sessionID: "x" },
    parts: [{ id: `${id}_p`, type: "text", text, sessionID: "x", messageID: id }],
  } as unknown as OmniRushSessionMessage;
}

describe("home view model", () => {
  test("recent chats are newest first across workspaces; projects open their latest chat and leave task copies out", () => {
    expect(recentChats(sessions).map((s) => s.sessionId)).toEqual(["ses_t1", "ses_a1", "ses_s1", "ses_a0"]);
    expect(recentProjects(sessions, workspaces)).toEqual([
      { workspaceId: "ws_app", name: "app", updatedAt: now - 60_000, chats: 2, lastSessionId: "ses_a1" },
      { workspaceId: "ws_site", name: "site", updatedAt: now - 120_000, chats: 1, lastSessionId: "ses_s1" },
    ]);
  });

  test("titles read like the CLI's: the engine's default title is an untitled chat", () => {
    expect(homeChatTitle("New session - 2026-10-19T10:00:00.000Z")).toBe("Untitled chat");
    expect(homeChatTitle("  Fix   it ")).toBe("Fix it");
    expect(titleMatches(sessions, "LOGIN").map((s) => s.sessionId)).toEqual(["ses_a1"]);
  });
});

describe("home screen", () => {
  test("shows recent projects and chats, opens one in a click, and searches past chats on this computer", async () => {
    const opened: string[] = [];
    const fetched: string[] = [];
    const fetchMessages = async (_workspaceId: string, sessionId: string) => {
      fetched.push(sessionId);
      return sessionId === "ses_a0" ? [message("m1", "user", "please add a rate limiter to the upload handler")] : [];
    };
    document.body.innerHTML = "<div id=root></div>";
    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(<HomeRecent context={{ sessions, workspaces, fetchMessages, onOpenSession: (w, s) => opened.push(`${w}/${s}`) }} />);
    });
    const projects = [...document.querySelectorAll<HTMLButtonElement>("[data-testid=home-project]")];
    expect(projects.map((p) => p.textContent)).toEqual([expect.stringContaining("app"), expect.stringContaining("site")]);
    expect(projects[0]!.textContent).toContain("2 chats");
    const chats = [...document.querySelectorAll<HTMLButtonElement>("[data-testid=home-chat]")];
    expect(chats.map((c) => c.textContent)).toEqual([
      expect.stringContaining("Add a greeting"),
      expect.stringContaining("Fix the login redirect"),
      expect.stringContaining("Untitled chat"),
      expect.stringContaining("Older chat"),
    ]);
    await act(async () => { projects[0]!.click(); });
    await act(async () => { chats[2]!.click(); });
    expect(opened).toEqual(["ws_app/ses_a1", "ws_site/ses_s1"]);
    expect(fetched).toEqual([]);

    const input = document.querySelector<HTMLInputElement>("[data-testid=home-search]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "rate limiter");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    const results = [...document.querySelectorAll<HTMLButtonElement>("[data-testid=home-chat]")];
    expect(results.length).toBe(1);
    expect(results[0]!.textContent).toContain("Older chat");
    expect(results[0]!.querySelector("mark")?.textContent).toBe("rate limiter");
    expect(document.querySelector("[data-testid=home-project]")).toBeNull();
    expect(fetched.sort()).toEqual(["ses_a0", "ses_a1", "ses_s1", "ses_t1"]);
    await act(async () => { results[0]!.click(); });
    expect(opened.at(-1)).toBe("ws_app/ses_a0");
    await act(async () => root.unmount());
  });

  test("nothing is shown before the first chat", async () => {
    document.body.innerHTML = "<div id=root></div>";
    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(<HomeRecent context={{ sessions: [], workspaces, fetchMessages: null, onOpenSession: () => undefined }} />);
    });
    expect(document.querySelector("[data-testid=home-recent]")).toBeNull();
    await act(async () => root.unmount());
  });
});
