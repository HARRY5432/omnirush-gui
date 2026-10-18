// Decides how a local path from the renderer or a transcript link may be
// opened with the OS. Opening runs whatever the file's type is associated
// with, so network paths (an SMB request leaks the Windows NTLM hash) are never
// touched and programs or scripts are only revealed in their folder.

import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Types the OS runs, installs, or hands to a script host when "opened".
const COMMON_EXECUTABLE_EXTENSIONS = [".jar", ".jnlp"];
const WINDOWS_EXECUTABLE_EXTENSIONS = [
  ".ade", ".adp", ".app", ".appinstaller", ".application", ".appref-ms", ".appx", ".appxbundle", ".bas", ".bat",
  ".chm", ".cmd", ".com", ".cpl", ".crt", ".der", ".diagcab", ".exe", ".gadget", ".hlp", ".hta", ".htc", ".inf",
  ".ins", ".isp", ".js", ".jse", ".lnk", ".mde", ".msc", ".msh", ".msh1", ".msh2", ".mshxml", ".msi", ".msix",
  ".msixbundle", ".msp", ".mst", ".msu", ".ocx", ".pif", ".pl", ".ps1", ".ps1xml", ".ps2", ".ps2xml", ".psc1",
  ".psc2", ".psd1", ".psm1", ".py", ".pyc", ".pyo", ".pyw", ".pyz", ".pyzw", ".rb", ".reg", ".scf", ".scr",
  ".sct", ".search-ms", ".searchconnector-ms", ".settingcontent-ms", ".shb", ".shs", ".sys", ".dll", ".theme",
  ".url", ".vb", ".vbe", ".vbs", ".vhd", ".vhdx", ".website", ".ws", ".wsc", ".wsf", ".wsh", ".xbap", ".xll",
  ".library-ms", ".iso", ".img",
];
const DARWIN_EXECUTABLE_EXTENSIONS = [
  ".action", ".app", ".command", ".fileloc", ".inetloc", ".mpkg", ".pkg", ".prefpane", ".terminal", ".tool",
  ".webloc", ".workflow",
];
const LINUX_EXECUTABLE_EXTENSIONS = [".appimage", ".desktop", ".run"];

/** @param {NodeJS.Platform} platform */
function executableExtensions(platform) {
  if (platform === "win32") return new Set([...COMMON_EXECUTABLE_EXTENSIONS, ...WINDOWS_EXECUTABLE_EXTENSIONS]);
  if (platform === "darwin") return new Set([...COMMON_EXECUTABLE_EXTENSIONS, ...DARWIN_EXECUTABLE_EXTENSIONS]);
  return new Set([...COMMON_EXECUTABLE_EXTENSIONS, ...LINUX_EXECUTABLE_EXTENSIONS]);
}

/**
 * `\\host\share`, `//host/share`, and the `\\?\` / `\\.\` device forms.
 * @param {string} target
 */
export function isNetworkPath(target) {
  return /^[\\/]{2}/.test(String(target ?? "").trim());
}

/**
 * @param {string} target
 * @param {{ platform?: NodeJS.Platform, stat?: (target: string) => { isFile(): boolean, mode: number } }} [options]
 */
export function isExecutablePath(target, { platform = process.platform, stat = statSync } = {}) {
  // Trailing dots and spaces are dropped by Windows (`x.exe.` runs x.exe).
  const name = platform === "win32" ? target.replace(/[. ]+$/, "") : target;
  if (executableExtensions(platform).has(path.extname(name).toLowerCase())) return true;
  if (platform === "win32") return false;
  try {
    const stats = stat(target);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * @param {string} target
 * @param {string[]} roots
 * @param {NodeJS.Platform} platform
 */
function isInsideAny(target, roots, platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const fold = (value) => (platform === "win32" || platform === "darwin" ? value.toLowerCase() : value);
  const resolved = fold(pathApi.resolve(target));
  return roots.some((root) => {
    const base = String(root ?? "").trim();
    if (!base || isNetworkPath(base)) return false;
    const relative = pathApi.relative(fold(pathApi.resolve(base)), resolved);
    return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
  });
}

/**
 * How to honor an "open this path" request.
 * - "deny": never touch it (network or relative paths).
 * - "reveal": show it in its folder instead of running it.
 * - "open": hand it to the OS default application.
 *
 * @param {string} target
 * @param {{
 *   platform?: NodeJS.Platform,
 *   stat?: (target: string) => { isFile(): boolean, mode: number },
 *   workspaceRoots?: string[] | null,
 * }} [options] workspaceRoots limits "open" to files inside those folders.
 * @returns {"deny" | "reveal" | "open"}
 */
export function classifyLocalOpen(target, options = {}) {
  const platform = options.platform ?? process.platform;
  const value = String(target ?? "").trim();
  if (!value || isNetworkPath(value)) return "deny";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(value)) return "deny";
  // Past the drive letter a colon names an NTFS stream (`x.txt:y.exe`, `x.exe::$DATA`).
  if (platform === "win32" && value.slice(2).includes(":")) return "deny";
  if (isExecutablePath(value, { platform, stat: options.stat })) return "reveal";
  if (options.workspaceRoots && !isInsideAny(value, options.workspaceRoots, platform)) return "reveal";
  return "open";
}

/**
 * Local path for a `file:` URL, or null for a URL that names a remote host
 * (`file://host/share` is UNC on Windows) or that does not parse.
 *
 * @param {string} url
 * @param {NodeJS.Platform} [platform]
 */
export function localPathFromFileUrl(url, platform = process.platform) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "file:") return null;
  if (parsed.hostname && parsed.hostname.toLowerCase() !== "localhost") return null;
  let local;
  try {
    local = fileURLToPath(parsed, { windows: platform === "win32" });
  } catch {
    return null;
  }
  return isNetworkPath(local) ? null : local;
}
