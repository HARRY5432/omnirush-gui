/** @jsxImportSource react */
import { useEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { useUpdateCheckRequestStore } from "../domains/settings/state/update-check-request";
import { NOTIFICATION_OPEN_SESSION_EVENT, notificationSessionRoute } from "./desktop-notifications";
import { useUiStateStore } from "./ui-state-store";
import { settingsNavigationFromPathname } from "./workspace-routes";

const NATIVE_MENU_OPEN_SETTINGS_EVENT = "omnirush:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "omnirush:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "omnirush:native-menu:check-updates";

export function AppMenuProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const toggleSidebar = useUiStateStore((state) => state.toggleSidebar);

  useEffect(() => {
    const openSettingsTab = (tab: string) => {
      const target = settingsNavigationFromPathname(pathname, tab);
      navigate(target.to, { state: target.state });
    };
    const openSettings = () => openSettingsTab("general");
    const checkUpdates = () => {
      useUpdateCheckRequestStore.getState().requestUpdateCheck();
      openSettingsTab("updates");
    };

    // A clicked desktop notification: the shell focused the window, open the chat it was about.
    const takePending = (): unknown => {
      const bridge = (window as unknown as { __OMNIRUSH_ELECTRON__?: { notifications?: { takePendingOpenSession?: () => unknown } } }).__OMNIRUSH_ELECTRON__;
      return bridge?.notifications?.takePendingOpenSession?.() ?? null;
    };
    const openTarget = (detail: unknown) => {
      if (!detail || typeof detail !== "object") return;
      const sessionId = Reflect.get(detail, "sessionId");
      const workspaceId = Reflect.get(detail, "workspaceId");
      if (typeof sessionId !== "string" || !sessionId.trim()) return;
      const route = notificationSessionRoute({ sessionId, workspaceId: typeof workspaceId === "string" ? workspaceId : undefined });
      if (route !== pathname) navigate(route);
    };
    const openNotifiedSession = (event: Event) => {
      takePending();
      openTarget(event instanceof CustomEvent ? (event.detail as unknown) : null);
    };
    // A click that created this window arrived before this listener: open it now.
    openTarget(takePending());

    window.addEventListener(NATIVE_MENU_OPEN_SETTINGS_EVENT, openSettings);
    window.addEventListener(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, toggleSidebar);
    window.addEventListener(NATIVE_MENU_CHECK_UPDATES_EVENT, checkUpdates);
    window.addEventListener(NOTIFICATION_OPEN_SESSION_EVENT, openNotifiedSession);
    return () => {
      window.removeEventListener(NATIVE_MENU_OPEN_SETTINGS_EVENT, openSettings);
      window.removeEventListener(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, toggleSidebar);
      window.removeEventListener(NATIVE_MENU_CHECK_UPDATES_EVENT, checkUpdates);
      window.removeEventListener(NOTIFICATION_OPEN_SESSION_EVENT, openNotifiedSession);
    };
  }, [navigate, pathname, toggleSidebar]);

  return <>{children}</>;
}
