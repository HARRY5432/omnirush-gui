/**
 * Test switches for capture. OMNIRUSH_ELECTRON_FAKE_MEDIA gives Chromium a
 * fake microphone (a beep); OMNIRUSH_VOICE_INPUT_FILE (the voice-core test
 * hook) plays that WAV file through the fake microphone once, so voice
 * dictation runs end to end, AudioWorklet included, without a real device.
 */
export function configureFakeMediaForTests(app, enabled, env = process.env) {
  const audioFile = String(env.OMNIRUSH_VOICE_INPUT_FILE ?? "").trim();
  if (!enabled && !audioFile) return;
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  if (!audioFile) return;
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("use-file-for-fake-audio-capture", `${audioFile}%noloop`);
}

function isLocalRendererOrigin(origin) {
  const value = String(origin ?? "").trim();
  if (!value || value === "file://") return true;
  try {
    const url = new URL(value);
    return url.protocol === "file:" || url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function shouldAllowMainWindowPermission(input) {
  const { webContents, permission, origin, details, mainWindow } = input;
  if (!mainWindow || !webContents || webContents.id !== mainWindow.webContents.id) return false;
  if (!isLocalRendererOrigin(origin)) return false;
  if (permission !== "media" && permission !== "audioCapture") return true;
  const mediaType = typeof details.mediaType === "string" ? details.mediaType : "";
  if (mediaType && mediaType !== "audio") return false;
  const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  return mediaType === "audio" || (mediaTypes.includes("audio") && !mediaTypes.includes("video"));
}

export function installMediaPermissionHandlers(session, getMainWindow) {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(shouldAllowMainWindowPermission({
      webContents,
      permission,
      origin: details?.requestingUrl,
      details: details ?? {},
      mainWindow: getMainWindow(),
    }));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    shouldAllowMainWindowPermission({
      webContents,
      permission,
      origin: requestingOrigin,
      details: details ?? {},
      mainWindow: getMainWindow(),
    })
  ));
}

// The built-in browser shows arbitrary websites. Only harmless, page-local
// capabilities are granted; camera, microphone, location, notifications,
// clipboard reads, screen capture, devices and the rest are denied.
const BROWSER_PANEL_ALLOWED_PERMISSIONS = new Set([
  "clipboard-sanitized-write",
  "fileSystem",
  "fullscreen",
  "keyboardLock",
  "mediaKeySystem",
  "pointerLock",
  "storage-access",
  "top-level-storage-access",
]);

function isDesktopSchemeUrl(url) {
  return /^omnirush(?:-dev)?:/i.test(String(url ?? "").trim());
}

/**
 * @param {string} permission
 */
export function isBrowserPanelPermissionAllowed(permission) {
  return BROWSER_PANEL_ALLOWED_PERMISSIONS.has(permission);
}

/**
 * Permission policy for the built-in browser's session (persist:omnirush-browser).
 * Handing a link to the OS ("openExternal") asks the user first, except
 * omnirush:// links, which only the browser panel's own confirmation forwards.
 *
 * @param {Electron.Session} browserSession
 * @param {{ confirmExternal: (url: string, sourceUrl: string) => Promise<boolean> }} options
 */
export function installBrowserPanelPermissionHandlers(browserSession, { confirmExternal }) {
  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== "openExternal") {
      callback(isBrowserPanelPermissionAllowed(permission));
      return;
    }
    const request = /** @type {{ externalURL?: string, requestingUrl?: string }} */ (details ?? {});
    const externalUrl = String(request.externalURL ?? "");
    if (!externalUrl || isDesktopSchemeUrl(externalUrl)) {
      callback(false);
      return;
    }
    const sourceUrl = String(request.requestingUrl ?? webContents?.getURL?.() ?? "");
    Promise.resolve()
      .then(() => confirmExternal(externalUrl, sourceUrl))
      .then((allowed) => callback(allowed === true), () => callback(false));
  });
  browserSession.setPermissionCheckHandler((_webContents, permission) => isBrowserPanelPermissionAllowed(permission));
}
