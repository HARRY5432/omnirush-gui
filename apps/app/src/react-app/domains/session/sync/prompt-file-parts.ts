import type { FilePartInput } from "@opencode-ai/sdk/v2/client";

const FIRST_LINE_LOCAL_PATH_RE = /(?:file:\/\/[^\s"'`<>]+|~\/[^\s"'`<>]+|[A-Za-z]:[\\/][^\s"'`<>]+|(?<![:/])\/[A-Za-z0-9._~+%/-]*[\/.][A-Za-z0-9._~+%/-]*)/g;
const TRAILING_PUNCTUATION_RE = /[),.;:]+$/;

function stripTrailingPunctuation(value: string) {
  return value.replace(TRAILING_PUNCTUATION_RE, "");
}

function hasPathBoundary(line: string, start: number) {
  if (start <= 0) return true;
  return /[\s("'[]/.test(line[start - 1] ?? "");
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeFileUri(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "file:") return "";
    const pathname = safeDecodeURIComponent(parsed.pathname);
    if (!pathname) return "";
    if (parsed.hostname && parsed.hostname.toLowerCase() !== "localhost") {
      return `//${parsed.hostname}${pathname}`;
    }
    // `file:///C:/x` has the pathname `/C:/x`; the drive path is `C:/x`.
    if (/^\/[A-Za-z]:\//.test(pathname)) return pathname.slice(1);
    return pathname;
  } catch {
    return "";
  }
}

function homeFromWorkspaceRoot(workspaceRoot: string) {
  const normalized = workspaceRoot.trim().replace(/\\/g, "/");
  const macMatch = normalized.match(/^(\/Users\/[^/]+)(?:\/|$)/);
  if (macMatch) return macMatch[1] ?? "";
  const linuxMatch = normalized.match(/^(\/home\/[^/]+)(?:\/|$)/);
  if (linuxMatch) return linuxMatch[1] ?? "";
  return "";
}

function toAbsolutePath(value: string, workspaceRoot: string) {
  if (/^file:\/\//i.test(value)) return normalizeFileUri(value);
  if (value.startsWith("~/")) {
    const home = homeFromWorkspaceRoot(workspaceRoot);
    return home ? `${home}/${value.slice(2)}` : "";
  }
  if (value.startsWith("/")) return value;
  if (/^[A-Za-z]:[\\/]/.test(value)) return value.replace(/\\/g, "/");
  return "";
}

function filenameFromPath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "file";
}

function encodeFilePath(path: string) {
  return path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

export function toFileUrl(path: string, windows = false) {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${encodeFilePath(normalized).replace(/^([A-Za-z])%3A/, "$1:")}`;
  // UNC share on Windows (`\\server\share\...`): the server is the URL host.
  // `file:////server` has an empty host, which Windows cannot turn back into a
  // path. Elsewhere a host is invalid, so `//x` keeps the empty-host form.
  const unc = windows ? normalized.match(/^\/\/([^/]+)(\/.*)$/) : null;
  if (unc) {
    const url = `file://${unc[1] ?? ""}${encodeFilePath(unc[2] ?? "")}`;
    return isUncHost(unc[1] ?? "") && parsedHost(url) === (unc[1] ?? "").toLowerCase() ? url : "";
  }
  // A share-less or malformed `//` path (`\\srv`, `\\?`) has no Windows file URL.
  if (windows && normalized.startsWith("//")) return "";
  return `file://${encodeFilePath(normalized)}`;
}

function parsedHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * A plain UNC server name. Device paths (`\\?\`, `\\.\`), `localhost` (the URL
 * parser drops it, leaving no host) and odd hosts are not.
 */
function isUncHost(host: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host) && host.toLowerCase() !== "localhost";
}

/** A Windows UNC root or path the engine can open (`\\server\share\...`). */
export function isUsableUncPath(path: string) {
  return toFileUrl(path, true) !== "";
}

function windowsPlatform() {
  return typeof navigator !== "undefined" && /^win/i.test(navigator.platform ?? "");
}

/** A workspace on Windows: a drive (`C:\\`) or UNC (`\\\\server\\share`) root. */
export function isWindowsWorkspaceRoot(workspaceRoot: string) {
  const root = workspaceRoot.trim();
  if (!root) return windowsPlatform();
  if (/^[A-Za-z]:([\\/]|$)/.test(root) || /^\\\\[^\\/]/.test(root)) return true;
  // `//x` is a valid POSIX root too; it is a UNC share only on Windows.
  return /^\/\/[^\\/]/.test(root) && windowsPlatform();
}

/**
 * The `file://` URL the engine reads for `path`, or "" when the engine on that
 * workspace's system cannot open it. On Windows the engine only accepts drive
 * and UNC paths: a POSIX-style path such as `/api/users.json` becomes
 * `file:///api/users.json`, which fails the whole message with "File URL path
 * must be an absolute path". Relative paths are never sent.
 */
export function promptFileUrl(path: string, workspaceRoot: string) {
  const normalized = path.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  const drive = /^[A-Za-z]:\//.test(normalized);
  if (isWindowsWorkspaceRoot(workspaceRoot)) {
    const unc = normalized.match(/^\/\/([^/]+)\/[^/]/);
    if (!drive && !unc) return "";
    return toFileUrl(normalized, true);
  }
  if (!drive && !normalized.startsWith("/")) return "";
  return toFileUrl(normalized);
}

export function joinWorkspaceRelativePath(workspaceRoot: string, relativePath: string) {
  const root = workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!root || !relative) return "";
  return `${root}/${relative}`;
}

// A `text/plain` `file://` part is expanded by opencode through the Read tool
// before the model sees the message. Read inlines text and attaches images and
// PDFs, but refuses every other binary with "Cannot read binary file", which
// opencode surfaces as a session error. Paths with these extensions therefore
// stay plain text in the prompt so tools can still act on the file.
const READ_BINARY_EXTENSIONS = new Set([
  // video / audio
  "mp4", "m4v", "mov", "mkv", "avi", "webm", "wmv", "flv", "mpg", "mpeg",
  "mp3", "m4a", "aac", "wav", "aif", "aiff", "flac", "ogg", "oga", "opus", "wma",
  // images Read cannot attach
  "heic", "heif", "tif", "tiff", "bmp", "ico", "psd", "ai", "raw", "sketch",
  // archives / disk images
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "iso", "pkg",
  // office / documents
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "key", "numbers", "pages",
  // compiled / executable / data
  "exe", "dll", "so", "dylib", "bin", "dat", "obj", "o", "a", "lib", "wasm", "class", "jar", "war", "pyc", "pyo",
  "sqlite", "sqlite3", "db",
  // fonts
  "ttf", "otf", "woff", "woff2",
]);

export function isReadInlineablePath(path: string) {
  const basename = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return true;
  return !READ_BINARY_EXTENSIONS.has(basename.slice(dot + 1).toLowerCase());
}

export function firstLineLocalFileParts(text: string, workspaceRoot: string): FilePartInput[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const parts: FilePartInput[] = [];
  const seen = new Set<string>();

  for (const match of firstLine.matchAll(FIRST_LINE_LOCAL_PATH_RE)) {
    if (!hasPathBoundary(firstLine, match.index ?? 0)) continue;
    const raw = stripTrailingPunctuation(match[0]);
    const absolute = toAbsolutePath(raw, workspaceRoot);
    if (!absolute || seen.has(absolute)) continue;
    seen.add(absolute);
    if (!isReadInlineablePath(absolute)) continue;
    const url = promptFileUrl(absolute, workspaceRoot);
    if (!url) continue;
    parts.push({
      type: "file",
      mime: "text/plain",
      url,
      filename: filenameFromPath(raw),
    });
  }

  return parts;
}
