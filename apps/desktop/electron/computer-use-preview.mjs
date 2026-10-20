import { BrowserWindow, ipcMain, screen } from "electron";
import { fileURLToPath } from "node:url";
export function createComputerPreview() {
  let host, panel, current, placedSession;
  const channel = "omnirush-computer-use-preview-action";
  const action = (_event, value) => {
    if (!panel || _event.sender !== panel.webContents || _event.senderFrame !== panel.webContents.mainFrame || !["stop", "hide", "pause"].includes(value) || !current) return;
    void host.control({ session_id: current.id, action: value === "pause" ? "takeover" : value }).catch(() => {});
  };
  ipcMain.on(channel, action);
  const placement = () => {
    const nativeBounds = current.windowBounds ?? { x: 0, y: 0, width: 800, height: 600 };
    const bounds = process.platform === "win32" ? screen.screenToDipRect(null, nativeBounds) : nativeBounds;
    const display = screen.getDisplayMatching(bounds), area = display.workArea;
    const box = process.platform === "linux" && display.scaleFactor !== 1
      ? Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Math.round(value / display.scaleFactor)]))
      : bounds;
    const width = Math.min(330, area.width), height = Math.min(300, area.height), gap = 12;
    const clamp = (value, start, span, size) => Math.round(Math.max(start, Math.min(value, start + span - size)));
    const y = clamp(box.y, area.y, area.height, height), x = clamp(box.x, area.x, area.width, width);
    const candidates = [
      { x: box.x + box.width + gap, y },
      { x: box.x - width - gap, y },
      { x, y: box.y + box.height + gap },
      { x, y: box.y - height - gap },
    ];
    const position = candidates.find((p) => p.x >= area.x && p.y >= area.y && p.x + width <= area.x + area.width && p.y + height <= area.y + area.height)
      ?? { x: area.x + area.width - width, y: area.y };
    return { ...position, width, height };
  };
  const show = () => {
    if (panel && !panel.isDestroyed()) { if (placedSession !== current.id) { panel.setBounds(placement()); placedSession = current.id; } panel.showInactive(); return; }
    panel = new BrowserWindow({ ...placement(), title: "OmniRush.ai · Computer Use", show: false, alwaysOnTop: true, resizable: true, minimizable: false, webPreferences: { preload: fileURLToPath(new URL("./computer-use-preview-preload.cjs", import.meta.url)), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    placedSession = current.id;
    panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    panel.webContents.on("will-navigate", (event) => event.preventDefault());
    panel.on("close", (event) => { if (!current) return; event.preventDefault(); void host.control({ session_id: current.id, action: "hide" }).catch(() => {}); });
    panel.webContents.once("did-finish-load", () => { if (current?.previewVisible) { panel.webContents.send("omnirush-computer-use-preview-state", current); panel.showInactive(); } });
    void panel.loadFile(fileURLToPath(new URL("./computer-use-preview.html", import.meta.url)));
  };
  return {
    bind(value) { host = value; },
    /** Host states (portable-host.mjs): the first working or paused session shows the pill. */
    update(states) {
      const value = states.find((s) => s.phase === "working" || s.phase === "paused");
      current = value ? { id: value.id, phase: value.phase, mode: value.mode, status: value.status, appName: value.app.app_name, remainingSeconds: value.seconds_left, previewVisible: !value.hidden, windowBounds: value.window_bounds ?? null } : null;
      if (!current || !current.previewVisible) { panel?.hide(); return; }
      show(); panel.webContents.send("omnirush-computer-use-preview-state", current);
    },
    image(dataUrl) { panel?.webContents.send("omnirush-computer-use-preview-image", dataUrl); },
    close() { current = null; panel?.destroy(); panel = null; ipcMain.removeListener(channel, action); },
  };
}
