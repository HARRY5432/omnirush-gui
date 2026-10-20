/** @jsxImportSource react */
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { OmniRushWorkspaceTask, OmniRushWorkspaceTaskList } from "../src/app/lib/omnirush-server";
import type { WorkspaceTasksClient } from "../src/react-app/domains/workspace/tasks/workspace-tasks-query";

// The DOM exists before React and the dialogs load (their portals look for it once).
const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { OmniRushServerError } = await import("../src/app/lib/omnirush-server");
const { TasksBoardPage } = await import("../src/react-app/domains/workspace/tasks/tasks-board-page");
const { runningTaskCount } = await import("../src/react-app/domains/workspace/tasks/workspace-tasks-query");
type Root = ReturnType<typeof createRoot>;

function task(overrides: Partial<OmniRushWorkspaceTask>): OmniRushWorkspaceTask {
  return {
    id: "t1", title: "Add a greeting", prompt: "Add a greeting", state: "running", label: "running",
    branch: "omnirush/add-a-greeting-ab12", baseBranch: "main", name: "app › add-a-greeting-ab12",
    path: "/code/app-tasks/add-a-greeting-ab12", workspaceId: "ws_task1", sessionId: "ses_1",
    createdAt: "2026-10-20T00:00:00.000Z", startedAt: "2026-10-20T00:00:00.000Z", finishedAt: null,
    age: "2 min ago", files: 1, finished: false, result: null, ...overrides,
  };
}

function fakeClient(list: OmniRushWorkspaceTaskList) {
  const calls: string[] = [];
  let current = list;
  let applyError: Error | null = null;
  const client: WorkspaceTasksClient = {
    listWorkspaceTasks: async () => current,
    showWorkspaceTask: async (_ws, id) => ({ task: current.tasks.find((entry) => entry.id === id)!, stat: " greeting.txt | 1 +", reply: "Added it." }),
    bringBackWorkspaceTask: async (_ws, id, mode) => {
      calls.push(`${mode}:${id}`);
      if (applyError) throw applyError;
      return { mode, files: [{ status: "A", file: "greeting.txt" }], task: { ...current.tasks.find((entry) => entry.id === id)!, state: mode === "apply" ? "applied" : "merged" } };
    },
    stopWorkspaceTask: async (_ws, id) => { calls.push(`stop:${id}`); return { stopped: true, task: current.tasks[0]! }; },
    removeWorkspaceTask: async (_ws, id) => { calls.push(`remove:${id}`); return { ok: true, removed: id }; },
  };
  return {
    client, calls,
    setList: (next: OmniRushWorkspaceTaskList) => { current = next; },
    failApply: (error: Error) => { applyError = error; },
  };
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function mount(client: WorkspaceTasksClient, extra: { opened?: string[]; started?: string[] } = {}) {
  document.body.innerHTML = "<div id=root></div>";
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(document.getElementById("root")!);
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TasksBoardPage
            client={client}
            workspaceId="ws_main"
            workspaceName="app"
            onStartTask={async (prompt) => { extra.started?.push(prompt); }}
            onOpenChat={(workspaceId, sessionId) => extra.opened?.push(`${workspaceId}/${sessionId}`)}
            onWorkspacesChanged={() => undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { unmount: () => act(() => root?.unmount()) };
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}" in ${document.body.textContent}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
  await settle();
}

describe("parallel tasks board", () => {
  test("a folder outside git explains that tasks need a repository with a commit", async () => {
    const { client } = fakeClient({ git: false, repo: null, branch: null, hasCommit: false, tasks: [] });
    const view = await mount(client);
    expect(document.body.textContent).toContain("Parallel tasks need a git repository");
    expect(document.querySelector<HTMLButtonElement>("[data-testid=tasks-new]")?.disabled).toBe(true);
    await view.unmount();
  });

  test("cards show each task's state, branch, files and age, with the actions that fit", async () => {
    const fake = fakeClient({
      git: true, repo: "app", branch: "main", hasCommit: true,
      tasks: [task({}), task({ id: "t2", title: "Fix the readme", state: "done", finished: true, files: 2, branch: "omnirush/fix-the-readme-cd34", sessionId: "ses_2", workspaceId: "ws_task2" })],
    });
    const opened: string[] = [];
    const view = await mount(fake.client, { opened });
    const cards = [...document.querySelectorAll<HTMLElement>("[data-testid=task-card]")];
    expect(cards.map((card) => card.dataset.taskState)).toEqual(["running", "done"]);
    expect(cards[0]!.textContent).toContain("omnirush/add-a-greeting-ab12");
    expect(cards[0]!.textContent).toContain("Running");
    expect(cards[0]!.textContent).toContain("1 file changed");
    expect(cards[0]!.textContent).toContain("Started 2 min ago");
    expect(cards[0]!.querySelector("[data-testid=task-apply]")).toBeNull();
    expect(button("Stop", cards[0]!)).toBeTruthy();
    expect(cards[1]!.textContent).toContain("2 files changed");
    expect(document.body.textContent).toContain("1 task running");
    await click(button("Open chat", cards[1]!));
    expect(opened).toEqual(["ws_task2/ses_2"]);
    await click(button("Stop", cards[0]!));
    expect(fake.calls).toContain("stop:t1");
    await view.unmount();
  });

  test("apply asks first, then brings the result back; a conflict is shown plainly and nothing else happens", async () => {
    const fake = fakeClient({ git: true, repo: "app", branch: "main", hasCommit: true, tasks: [task({ state: "done", finished: true })] });
    const view = await mount(fake.client);
    await click(document.querySelector<HTMLButtonElement>("[data-testid=task-apply]")!);
    expect(document.body.textContent).toContain("Apply the changes here?");
    expect(fake.calls).toEqual([]);
    await click(button("Apply here", document.querySelector("[role=alertdialog]") ?? document));
    expect(fake.calls).toEqual(["apply:t1"]);

    fake.failApply(new OmniRushServerError(409, "task_conflict", "The changes do not apply cleanly to the main checkout (it changed in the same places). Use merge, or resolve by hand."));
    await click(document.querySelector<HTMLButtonElement>("[data-testid=task-merge]")!);
    await click(button("Merge", document.querySelector("[role=alertdialog]") ?? document));
    expect(fake.calls).toEqual(["apply:t1", "merge:t1"]);
    expect(document.body.textContent).toContain("The merge did not go through");
    expect(document.body.textContent).toContain("Your checkout was left exactly as it was.");
    await view.unmount();
  });

  test("view changes shows the diff stat and the task's last reply; remove asks first", async () => {
    const fake = fakeClient({ git: true, repo: "app", branch: "main", hasCommit: true, tasks: [task({ state: "done", finished: true })] });
    const view = await mount(fake.client);
    await click(button("View changes"));
    expect(document.querySelector("[data-testid=tasks-changes-stat]")?.textContent).toContain("greeting.txt | 1 +");
    expect(document.body.textContent).toContain("Added it.");
    await click(button("Close"));
    await click(document.querySelector<HTMLButtonElement>("[data-testid=task-remove]")!);
    expect(document.body.textContent).toContain("Remove this task?");
    await click(button("Remove", document.querySelector("[role=alertdialog]") ?? document));
    expect(fake.calls).toEqual(["remove:t1"]);
    await view.unmount();
  });

  test("the new task dialog sends the prompt to start the task", async () => {
    const fake = fakeClient({ git: true, repo: "app", branch: "main", hasCommit: true, tasks: [] });
    const started: string[] = [];
    const view = await mount(fake.client, { started });
    expect(document.body.textContent).toContain("No tasks yet");
    await click(document.querySelector<HTMLButtonElement>("[data-testid=tasks-new]")!);
    const textarea = document.querySelector<HTMLTextAreaElement>("[data-testid=tasks-new-prompt]")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Add a health check route");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(document.querySelector<HTMLButtonElement>("[data-testid=tasks-new-start]")!);
    expect(started).toEqual(["Add a health check route"]);
    await view.unmount();
  });

  test("the sidebar count is the number of tasks still working", () => {
    expect(runningTaskCount(undefined)).toBe(0);
    expect(runningTaskCount({ git: true, repo: "app", branch: "main", hasCommit: true, tasks: [task({}), task({ id: "t2", state: "created" }), task({ id: "t3", state: "done" })] })).toBe(2);
  });
});
