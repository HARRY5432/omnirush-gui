// The per-launch secret that proves a request to the local server comes from this app (its window,
// or Electron main itself). Held in this process only: never on disk, never in an environment, never
// visible to the renderer's scripts. The local server runs in this process and reads it from the
// same global (apps/server/src/app-request-gate.ts): settings writes, secret reads and approval
// answers need it, so a server token read from the profile folder or a process environment cannot
// change what the person decided.
import { randomBytes } from "node:crypto";

export const APP_SECRET_HEADER = "x-omnirush-app-secret";
const SECRET_KEY = Symbol.for("omnirush.app.request-secret");
if (typeof globalThis[SECRET_KEY] !== "string") globalThis[SECRET_KEY] = randomBytes(32).toString("hex");
const SECRET = globalThis[SECRET_KEY];

const origins = new Set();

function originOf(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** The local server's address: only the current one (each start may bind another port; an old port may be anyone's now). */
export function rememberLocalServer(baseUrl) {
  const origin = originOf(baseUrl);
  if (!origin || !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin)) return;
  origins.clear();
  origins.add(origin);
}

/** Headers for Electron main's own request to `url`: the secret only for the local server. */
export function appSecretHeaders(url) {
  const origin = originOf(url);
  return origin && origins.has(origin) ? { [APP_SECRET_HEADER]: SECRET } : {};
}

/**
 * Adds the secret to the app window's own requests to the local server (and only those: a frame inside
 * the window, such as an HTML preview or an MCP app, another webContents or another address never gets
 * it), and drops any copy a page set itself. `isAppFrame(details)` says whether the request comes from
 * the app window's main frame.
 */
export function installAppRequestSecret(targetSession, isAppFrame) {
  targetSession.webRequest.onBeforeSendHeaders(
    { urls: ["http://127.0.0.1/*", "http://localhost/*", "http://[::1]/*"] },
    (details, callback) => {
      const requestHeaders = {};
      for (const [name, value] of Object.entries(details.requestHeaders ?? {})) {
        if (name.toLowerCase() !== APP_SECRET_HEADER) requestHeaders[name] = value;
      }
      const origin = originOf(details.url);
      let fromApp = false;
      try { fromApp = typeof details.webContentsId === "number" && isAppFrame(details) === true; } catch { fromApp = false; }
      if (fromApp && origin && origins.has(origin)) requestHeaders[APP_SECRET_HEADER] = SECRET;
      callback({ requestHeaders });
    },
  );
}
