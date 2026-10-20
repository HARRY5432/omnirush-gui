// Computer use, policy: the server switch (capabilities `computer_use`), the
// apps the agent may never open, and which actions ask the person first in
// each permission mode.
//
// The same file ships in omnirush-cli (src/computer-use/) and omnirush-gui
// (apps/server/src/computer-use/shared/); PARITY.sha256 lists it in both. No
// imports beyond node: built-ins and ./contract.mjs.

import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

import { normalizeLimits, osName, SERVER_ID } from "./contract.mjs";

export const PERMISSION_MODES = Object.freeze(["careful", "normal", "auto"]);
export const CLIENTS = Object.freeze(["cli", "desktop"]);
export const OFF_MESSAGE = "Computer use is turned off for this account.";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value, limit = 256, max = 200) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.trim() && v.length <= max).map((v) => v.trim()).slice(0, limit) : null;
}

function text(value, limit = 400) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
}

// ------------------------------------------------------------ server switch

/**
 * The `computer_use` block of a /collect/capabilities answer, normalized. A
 * missing or malformed block is off. The server already applied
 * `rollout_percent` (and the account) to `enabled`.
 * Shape: { enabled, clients, os, models, real_screen, virtual_display,
 * deny_apps, limits, message } (null lists: no restriction).
 */
export function normalizeComputerUse(block) {
  if (!isRecord(block)) return { enabled: false, clients: null, os: null, models: null, real_screen: false, virtual_display: false, deny_apps: [], limits: normalizeLimits(null), message: null };
  const denyApps = Array.isArray(block.deny_apps)
    ? block.deny_apps.flatMap((item) => {
      if (typeof item === "string" && item.trim()) return [{ match: item.trim().slice(0, 200), reason: null }];
      if (isRecord(item) && typeof item.match === "string" && item.match.trim()) return [{ match: item.match.trim().slice(0, 200), reason: text(item.reason, 300) }];
      return [];
    }).slice(0, 256)
    : [];
  return {
    enabled: block.enabled === true,
    clients: strings(block.clients, 8, 40),
    os: strings(block.os, 8, 40),
    models: strings(block.models, 64, 128),
    real_screen: block.real_screen !== false,
    virtual_display: block.virtual_display !== false,
    deny_apps: denyApps,
    limits: normalizeLimits(block.limits),
    message: text(block.message),
  };
}

const ON = ["1", "on", "true", "yes"];
const OFF = ["0", "off", "false", "no"];

/**
 * Whether computer use is on for this app. In this order: the environment
 * (OMNIRUSH_COMPUTER_USE=1/on or 0/off; tests and support), then the server's
 * block (`block`, as last seen), else off. `client` is "cli" or "desktop".
 * Returns the normalized block plus { enabled, source, reason }.
 */
export function computerUseSetting({ env = process.env, block, client, platform = process.platform } = {}) {
  const server = normalizeComputerUse(block);
  const asked = String(env?.OMNIRUSH_COMPUTER_USE ?? "").trim().toLowerCase();
  if (OFF.includes(asked)) return { ...server, enabled: false, source: "env", reason: "env" };
  if (ON.includes(asked)) return { ...server, enabled: true, real_screen: true, virtual_display: true, source: "env", reason: null };
  if (!isRecord(block)) return { ...server, enabled: false, source: "default", reason: "no_switch" };
  if (!server.enabled) return { ...server, source: "server", reason: "off" };
  if (server.clients && client && !server.clients.includes(client)) return { ...server, enabled: false, source: "server", reason: "client" };
  if (server.os && !server.os.includes(osName(platform))) return { ...server, enabled: false, source: "server", reason: "os" };
  if (!server.real_screen && !server.virtual_display) return { ...server, enabled: false, source: "server", reason: "no_display" };
  return { ...server, source: "server", reason: null };
}

/** Whether the model may use the tools under `setting` (null `models`: every model). */
export function modelAllowed(setting, modelId) {
  if (!setting?.enabled) return false;
  return !Array.isArray(setting.models) || setting.models.includes(String(modelId ?? ""));
}

/** The message people see when computer use is off. */
export function offMessage(setting) {
  return setting?.message ?? OFF_MESSAGE;
}

// ---------------------------------------------------------------- deny list

/**
 * Apps the agent may never open, by category. `match` entries are compared,
 * case-insensitively, with the app's name, executable base name (without
 * .exe/.app) and bundle id; a trailing `*` matches a prefix.
 */
export const DENIED_APPS = Object.freeze({
  self: ["omnirush", "omnirush.ai", "omnirush.ai computer use", "omnirush computer use", "ai.omnirush.*", "com.omnirush.*", "omnirush-*"],
  terminal: [
    "terminal", "com.apple.terminal", "iterm", "iterm2", "com.googlecode.iterm2", "wezterm", "wezterm-gui", "com.github.wez.wezterm", "alacritty", "kitty", "net.kovidgoyal.kitty",
    "hyper", "co.zeit.hyper", "tabby", "org.tabby", "warp", "dev.warp.warp-stable", "ghostty", "com.mitchellh.ghostty", "rio", "foot", "footclient",
    "gnome-terminal", "gnome-terminal-server", "kgx", "gnome-console", "konsole", "xterm", "uxterm", "urxvt", "rxvt", "xfce4-terminal", "tilix", "terminator", "lxterminal", "mate-terminal", "qterminal", "sakura", "st", "terminology", "guake", "yakuake", "tilda", "cool-retro-term",
    "cmd", "powershell", "powershell_ise", "pwsh", "windowsterminal", "wt", "conhost", "openconsole", "mintty", "conemu", "conemu64", "cmder", "fluent terminal", "putty", "kitty_portable",
  ],
  password_manager: [
    "1password", "1password 7", "com.1password.1password", "com.agilebits.onepassword7", "bitwarden", "com.bitwarden.desktop", "keepass", "keepassxc", "org.keepassxc.keepassxc", "keepassx", "lastpass", "dashlane", "enpass", "keeper", "keeper password manager",
    "proton pass", "nordpass", "roboform", "passwords", "com.apple.passwords", "seahorse", "org.gnome.seahorse.application", "kwalletmanager", "kwalletmanager5", "gnome-keyring-daemon", "secrets", "org.gnome.world.secrets", "authy", "authy desktop",
  ],
  credentials: ["keychain access", "com.apple.keychainaccess", "credentialuibroker", "credential manager", "securityagent", "com.apple.securityagent", "coreautha", "com.apple.coreautha", "pinentry*", "polkit-gnome-authentication-agent-1", "polkit-kde-authentication-agent-1", "lxpolkit", "ksshaskpass", "ssh-askpass*"],
  lock_screen: ["loginwindow", "com.apple.loginwindow", "screensaverengine", "com.apple.screensaver.engine", "logonui", "lockapp", "consent", "gnome-screensaver", "xscreensaver", "light-locker", "i3lock", "swaylock", "xsecurelock", "kscreenlocker_greet", "lightdm", "gdm", "sddm"],
});

/** System settings apps: denied when the window shows a security, privacy, account or password pane. */
export const SETTINGS_APPS = Object.freeze(["system settings", "system preferences", "com.apple.systempreferences", "com.apple.settings", "systemsettings", "settings", "control", "control panel", "gnome-control-center", "systemsettings5", "systemsettings", "xfce4-settings-manager", "mmc"]);
export const SECURITY_PANE = /privacy|security|password|passkey|users?\s*(&|and)\s*groups|accounts?|sign[-\s]?in|login|log[-\s]?in|credential|firewall|defender|bitlocker|filevault|keychain|touch id|face id|biometr|lock screen|screen time|parental|family/i;

/** IDEs and editors that host agent terminals: denied when one is an ancestor of the agent. */
export const AGENT_HOSTS = Object.freeze(["code", "code - insiders", "com.microsoft.vscode", "cursor", "com.todesktop.230313mzl4w4u92", "windsurf", "zed", "dev.zed.zed", "idea", "idea64", "pycharm", "pycharm64", "webstorm", "webstorm64", "goland", "goland64", "clion", "clion64", "rider", "rider64", "phpstorm", "phpstorm64", "rubymine", "datagrip", "android studio", "studio64", "fleet", "sublime_text", "nvim-qt", "emacs", "tmux", "screen", "zellij", "sshd", "omnirush"]);

const REASONS = {
  self: "Computer use cannot operate OmniRush itself.",
  terminal: "Computer use cannot operate terminals. Use the shell tool for commands.",
  password_manager: "Computer use cannot open password managers.",
  credentials: "Computer use cannot open keychains, credential stores or sign-in prompts.",
  lock_screen: "Computer use cannot operate the login or lock screen, or security prompts.",
  settings: "Computer use cannot open security, privacy, account or password settings.",
  ancestor: "Computer use cannot operate the app the agent runs in (its terminal, IDE or OmniRush).",
  tty: "Computer use cannot operate the terminal window the agent was started from.",
  secure_input: "Another app has secure keyboard input on (a password field). Finish it, then try again.",
  server: "This app is not available for computer use.",
};

function baseName(value) {
  if (typeof value !== "string" || !value) return "";
  const name = value.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
  return name.replace(/\.(exe|app|appimage|desktop)$/i, "").toLowerCase();
}

/** The lower-case names an app can be matched by: its name, executable base name, bundle id. */
export function appNames(app) {
  const out = new Set();
  if (!isRecord(app)) return out;
  for (const value of [app.name, app.app_name, app.bundle_id]) if (typeof value === "string" && value.trim()) out.add(value.trim().toLowerCase().replace(/\.(exe|app)$/i, ""));
  for (const value of [app.exe, app.executable, app.bundle_or_exe, app.app_id]) {
    const name = baseName(value);
    if (name) out.add(name);
    // "/Applications/Foo.app/Contents/MacOS/Foo": the bundle's name too.
    const bundle = typeof value === "string" ? /([^/\\]+)\.app(?:[/\\]|$)/i.exec(value) : null;
    if (bundle) out.add(bundle[1].toLowerCase());
  }
  return out;
}

function matches(names, pattern) {
  const p = pattern.toLowerCase();
  if (p.endsWith("*")) {
    const prefix = p.slice(0, -1);
    for (const name of names) if (name.startsWith(prefix)) return true;
    return false;
  }
  return names.has(p);
}

function sameProcess(app, other) {
  if (!isRecord(other)) return false;
  if (Number.isSafeInteger(other.pid) && other.pid > 0 && other.pid === app.pid) return true;
  const a = typeof (app.exe ?? app.executable) === "string" ? String(app.exe ?? app.executable) : "";
  const b = typeof other.exe === "string" ? other.exe : "";
  return Boolean(a && b && a === b);
}

/**
 * Why the agent may not open `app` ({ pid, name, exe, bundle_id, title }), or
 * null when it may. `ctx`: ancestors (the agent's ancestor processes,
 * [{ pid, name, exe }]), tty_pids (processes owning the agent's terminal
 * window), self_pids, deny_apps (the server's list), secure_input (macOS).
 * Returns { code: "protected_app", category, reason }.
 */
export function deniedApp(app, ctx = {}) {
  if (!isRecord(app)) return { code: "protected_app", category: "server", reason: REASONS.server };
  const deny = (category, reason = REASONS[category]) => ({ code: "protected_app", category, reason });
  if (ctx.secure_input === true) return deny("secure_input");
  if ((ctx.self_pids ?? []).includes(app.pid)) return deny("self");
  for (const ancestor of ctx.ancestors ?? []) if (sameProcess(app, ancestor)) return deny("ancestor");
  if ((ctx.tty_pids ?? []).includes(app.pid)) return deny("tty");
  const names = appNames(app);
  for (const [category, list] of Object.entries(DENIED_APPS)) if (list.some((pattern) => matches(names, pattern))) return deny(category);
  if (SETTINGS_APPS.some((pattern) => matches(names, pattern)) && SECURITY_PANE.test(String(app.title ?? ""))) return deny("settings");
  for (const entry of ctx.deny_apps ?? []) {
    const match = typeof entry === "string" ? entry : entry?.match;
    if (typeof match === "string" && match && matches(names, match)) return deny("server", (typeof entry === "object" && entry?.reason) || REASONS.server);
  }
  return null;
}

/**
 * The agent's ancestor processes, nearest first ([{ pid, name, exe }]), read
 * from /proc (Linux) or `ps` (macOS). Windows hosts read them natively and
 * pass them in; here the list is empty there.
 */
export function readAncestors({ pid = process.pid, platform = process.platform, limit = 64 } = {}) {
  const out = [];
  try {
    if (platform === "linux") {
      let current = pid;
      for (let i = 0; i < limit && current > 1; i += 1) {
        const stat = readFileSync(`/proc/${current}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        const name = stat.slice(stat.indexOf("(") + 1, close);
        const ppid = Number(stat.slice(close + 2).split(" ")[1]);
        let exe = "";
        try { exe = readlinkSync(`/proc/${current}/exe`); } catch { /* another user's process */ }
        if (current !== pid) out.push({ pid: current, name, exe });
        if (!Number.isSafeInteger(ppid) || ppid <= 0 || ppid === current) break;
        current = ppid;
      }
    } else if (platform === "darwin") {
      const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024 }).split("\n");
      const table = new Map();
      for (const row of rows) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row);
        if (m) table.set(Number(m[1]), { ppid: Number(m[2]), exe: m[3].trim() });
      }
      let current = table.get(pid)?.ppid;
      for (let i = 0; i < limit && current && current > 1; i += 1) {
        const row = table.get(current);
        if (!row) break;
        out.push({ pid: current, name: path.posix.basename(row.exe), exe: row.exe });
        current = row.ppid;
      }
    }
  } catch {
    /* best effort: the deny list and the host's own checks still apply */
  }
  return out;
}

/**
 * True when this process was started from inside an agent (a nested run):
 * OMNIRUSH_AGENT_DEPTH is set, or an ancestor is an omnirush/engine process.
 * Nested runs never get the real screen, only the virtual display.
 */
export function nestedAgent({ env = process.env, ancestors = [] } = {}) {
  const depth = Number(env?.OMNIRUSH_AGENT_DEPTH ?? 0);
  if (Number.isFinite(depth) && depth > 0) return true;
  return ancestors.some((a) => /^(omnirush|opencode|omnirush-engine)(\.exe)?$/i.test(String(a?.name ?? "")) || /[/\\](omnirush|opencode)(-engine)?(\.exe)?$/i.test(String(a?.exe ?? "")));
}

// ------------------------------------------------------- per-action approvals

/** Words in an intent or the text at the target that make an act ask (Normal). */
export const RISKY_WORDS = Object.freeze([
  "send", "pay", "payment", "buy", "purchase", "checkout", "check out", "order", "place order", "delete", "remove", "erase", "wipe", "trash",
  "post", "publish", "share", "sign in", "sign-in", "signin", "log in", "log-in", "login", "install", "uninstall", "transfer", "wire", "donate",
  "subscribe", "unsubscribe", "deploy", "merge", "submit password", "reset password", "change password",
]);
const RISKY_RE = new RegExp(`(^|[^\\p{L}\\p{N}])(${[...RISKY_WORDS].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu");
const SETTINGS_RE = /\b(change|edit|modify|update|grant|revoke|allow|deny|toggle|turn\s+(on|off)|enable|disable|reset)\b[^.]{0,60}\b(settings?|permissions?|privacy|access|preferences?|security)\b/i;
const BENIGN = /\b(in\s+order\s+(to|for)|sort\s+order|order\s+by|reorder|ordered\s+list)\b/gi;

/** The risky words found in `value` (intent or on-screen text), lower case. */
export function riskyWords(value) {
  if (typeof value !== "string" || !value) return [];
  const textValue = value.replace(BENIGN, " ");
  const found = new Set();
  const re = new RegExp(RISKY_RE.source, "giu");
  let m;
  while ((m = re.exec(textValue)) !== null) found.add(m[2].toLowerCase().replace(/\s+/g, " "));
  if (SETTINGS_RE.test(textValue)) found.add("change settings");
  return [...found];
}

const CREDENTIAL_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i,
];

function entropy(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / value.length; h -= p * Math.log2(p); }
  return h;
}

/**
 * True when typed text looks like a credential: a known key/token format, a
 * `password=` style assignment, or one long random-looking word.
 */
export function looksLikeCredential(value) {
  if (typeof value !== "string" || value.length < 8) return false;
  if (CREDENTIAL_PATTERNS.some((re) => re.test(value))) return true;
  const word = value.trim();
  if (/\s/.test(word) || word.length < 20 || word.length > 512) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(word)).length;
  return classes >= 3 && entropy(word) >= 3.8 && !/^https?:\/\//i.test(word) && !/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(word);
}

/** Why a key chord asks (Normal): "paste", "close_quit_delete", or null. */
export function riskyChord(action) {
  if (!isRecord(action)) return null;
  const mods = new Set(Array.isArray(action.modifiers) ? action.modifiers : []);
  const key = String(action.key ?? "").toLowerCase();
  const cmd = mods.has("ctrl") || mods.has("meta");
  if (action.type === "key") {
    if ((cmd && key === "v") || (mods.has("shift") && key === "insert")) return "paste";
    if (cmd && (key === "q" || key === "w" || key === "f4")) return "close_quit_delete";
    if (mods.has("alt") && key === "f4") return "close_quit_delete";
    if (mods.has("shift") && key === "delete") return "close_quit_delete";
    if (mods.has("meta") && (key === "backspace" || key === "delete")) return "close_quit_delete";
    if (cmd && mods.has("shift") && key === "delete") return "close_quit_delete";
  }
  return null;
}

/** A window title without unsaved-change markers and the app name suffix, for "same document" checks. */
export function documentOf(title, appName) {
  let t = String(title ?? "").trim().replace(/^[*•●◦]\s*/, "").replace(/\s*[*•●◦]$/, "").replace(/\s+\(modified\)$/i, "");
  const app = String(appName ?? "").trim();
  if (app) for (const sep of [" - ", " — ", " – ", " | "]) if (t.toLowerCase().endsWith((sep + app).toLowerCase())) t = t.slice(0, -(sep + app).length);
  return t.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Whether one computer_act asks the person first, by permission mode:
 * - careful: every act asks;
 * - normal: risky intents or targets, typing into a secure field or text that
 *   looks like a credential, paste and close/quit/delete chords, acting in
 *   another window or app, the window's document/site changed from the
 *   approved one, and the first act after the person took over;
 * - auto: never (open-session consent, the deny list, hit-testing, the
 *   indicator and Stop still apply).
 * `input`: { mode, action, intent, target: { text, secure, url_host },
 * window: { id, app_id, title, app_name, url_host }, approved: { window_id,
 * app_id, title, url_host }, after_takeover, typed_before } (target.text
 * undefined: the host reads no text there; typed_before: the last act in this
 * window was `type`).
 * Returns { ask, reasons: [{ code, detail? }] }.
 */
export function actApproval(input = {}) {
  const mode = PERMISSION_MODES.includes(input.mode) ? input.mode : "normal";
  if (mode === "auto") return { ask: false, reasons: [] };
  if (mode === "careful") return { ask: true, reasons: [{ code: "careful" }] };
  const reasons = [];
  const action = isRecord(input.action) ? input.action : {};
  const target = isRecord(input.target) ? input.target : {};
  const intentWords = riskyWords(input.intent);
  if (intentWords.length) reasons.push({ code: "risky_intent", detail: intentWords.join(", ") });
  if (["click", "double_click", "right_click", "drag"].includes(action.type) || (action.type === "key" && String(action.key).toLowerCase() === "enter")) {
    const targetWords = riskyWords(target.text);
    if (targetWords.length) reasons.push({ code: "risky_target", detail: targetWords.join(", ") });
  }
  // No text the host could read at the target: a click or Enter right after typing in this window
  // may submit what was typed (a login, a message, a payment), so it asks.
  if (typeof target.text !== "string" && input.typed_before === true && (["click", "double_click"].includes(action.type) || (action.type === "key" && String(action.key).toLowerCase() === "enter"))) reasons.push({ code: "submit_after_typing" });
  if (action.type === "type") {
    if (target.secure === true) reasons.push({ code: "secure_field" });
    if (looksLikeCredential(action.text)) reasons.push({ code: "credential_text" });
  }
  const chord = riskyChord(action);
  if (chord) reasons.push({ code: chord });
  const window = isRecord(input.window) ? input.window : null;
  const approved = isRecord(input.approved) ? input.approved : null;
  if (window && approved) {
    if ((approved.app_id && window.app_id && approved.app_id !== window.app_id) || (approved.window_id !== undefined && window.id !== undefined && String(approved.window_id) !== String(window.id))) reasons.push({ code: "other_window" });
    else if ((approved.url_host && window.url_host && approved.url_host !== window.url_host) || (approved.title !== undefined && documentOf(approved.title, window.app_name) !== documentOf(window.title, window.app_name))) reasons.push({ code: "document_changed", detail: String(window.url_host ?? window.title ?? "").slice(0, 120) });
  }
  if (input.after_takeover === true) reasons.push({ code: "after_takeover" });
  return { ask: reasons.length > 0, reasons };
}

/** People-facing text for an approval reason code. */
export const ASK_REASONS = Object.freeze({
  careful: "Careful mode asks before every action.",
  risky_intent: "The agent says it will do something that is hard to undo",
  risky_target: "The target looks like a button that sends, pays, deletes or signs in",
  secure_field: "It would type into a password field.",
  credential_text: "The text looks like a password or key.",
  paste: "It would paste from the clipboard.",
  close_quit_delete: "The shortcut closes, quits or deletes.",
  other_window: "It would act in another window.",
  document_changed: "The window now shows a different page or document",
  after_takeover: "First action after you took over.",
  submit_after_typing: "It would click or press Enter right after typing, which may send what was typed.",
});

/**
 * Shell commands that capture the screen or inject input: they ask in Normal
 * (engine bash permission patterns, appended after the mode's own rules).
 */
export const SCREEN_BASH_RULES = Object.freeze({
  "*screencapture*": "ask",
  "*xdotool*": "ask",
  "*ydotool*": "ask",
  "*xwd *": "ask",
  "*import -window*": "ask",
  "*scrot*": "ask",
  "*gnome-screenshot*": "ask",
  "*spectacle*": "ask",
  "*grim *": "ask",
  "*xte *": "ask",
  "*nircmd*": "ask",
  "*osascript*System Events*": "ask",
  "*SendKeys*": "ask",
  "*SendInput*": "ask",
  "*CopyFromScreen*": "ask",
  "*keybd_event*": "ask",
  "*mouse_event*": "ask",
});

/** Engine permission rules for the tools of the built-in server: the host asks, so the engine never does. */
export function computerPermissionRules() {
  return { [`${SERVER_ID}_*`]: "allow" };
}

/** Engine permission rules for sub-agents: no computer use in v1 (one lease per app process). */
export function subagentPermissionRules() {
  return { [`${SERVER_ID}_*`]: "deny" };
}
