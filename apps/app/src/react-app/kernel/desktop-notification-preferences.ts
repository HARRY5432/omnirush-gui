export const DESKTOP_NOTIFICATION_PREFERENCE_VALUES = ["off", "important", "all"] as const;

export type DesktopNotificationPreference =
  (typeof DESKTOP_NOTIFICATION_PREFERENCE_VALUES)[number];

/** Finished tasks and approvals or questions, while the window is not focused. */
export const DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE: DesktopNotificationPreference = "all";

export function isDesktopNotificationPreference(
  value: unknown,
): value is DesktopNotificationPreference {
  return value === "off" || value === "important" || value === "all";
}
