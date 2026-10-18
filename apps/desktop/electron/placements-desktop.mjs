// Sponsored placements in the desktop app (the main process's side).
//
// The rules live in ./placements/placements.mjs (the same file as the CLI's,
// PARITY.sha256 there). Here: the account's authorized call, the cache in the
// app's data folder, and what the window may ask (IPC omnirushPlacement and
// omnirushPlacementAction). The window only ever gets a placement to draw;
// the link is opened here, in the system browser, after a click.
//
// OMNIRUSH_PLACEMENTS=0 turns it off (the server is not asked).

import path from "node:path";

import { createPlacements, osName, refreshDue, SLOTS, STATE_FILE } from "./placements/placements.mjs";

/** After a failed ask, the window's next look waits at least this long before asking again. */
export const RETRY_AFTER_MS = 5 * 60_000;
const ACTIONS = new Set(["impression", "open", "dismiss"]);

/** @param {Record<string, string | undefined>} [env] */
export function desktopPlacementsAllowed(env = process.env) {
  return !["0", "false", "no", "off"].includes(String(env.OMNIRUSH_PLACEMENTS ?? "").trim().toLowerCase());
}

/**
 * `request(pathAndQuery, init)` resolves { status, data } or null (signed
 * out); `openUrl(url)` opens an https link in the system browser.
 * @param {{
 *   request: import("./placements/placements.mjs").PlacementsRequest,
 *   userDataPath: string,
 *   version?: string,
 *   platform?: string,
 *   env?: Record<string, string | undefined>,
 *   openUrl?: ((url: string) => Promise<{ ok: boolean } | boolean | void>) | null,
 *   now?: () => number,
 *   log?: (level: string, message: string, data?: object) => void,
 * }} options
 */
export function createDesktopPlacements({ request, userDataPath, version = "", platform = process.platform, env = process.env, openUrl = null, now = Date.now, log = () => undefined }) {
  const service = createPlacements({
    request,
    stateFile: path.join(userDataPath, STATE_FILE),
    client: "desktop",
    version,
    os: osName(platform),
    allowed: desktopPlacementsAllowed(env),
    now,
    log,
  });
  let lastAsk = 0;

  /** A fresh answer when the cache is due (signed in late, a long-running app), at most every RETRY_AFTER_MS. */
  async function refreshIfDue() {
    if (!refreshDue(service.state(), now()) || now() - lastAsk < RETRY_AFTER_MS) return;
    lastAsk = now();
    await service.refresh().catch(() => null);
  }

  return {
    service,
    start: () => {
      // The start's own ask counts: the window's first look does not ask again right after a failure.
      if (refreshDue(service.state(), now())) lastAsk = now();
      return service.start();
    },
    stop: () => service.stop(),
    /** IPC omnirushPlacement {slot, sessionId?}: the placement to draw, or null. */
    async placement(input) {
      const slot = typeof input?.slot === "string" && SLOTS.includes(input.slot) ? input.slot : null;
      if (!slot) return null;
      const sessionId = typeof input?.sessionId === "string" && input.sessionId.length <= 200 ? input.sessionId : null;
      if (slot === "turn_footer" && !sessionId) return null;
      await refreshIfDue();
      try {
        return service.claim(slot, { sessionId });
      } catch {
        return null;
      }
    },
    /** IPC omnirushPlacementAction {id, action}: impression, open (the click) or dismiss. */
    async action(input) {
      const id = typeof input?.id === "string" ? input.id : "";
      const action = typeof input?.action === "string" && ACTIONS.has(input.action) ? input.action : null;
      if (!id || !action) return { ok: false };
      if (action === "impression") return { ok: service.impression(id) };
      if (action === "dismiss") return { ok: service.dismiss(id) };
      const url = service.click(id);
      if (!url) return { ok: false };
      const opened = typeof openUrl === "function" ? await Promise.resolve(openUrl(url)).then((r) => (typeof r === "object" && r !== null ? r.ok !== false : r !== false)).catch(() => false) : false;
      return { ok: true, opened };
    },
  };
}
