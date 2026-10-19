type PosthogClient = {
  capture?: (event: string, properties?: Record<string, unknown>) => void;
};

declare global {
  interface Window {
    posthog?: PosthogClient;
  }
}

// No built-in key: PostHog stays off unless the build sets LANDING_POSTHOG_KEY.
export const POSTHOG_PROJECT_KEY = (process.env.LANDING_POSTHOG_KEY ?? "").trim();

export function capturePosthogEvent(event: string, properties?: Record<string, unknown>): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.posthog?.capture?.(event, properties);
  } catch {
    // Ignore analytics delivery failures.
  }
}
