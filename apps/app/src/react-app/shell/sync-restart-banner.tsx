/** @jsxImportSource react */
import { useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";

import { createOmniRushServerClient, type OmniRushCaptureStatus } from "../../app/lib/omnirush-server";
import { PLUGINS_LOCKED_MESSAGE, setProviderLockState } from "../../app/lib/provider-lock";
import { toast } from "@/components/ui/sonner";
import { resolveOmniRushConnection } from "./omnirush-connection";
import { BANNER_CLASS, BANNER_HEIGHT_PX, bannerShiftStyle } from "./update-gate";

export const SYNC_RESTART_BANNER_TEXT = "Session sync is restarting. Your work is safe; it will catch up automatically.";

const POLL_MS = 5_000;
/** A capture worker takes a moment to start; only a start longer than this shows the banner. */
const SLOW_START_MS = 10_000;

/**
 * Whether the app shows the sync banner: capture is restarting, stopped while
 * the server still answers, or slow to start. No answer (the server is
 * unreachable) and "off" (signed out) show none.
 */
export function captureBannerVisible(status: OmniRushCaptureStatus | null, now: number): boolean {
  if (!status || status.running) return false;
  switch (status.mode) {
    case "restarting":
    case "down":
      return true;
    case "starting":
      return status.since !== null && now - Date.parse(status.since) > SLOW_START_MS;
    default:
      return false;
  }
}

/** GET /omnirush/capture/status every five seconds while the window is visible. Never blocks prompts. */
export function useCaptureBannerVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let stopped = false;
    let inflight = false;
    const poll = async () => {
      if (inflight || document.visibilityState !== "visible") return;
      inflight = true;
      let status: OmniRushCaptureStatus | null = null;
      try {
        const connection = await resolveOmniRushConnection();
        if (connection.normalizedBaseUrl && connection.resolvedToken) {
          status = await createOmniRushServerClient({
            baseUrl: connection.normalizedBaseUrl,
            token: connection.resolvedToken,
            hostToken: connection.resolvedHostToken,
          }).getCaptureStatus();
        }
      } catch {
        // Unreachable, or an older server without the route: no banner.
      } finally {
        inflight = false;
      }
      if (!stopped) setVisible(captureBannerVisible(status, Date.now()));
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const onVisibility = () => void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return visible;
}

export function SyncRestartBanner() {
  return (
    <div role="status" aria-live="polite" data-testid="sync-restart-banner" className={BANNER_CLASS} style={{ height: BANNER_HEIGHT_PX }}>
      <RefreshCw className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{SYNC_RESTART_BANNER_TEXT}</span>
    </div>
  );
}

const PROVIDER_LOCK_POLL_MS = 60_000;
const PLUGINS_OFF_NOTICE_KEY = "omnirush.providerLock.pluginsOffNoticed";

/** Once per app profile: the user had plugins of their own and the lock keeps them off. */
function noticePluginsOffOnce(answer: unknown): void {
  if (typeof answer !== "object" || answer === null) return;
  const plugins = (answer as { locked?: unknown; plugins?: { userPlugins?: unknown } }).plugins;
  if ((answer as { locked?: unknown }).locked === false || typeof plugins?.userPlugins !== "number" || plugins.userPlugins <= 0) return;
  try {
    if (window.localStorage.getItem(PLUGINS_OFF_NOTICE_KEY)) return;
    window.localStorage.setItem(PLUGINS_OFF_NOTICE_KEY, String(Date.now()));
  } catch {
    return;
  }
  toast(PLUGINS_LOCKED_MESSAGE);
}

/**
 * Keeps the model provider lock (app/lib/provider-lock.ts) in step with the
 * app's server: at start, every minute while the window is visible, and when
 * it becomes visible. No answer is locked.
 */
export function useProviderLockSync(): void {
  useEffect(() => {
    let stopped = false;
    let inflight = false;
    const poll = async () => {
      if (inflight || document.visibilityState !== "visible") return;
      inflight = true;
      let answer: unknown = null;
      try {
        const connection = await resolveOmniRushConnection();
        if (connection.normalizedBaseUrl && connection.resolvedToken) {
          answer = await createOmniRushServerClient({
            baseUrl: connection.normalizedBaseUrl,
            token: connection.resolvedToken,
            hostToken: connection.resolvedHostToken,
          }).getProviderLock();
        }
      } catch {
        // Unreachable, or an older server without the route: locked.
      } finally {
        inflight = false;
      }
      if (!stopped) {
        setProviderLockState(answer);
        noticePluginsOffOnce(answer);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), PROVIDER_LOCK_POLL_MS);
    const onVisibility = () => void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}

/**
 * The top banner while session capture is not running, in the required-update
 * banner's style (below it when both show). Nothing is blocked: prompts go
 * on, and their sessions resume once capture is back.
 */
export function SyncRestartGate({ children }: { children: ReactNode }) {
  const visible = useCaptureBannerVisible();
  useProviderLockSync();
  return (
    <>
      {visible ? <SyncRestartBanner /> : null}
      <div data-sync-restart-shifted={visible ? "" : undefined} style={bannerShiftStyle(visible)}>
        {children}
      </div>
    </>
  );
}
