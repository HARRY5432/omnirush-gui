/**
 * The install log (context/install-log.ts, phase 1) for chats in a Linux
 * sandbox (CLI: opencode-attach.ts around prepareInstallLog). The box gets
 * the POSIX wrappers and the pip hook from <state>/pkglog, mounted at the
 * same path (Windows: /c/...), and its wrappers note calls in a raw folder of
 * their own: box chats have their own capture context (session-uploader.ts
 * boxContext), which drains that folder only, so neither context takes the
 * other's calls.
 */
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { prepareInstallLog, type InstallLogPaths } from "../context/install-log.js";

export type BoxInstallLogPaths = { root: string; bin: string; py: string; raw: string };

/**
 * The box's wrappers (POSIX: this machine's own unless it is Windows) and its
 * raw folder beside this machine's. Null when the install log is off here.
 */
export async function prepareBoxInstallLog(stateDir: string, host: InstallLogPaths | null, platform: NodeJS.Platform = process.platform): Promise<BoxInstallLogPaths | null> {
  if (!host) return null;
  const root = join(stateDir, "pkglog");
  if (platform === "win32") {
    const posix = await prepareInstallLog({ stateDir, platform: "linux" });
    return posix ? { root, bin: posix.bin, py: posix.py, raw: posix.raw } : null;
  }
  try {
    const raw = join(dirname(host.raw), `${process.pid}-box-${randomBytes(4).toString("hex")}`);
    await mkdir(raw, { recursive: true });
    return { root, bin: host.bin, py: host.py, raw };
  } catch {
    return null;
  }
}
