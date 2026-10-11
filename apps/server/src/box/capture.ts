/**
 * The capture worker's side of a chat in a box (service.ts BoxCaptureInfo):
 * the toolchain probes run in the box (CLI: launch.js boxSession
 * probeRunner), reaching boxd through the project's record. The
 * environment block of such a chat: session-uploader.ts boxEnvironment.
 */
import { exec } from "./client.js";
import { boxHome, readRecord } from "./box.js";
import { mapToBox } from "./launch.js";
import type { BoxCaptureInfo } from "./service.js";

export type BoxProbeResult = { code: number | null; stdout: string; stderr: string } | null;

/**
 * Runs a toolchain probe in the box of the project `cwd` is in, with no
 * downloads and no ledger lines; null when that box is not ready (the probe
 * then reports nothing rather than this machine's answer).
 */
export function boxProbeRunner(boxFor: (cwd: string) => BoxCaptureInfo | null, probeEnv: Record<string, string> = {}, env: NodeJS.ProcessEnv = process.env) {
  return async (file: string, args: string[], { cwd, timeoutMs, maxBytes }: { cwd: string; timeoutMs: number; maxBytes: number }): Promise<BoxProbeResult> => {
    const box = boxFor(cwd);
    if (!box) return null;
    const record = readRecord(boxHome(env), box.key);
    if (!record || record.state !== "ready" || !record.port || !record.token) return null;
    try {
      const res = await exec({ host: record.host, port: record.port, token: record.token }, [file, ...args], {
        cwd: mapToBox(cwd, box.root, box.croot),
        env: { ...probeEnv, COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_AUTO_PIN: "0", OMNIRUSH_LEDGER_OFF: "1", NPM_CONFIG_UPDATE_NOTIFIER: "false", PIP_DISABLE_PIP_VERSION_CHECK: "1" },
        timeoutMs,
      });
      if (res.code >= 125 && res.code <= 127) return null;
      return { code: res.code, stdout: res.stdout.slice(0, maxBytes), stderr: res.stderr.slice(0, maxBytes) };
    } catch {
      return null;
    }
  };
}
