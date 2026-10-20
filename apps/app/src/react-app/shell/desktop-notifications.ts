import { desktopNotificationShow } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/utils";
import {
  DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE,
  isDesktopNotificationPreference,
  type DesktopNotificationPreference,
} from "@/react-app/kernel/desktop-notification-preferences";
import { LOCAL_PREFERENCES_KEY } from "@/react-app/kernel/local-preferences-storage";
import { legacySessionRoute, workspaceSessionRoute } from "@/react-app/shell/workspace-routes";

type DesktopNotificationImportance = "important" | "routine";
type WebNotificationHandler = (title: string, description?: string, href?: string) => Promise<void>;

/** The workspace the session belongs to, so a click on the notification can open it. */
type NotificationTarget = { sessionId: string; workspaceId?: string };

export type DesktopNotificationEvent =
  | ({ type: "task.completed" } & NotificationTarget)
  | ({ type: "task.failed"; errorText?: string } & NotificationTarget)
  | ({ type: "permission.asked"; detail?: string } & NotificationTarget)
  | ({ type: "question.asked"; question?: string } & NotificationTarget);

/** Sent by the desktop shell when a notification is clicked: open this chat. */
export const NOTIFICATION_OPEN_SESSION_EVENT = "omnirush:notification:open-session";

/** The route of the chat a notification is about. */
export function notificationSessionRoute(target: NotificationTarget): string {
  return target.workspaceId?.trim()
    ? workspaceSessionRoute(target.workspaceId, target.sessionId)
    : legacySessionRoute(target.sessionId);
}

type NotificationCopy = {
  title: string;
  body: string;
  importance: DesktopNotificationImportance;
};

let webNotificationHandler: WebNotificationHandler | null = null;

export function setWebNotificationHandler(handler: WebNotificationHandler | null): void {
  webNotificationHandler = handler;
}

function readDesktopNotificationPreference(): DesktopNotificationPreference {
  if (typeof window === "undefined") return DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE;
  try {
    const raw = window.localStorage.getItem(LOCAL_PREFERENCES_KEY);
    if (!raw) return DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE;
    const parsed: unknown = JSON.parse(raw);
    const value = parsed && typeof parsed === "object"
      ? Reflect.get(parsed, "desktopNotifications")
      : undefined;
    return isDesktopNotificationPreference(value)
      ? value
      : DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE;
  } catch {
    return DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE;
  }
}

function shouldNotify(
  preference: DesktopNotificationPreference,
  importance: DesktopNotificationImportance,
) {
  if (preference === "off") return false;
  if (preference === "important") return importance === "important";
  return true;
}

function isAppInView() {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

function copyForEvent(event: DesktopNotificationEvent): NotificationCopy {
  switch (event.type) {
    case "task.completed":
      return {
        title: "Task completed",
        body: "The session finished running.",
        importance: "routine",
      };
    case "task.failed":
      return {
        title: "Task failed",
        body: event.errorText?.trim() || "The session stopped with an error.",
        importance: "important",
      };
    case "permission.asked":
      return {
        title: "Permission needed",
        body: event.detail?.trim() || "A session is waiting for permission before it can continue.",
        importance: "important",
      };
    case "question.asked":
      return {
        title: "Question needs your answer",
        body: event.question?.trim() || "A session is waiting for your answer.",
        importance: "important",
      };
  }
}

export function notifyDesktopEvent(event: DesktopNotificationEvent): void {
  const copy = copyForEvent(event);
  if (!shouldNotify(readDesktopNotificationPreference(), copy.importance)) return;
  if (isAppInView()) return;

  if (!isDesktopRuntime()) {
    void webNotificationHandler?.(copy.title, copy.body, notificationSessionRoute(event)).catch(() => undefined);
    return;
  }

  void desktopNotificationShow({
    title: copy.title,
    body: copy.body,
    sessionId: event.sessionId,
    ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
  }).catch(() => undefined);
}
