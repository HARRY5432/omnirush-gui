import { useQuery } from "@tanstack/react-query";

import type { OmniRushServerClient, OmniRushWorkspaceTask, OmniRushWorkspaceTaskList } from "@/app/lib/omnirush-server";

/** The server calls the board makes (a slice of the local server client). */
export type WorkspaceTasksClient = Pick<
  OmniRushServerClient,
  "listWorkspaceTasks" | "showWorkspaceTask" | "bringBackWorkspaceTask" | "stopWorkspaceTask" | "removeWorkspaceTask"
>;

/** How often the board (and the sidebar's count) refreshes while a task runs. */
export const TASKS_POLL_MS = 3_000;

export function workspaceTasksQueryKey(workspaceId: string) {
  return ["workspace-tasks", workspaceId] as const;
}

export function isTaskActive(task: Pick<OmniRushWorkspaceTask, "state">): boolean {
  return task.state === "running" || task.state === "created";
}

export function runningTaskCount(list: OmniRushWorkspaceTaskList | undefined): number {
  return list?.tasks.filter(isTaskActive).length ?? 0;
}

/**
 * The parallel tasks of the repository a workspace belongs to. Polls only while
 * one of them runs; otherwise it refreshes when the board opens or acts.
 */
export function useWorkspaceTasks(client: WorkspaceTasksClient | null, workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: workspaceTasksQueryKey(workspaceId),
    queryFn: () => {
      if (!client) throw new Error("The local server is not connected.");
      return client.listWorkspaceTasks(workspaceId);
    },
    enabled: enabled && Boolean(client && workspaceId),
    refetchInterval: (query) => (runningTaskCount(query.state.data) > 0 ? TASKS_POLL_MS : false),
    staleTime: 1_000,
  });
}
