/**
 * One small, impersonal report when the desktop cannot start
 * (POST /omnirush/diagnostics/crashes, `product: "gui"`, `kind:
 * "start_failure"`), plus the hint the start screen shows for it.
 *
 * A report carries enums, numbers and booleans: the failure's category,
 * phase, error name/code, exit code or signal, versions, OS build, the time
 * to failure, checks of the engine binary (present, size, header, sha256
 * against the bundled versions.json, readable) and of the profile folder
 * (non-ASCII, spaces, UNC, long: booleans only), whether the CPU has AVX2,
 * and an antivirus hint. Never a path, user name, file contents or prompt;
 * the one free-text field is the error's first line with every path,
 * address and long token replaced, and the server drops it if anything
 * personal is left.
 *
 * Sent with the device credential when signed in; otherwise (or offline)
 * queued and sent on a later start. At most MAX_REPORTS_PER_DAY a day.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const START_REPORT_FILE = "start-reports.json";
export const MAX_REPORTS_PER_DAY = 3;
const MAX_QUEUE = 5;
// The server takes reports up to 7 days old.
const MAX_QUEUE_AGE_MS = 6 * 24 * 60 * 60 * 1000;
const MESSAGE_LIMIT = 300;

export const START_FAILURE_CATEGORIES = [
  "unknown", "engine_missing", "engine_blocked", "engine_modified", "engine_timeout",
  "engine_exit", "engine_crash", "engine_cpu_unsupported", "engine_stuck",
  "config_incompatible", "config_invalid", "workspace_inaccessible", "port_in_use",
  "store_error", "disk_full", "server_bundle_missing", "server_not_ready", "renderer",
];

const ERROR_NAMES = new Set([
  "Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError",
  "URIError", "EvalError", "AggregateError", "SystemError",
]);
const ERROR_CODES = new Set([
  "ENOMEM", "ENOSPC", "EMFILE", "ENFILE", "EACCES", "EPERM", "ENOENT",
  "EIO", "ECONNRESET", "ETIMEDOUT", "EBUSY", "EADDRINUSE", "ECONNREFUSED",
  "ENOTDIR", "EISDIR", "ENAMETOOLONG", "EROFS", "EXDEV", "UNKNOWN",
  "ERR_MODULE_NOT_FOUND", "workspace_inaccessible", "SQLITE_CORRUPT",
  "SQLITE_NOTADB", "SQLITE_BUSY", "SQLITE_CANTOPEN", "SQLITE_FULL",
  "SQLITE_IOERR", "SQLITE_READONLY",
]);

// Windows NTSTATUS exit codes of a process the OS stopped.
const STATUS_ACCESS_DENIED = 0xc0000022;
const STATUS_ILLEGAL_INSTRUCTION = 0xc000001d;
// Win32 ERROR_VIRUS_INFECTED / ERROR_VIRUS_DELETED.
const VIRUS_CODES = new Set([225, 226]);

const SQLITE_PATTERN = /\b(SQLITE_[A-Z]+)\b|database disk image is malformed|file is not a database|database is locked/;

function innermost(error) {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current && typeof current === "object" && Array.isArray(current.errors) && current.errors.length > 0) {
      current = current.errors[0];
      continue;
    }
    break;
  }
  return current;
}

function messageOf(error) {
  if (error instanceof Error) return String(error.message ?? "");
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof error.message === "string") return error.message;
  return "";
}

function exitCodeOf(error, message) {
  if (Number.isInteger(error?.exitCode)) return error.exitCode;
  const match = message.match(/exited with code (-?\d{1,10})\b/);
  return match ? Number(match[1]) : null;
}

function unsigned(code) {
  return Number.isInteger(code) && code < 0 ? code >>> 0 : code;
}

function knownCode(value) {
  return typeof value === "string" && ERROR_CODES.has(value) ? value : null;
}

/**
 * The failure's category, phase, error name/code, exit code, signal and
 * antivirus hint, from the error the start threw (in-process, so spawn
 * errors keep `code`/`syscall` and engine exits keep `exitCode`).
 */
export function classifyStartFailure(rawError, { fallbackPhase = "unknown" } = {}) {
  const error = innermost(rawError);
  const message = messageOf(error);
  const name = error instanceof Error ? error.name : null;
  const code = typeof error?.code === "string" ? error.code : null;
  const syscall = typeof error?.syscall === "string" ? error.syscall : "";
  const exitCode = exitCodeOf(error, message);
  const status = unsigned(exitCode);
  const signal = typeof error?.signal === "string" && /^SIG[A-Z0-9]{2,10}$/.test(error.signal) ? error.signal : null;
  const sqlite = message.match(SQLITE_PATTERN);
  const result = {
    category: "unknown",
    phase: fallbackPhase,
    errorName: name && ERROR_NAMES.has(name) ? name : (rawError instanceof Error ? "Error" : "none"),
    errorCode: knownCode(code),
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    signal,
    avHint: "none",
  };
  const set = (category, phase, extra = {}) => Object.assign(result, { category, phase }, extra);

  if (code === "workspace_inaccessible") {
    return set("workspace_inaccessible", "workspace", {
      errorCode: knownCode(error?.cause?.code) ?? "workspace_inaccessible",
    });
  }
  if (name === "OpencodeConfigCompatError" || /uses V2 permissions|refuses user-owned config/i.test(message)) {
    return set("config_incompatible", "server");
  }
  if (syscall.startsWith("spawn") || /^spawn\b/.test(message)) {
    if (code === "ENOENT") return set("engine_missing", "engine_spawn", { avHint: "binary_missing" });
    if (/virus/i.test(message)) return set("engine_blocked", "engine_spawn", { avHint: "virus_detected" });
    if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
      return set("engine_blocked", "engine_spawn", { avHint: "spawn_blocked" });
    }
  }
  if (code === "ENOSPC" || /\bENOSPC\b|no space left|SQLITE_FULL|database or disk is full/i.test(message)) {
    return set("disk_full", fallbackPhase === "unknown" ? "server" : fallbackPhase, { errorCode: knownCode(code) ?? "ENOSPC" });
  }
  if (/Timeout waiting for OmniRush server/.test(message)) return set("engine_timeout", "engine_ready");
  if (/exited with code/.test(message) || result.exitCode !== null) {
    if (/CPU lacks AVX|Illegal instruction/i.test(message) || status === STATUS_ILLEGAL_INSTRUCTION) {
      return set("engine_cpu_unsupported", "engine_ready");
    }
    if (VIRUS_CODES.has(status)) return set("engine_blocked", "engine_ready", { avHint: "virus_detected" });
    if (status === STATUS_ACCESS_DENIED) return set("engine_blocked", "engine_ready", { avHint: "exec_status_blocked" });
    if (/\bEADDRINUSE\b/.test(message)) return set("port_in_use", "engine_ready", { errorCode: "EADDRINUSE" });
    if (/ConfigJsonError|ConfigInvalidError|configuration is invalid|JSON Parse error/i.test(message)) {
      return set("config_invalid", "engine_ready");
    }
    if (sqlite) return set("store_error", "engine_ready", { errorCode: knownCode(sqlite[1]) ?? result.errorCode });
    if ((status !== null && status >= 0xc0000000) || signal) return set("engine_crash", "engine_ready");
    return set("engine_exit", "engine_ready");
  }
  if (/did not exit after SIGKILL/.test(message)) return set("engine_stuck", "engine_ready");
  if (code === "EADDRINUSE" || /\bEADDRINUSE\b/.test(message)) return set("port_in_use", "server", { errorCode: "EADDRINUSE" });
  if (/Cannot find OmniRush\.ai embedded server bundle/.test(message)) return set("server_bundle_missing", "server");
  if (/did not stay running|did not report a base URL|did not report an access token|did not finish starting/i.test(message)) {
    return set("server_not_ready", "server_ready");
  }
  if (sqlite) return set("store_error", "server", { errorCode: knownCode(sqlite[1]) ?? result.errorCode });
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The error's first line (and, for an engine exit, its first diagnostic
 * line) with every path, address, URL, long token and the user's name
 * replaced. Null when nothing useful is left.
 */
export function scrubStartMessage(rawError, { roots = [], userName = "" } = {}) {
  const message = messageOf(innermost(rawError));
  if (!message.trim()) return null;
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const picked = [lines[0]];
  const diagnostic = lines.slice(1).find((line) => /error|lacks|illegal|EADDRINUSE|SQLITE|config|denied|permission/i.test(line));
  if (diagnostic) picked.push(diagnostic);
  let text = picked.join(" | ");
  const knownRoots = [...new Set(roots.filter((root) => typeof root === "string" && root.trim().length >= 3))]
    .sort((left, right) => right.length - left.length);
  for (const root of knownRoots) {
    for (const variant of new Set([root, root.replace(/\\/g, "/"), root.replace(/\//g, "\\")])) {
      text = text.replace(new RegExp(escapeRegExp(variant), "gi"), "<path>");
    }
  }
  text = text
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\\\\[^\s"'<>|]+/g, "<path>")
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|]*/g, "<path>")
    .replace(/~[\\/][^\s"'<>|]*/g, "<path>")
    .replace(/(^|[\s(="'])\/[^\s"'<>|]+/g, "$1<path>")
    .replace(/[A-Za-z0-9+/_-]{32,}/g, "<id>")
    .replace(/@/g, " at ");
  const name = String(userName ?? "").trim();
  if (name.length >= 3) text = text.replace(new RegExp(escapeRegExp(name), "gi"), "<user>");
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text;
}

/** Booleans about the profile folder: never the folder itself. */
export function profileFlags(home) {
  const value = String(home ?? "");
  return {
    non_ascii: /[^\x00-\x7f]/.test(value),
    has_space: /\s/.test(value),
    unc: /^(?:\\\\|\/\/)/.test(value),
    long: value.length > 80,
  };
}

/** The OS build: `10.0.26100` on Windows, the kernel's numeric prefix elsewhere. */
export function osBuild(release = os.release()) {
  const match = String(release ?? "").match(/^\d{1,5}(?:\.\d{1,6}){0,3}/);
  return match ? match[0] : "unknown";
}

function platformOf(value = process.platform) {
  return ["linux", "darwin", "win32", "freebsd"].includes(value) ? value : "other";
}

function archOf(value = process.arch) {
  return ["x64", "arm64", "ia32", "arm", "riscv64"].includes(value) ? value : "other";
}

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][A-Za-z0-9.-]{1,50})?$/;
export function reportVersion(value) {
  const text = String(value ?? "").trim().replace(/^v/, "");
  return VERSION.test(text) ? text : "unknown";
}

function execText(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? null : String(stdout ?? ""));
    });
  });
}

/**
 * Whether the CPU has AVX2 (the bundled engine's x64 build needs it), or
 * null when unknown or not applicable (arm64).
 */
/**
 * @param {{
 *   platform?: string;
 *   arch?: string;
 *   release?: string;
 *   readText?: (file: string, encoding: "utf8") => Promise<string>;
 *   run?: (file: string, args: string[], timeoutMs: number) => Promise<string | null>;
 * }} [options]
 */
export async function cpuHasAvx2({ platform = process.platform, arch = process.arch, release = os.release(), readText = (file, encoding) => readFile(file, encoding), run = execText } = {}) {
  if (arch !== "x64") return null;
  try {
    if (platform === "linux") {
      const info = await readText("/proc/cpuinfo", "utf8");
      return /^flags\s*:.*\bavx2\b/m.test(info);
    }
    if (platform === "darwin") {
      const out = await run("/usr/sbin/sysctl", ["-n", "machdep.cpu.leaf7_features"], 3000);
      return out === null ? null : /\bAVX2\b/.test(out);
    }
    if (platform === "win32") {
      // PF_AVX2_INSTRUCTIONS_AVAILABLE (40) is reported from Windows 10 2004 (build 19041).
      const build = Number(osBuild(release).split(".")[2] ?? 0);
      if (!(build >= 19041)) return null;
      const script = "Add-Type -Namespace W -Name K -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool IsProcessorFeaturePresent(uint f);'; [W.K]::IsProcessorFeaturePresent(40)";
      const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], 8000);
      if (out === null) return null;
      if (/\bTrue\b/.test(out)) return true;
      if (/\bFalse\b/.test(out)) return false;
    }
  } catch {
    return null;
  }
  return null;
}

async function sha256Of(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function headerMatches(bytes, platform) {
  if (bytes.length < 4) return false;
  if (platform === "win32") return bytes[0] === 0x4d && bytes[1] === 0x5a;
  if (platform === "linux" || platform === "freebsd") return bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
  if (platform === "darwin") {
    const magic = bytes.readUInt32BE(0);
    return [0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe].includes(magic);
  }
  return true;
}

/**
 * Checks of the engine binary the start used: where it came from, whether
 * it is there, its size, header and sha256 against the bundled
 * versions.json, and whether it can be opened. Also whether the bundled
 * copy is there at all (a missing one in an installed app points at an
 * antivirus quarantine).
 */
export async function inspectEngineBinary({ resolved = null, bundledCandidates = [], versions = null, platform = process.platform, hash = sha256Of } = {}) {
  const check = { source: "missing", present: false, bundled_present: false, size: null, header_ok: null, hash_ok: null, readable: null };
  for (const candidate of bundledCandidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        check.bundled_present = true;
        break;
      }
    } catch {
      // Not this one.
    }
  }
  const binary = resolved?.path ? String(resolved.path) : "";
  if (!binary) return check;
  check.source = ["bundled", "path", "known-location", "custom"].includes(resolved.source) ? resolved.source : "unknown";
  try {
    const info = await stat(binary);
    check.present = info.isFile();
    check.size = info.isFile() ? info.size : null;
  } catch {
    return check;
  }
  if (!check.present) return check;
  let handle = null;
  try {
    handle = await open(binary, "r");
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    check.readable = true;
    check.header_ok = headerMatches(header.subarray(0, bytesRead), platform);
  } catch {
    check.readable = false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const expected = typeof versions?.opencode?.sha256 === "string" ? versions.opencode.sha256.toLowerCase() : "";
  if (check.readable && check.source === "bundled" && /^[a-f0-9]{64}$/.test(expected)) {
    try {
      check.hash_ok = (await hash(binary)) === expected;
    } catch {
      check.hash_ok = null;
    }
  }
  return check;
}

/** The antivirus hint: the error's own, else what the binary checks show. */
export function antivirusHint(classified, engine, { packaged = true } = {}) {
  if (classified.avHint !== "none") return classified.avHint;
  if (packaged && !engine.bundled_present) return "binary_missing";
  if (engine.readable === false) return "open_blocked";
  if (engine.hash_ok === false) return "binary_modified";
  return "none";
}

/** The report body (the server's GuiStartFailureRequest). */
export function buildStartFailureReport({
  classified,
  engine,
  avHint,
  cpuAvx2 = null,
  message = null,
  appVersion = "unknown",
  engineVersion = "unknown",
  electronVersion = process.versions.electron,
  platform = process.platform,
  arch = process.arch,
  release = os.release(),
  home = os.homedir(),
  elapsedMs = 0,
  attempt = 1,
  occurredAt = new Date(),
  eventId = randomBytes(32).toString("hex"),
}) {
  let category = classified.category;
  if (category === "engine_missing" && engine.present) category = "engine_blocked";
  if ((category === "unknown" || category === "engine_exit" || category === "engine_crash") && avHint === "binary_modified") {
    category = "engine_modified";
  }
  return {
    schema_version: 1,
    product: "gui",
    kind: "start_failure",
    event_id: eventId,
    occurred_at: occurredAt.toISOString(),
    app_version: reportVersion(appVersion),
    engine_version: reportVersion(engineVersion),
    runtime: "electron",
    runtime_version: reportVersion(electronVersion),
    platform: platformOf(platform),
    arch: archOf(arch),
    os_build: osBuild(release),
    phase: classified.phase,
    category: START_FAILURE_CATEGORIES.includes(category) ? category : "unknown",
    error_name: classified.errorName,
    error_code: classified.errorCode,
    exit_code: classified.exitCode,
    signal: classified.signal,
    elapsed_ms: Math.max(0, Math.min(86_400_000, Math.round(elapsedMs))),
    attempt: Math.max(1, Math.min(1000, Math.round(attempt))),
    engine: {
      source: engine.source,
      present: engine.present,
      bundled_present: engine.bundled_present,
      size: engine.size,
      header_ok: engine.header_ok,
      hash_ok: engine.hash_ok,
      readable: engine.readable,
    },
    profile: profileFlags(home),
    cpu_avx2: cpuAvx2,
    av_hint: avHint,
    message,
  };
}

/** What the start screen tells the user for a category (null: the generic text). */
export function startFailureHint(category, { platform = process.platform, avHint = "none" } = {}) {
  const windows = platform === "win32";
  if (category === "engine_missing" || avHint === "binary_missing") {
    return {
      title: "Your antivirus may have removed omnirush.ai's engine",
      body: windows
        ? "Open Windows Security > Virus & threat protection > Protection history, restore or allow the omnirush.ai item (opencode.exe), add the omnirush.ai install folder as an exclusion, then reinstall omnirush.ai and press Try again."
        : "Allow omnirush.ai's engine (opencode) in your antivirus, reinstall omnirush.ai, then press Try again.",
    };
  }
  if (category === "engine_blocked") {
    return {
      title: "omnirush.ai's engine was blocked",
      body: windows
        ? "Windows Security, Smart App Control or your antivirus stopped opencode.exe. Allow it (Protection history > Allow, or add the omnirush.ai install folder as an exclusion), then press Try again."
        : "Your antivirus or system policy stopped the engine (opencode). Allow it, then press Try again.",
    };
  }
  if (category === "engine_modified") {
    return {
      title: "omnirush.ai's engine file is damaged",
      body: "The engine no longer matches the one that was installed, which usually means an antivirus changed it. Reinstall omnirush.ai, allow it in your antivirus, then press Try again.",
    };
  }
  if (category === "engine_timeout") {
    return {
      title: "The engine took too long to start",
      body: windows
        ? "This often happens while an antivirus scans the engine. Wait a minute and press Try again. If it keeps happening, add the omnirush.ai install folder as an exclusion in Windows Security."
        : "Wait a minute and press Try again. If it keeps happening, restart your computer.",
    };
  }
  if (category === "engine_cpu_unsupported") {
    return {
      title: "This processor isn't supported by the engine yet",
      body: "omnirush.ai's engine needs a processor with AVX2. We've been sent a report. The omnirush CLI (npm i -g omnirush) works on this computer meanwhile.",
    };
  }
  if (category === "config_incompatible" || category === "config_invalid") {
    return {
      title: "A configuration file stops the engine",
      body: "Technical details below names the file. Rename or fix it, then press Try again.",
    };
  }
  if (category === "workspace_inaccessible") {
    return {
      title: "Your workspace folder can't be opened",
      body: windows
        ? "It may be on a disconnected drive, offline in OneDrive, or blocked by Controlled folder access (Windows Security > Ransomware protection: allow omnirush.ai). Reconnect it, or use Reset app data."
        : "It may be on a disconnected drive or no longer exist. Reconnect it, or use Reset app data.",
    };
  }
  if (category === "store_error") {
    return {
      title: "omnirush.ai's local data is damaged",
      body: "Use Reset app data: it moves the local data to a backup folder (nothing is deleted) and restarts omnirush.ai.",
    };
  }
  if (category === "disk_full") {
    return { title: "Your disk is full", body: "Free some space on the system drive, then press Try again." };
  }
  if (category === "port_in_use") {
    return { title: "A local port is busy", body: "Press Try again. If it keeps happening, restart your computer." };
  }
  return null;
}

function today(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Sends at most `maxPerDay` reports a day; a report that cannot be sent now
 * (signed out, offline, server error) is queued (at most MAX_QUEUE, none
 * older than six days) and sent by `flush()` on a later start.
 *
 * `send(body)` resolves to a fetch Response, or null while signed out.
 */
/**
 * @param {{
 *   filePath: string;
 *   send: (body: object) => Promise<{ ok: boolean; status: number } | null>;
 *   now?: () => number;
 *   maxPerDay?: number;
 *   log?: (message: string) => void;
 * }} options
 */
export function createStartReporter({ filePath, send, now = Date.now, maxPerDay = MAX_REPORTS_PER_DAY, log = () => {} }) {
  let chain = Promise.resolve();
  const serialize = (task) => {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  async function readState() {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      return {
        day: typeof parsed?.day === "string" ? parsed.day : "",
        count: Number.isInteger(parsed?.count) ? parsed.count : 0,
        queue: Array.isArray(parsed?.queue) ? parsed.queue.filter((item) => item && typeof item === "object") : [],
      };
    } catch {
      return { day: "", count: 0, queue: [] };
    }
  }

  async function writeState(state) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporary, filePath);
  }

  function fresh(queue, nowMs) {
    return queue
      .filter((item) => {
        const at = Date.parse(item.occurred_at);
        return Number.isFinite(at) && nowMs - at < MAX_QUEUE_AGE_MS;
      })
      .slice(-MAX_QUEUE);
  }

  /** "sent" | "retry" (keep queued) | "drop" (the server refused it). */
  async function deliver(body) {
    let response;
    try {
      response = await send(body);
    } catch (error) {
      log(`[start-report] not sent (${error instanceof Error ? error.name : "error"})`);
      return "retry";
    }
    if (!response) return "retry";
    if (response.ok) return "sent";
    if (response.status === 401 || response.status === 408 || response.status >= 500) return "retry";
    return "drop";
  }

  return {
    report: (body) => serialize(async () => {
      const nowMs = now();
      const state = await readState();
      if (state.day !== today(nowMs)) {
        state.day = today(nowMs);
        state.count = 0;
      }
      if (state.count >= maxPerDay) return "skipped";
      state.count += 1;
      state.queue = fresh(state.queue, nowMs);
      await writeState(state);
      const outcome = await deliver(body);
      if (outcome === "retry") {
        state.queue = fresh([...state.queue, body], nowMs);
        await writeState(state);
        return "queued";
      }
      return outcome === "sent" ? "sent" : "dropped";
    }),
    flush: () => serialize(async () => {
      const nowMs = now();
      const state = await readState();
      const queue = fresh(state.queue, nowMs);
      const kept = [];
      let sent = 0;
      for (let index = 0; index < queue.length; index += 1) {
        const outcome = await deliver(queue[index]);
        if (outcome === "sent") sent += 1;
        if (outcome === "retry") {
          kept.push(...queue.slice(index));
          break;
        }
      }
      if (kept.length !== state.queue.length || sent > 0) {
        state.queue = kept;
        await writeState(state);
      }
      return { sent, queued: kept.length };
    }),
  };
}
