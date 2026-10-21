// Which build of the desktop app this is, fixed when it was packaged; nothing
// at runtime (environment, settings) changes it.
//
// A packaged app reads server/omnirush-build.json inside its app.asar (with
// the server it stamps), written by scripts/electron-build.mjs:
// { variant: "release" | "dev", engineSha256 }.
// The file missing or unreadable in a packaged app is a release build with no
// engine it may run. An app run from the source tree (electron-dev) is dev.
//
// A release build (the same rules as apps/server/src/release-guard.ts):
//   - talks to https://omnirush.ai or https://<name>.omnirush.ai only, from
//     every source of an address; another address is an error, not a fallback;
//   - runs only the engine binary it bundles, checked by its sha256.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const DESKTOP_BUILD_FILE = "omnirush-build.json";
export const RELEASE_GATEWAY_ERROR = "This build of OmniRush.ai only connects to omnirush.ai.";
export const RELEASE_ENGINE_ERROR = "This build of OmniRush.ai only runs the engine it ships with.";

/** @typedef {{ variant: "dev" | "release", engineSha256: string | null, packaged: boolean }} DesktopBuild */

/** @returns {DesktopBuild} */
export function readDesktopBuild({
  resourcesPath = process.resourcesPath,
  exists = existsSync,
  read = (file) => readFileSync(file, "utf8"),
} = {}) {
  const packaged = Boolean(resourcesPath) && exists(path.join(resourcesPath, "app.asar"));
  if (!packaged) return { variant: "dev", engineSha256: null, packaged: false };
  try {
    const value = JSON.parse(read(path.join(resourcesPath, "app.asar", "server", DESKTOP_BUILD_FILE)));
    // One hash per bundled architecture, comma-separated (scripts/stamp-build-variant.mjs).
    const engineSha256 = typeof value?.engineSha256 === "string" && /^[0-9a-f]{64}(?:,[0-9a-f]{64})*$/.test(value.engineSha256) ? value.engineSha256 : null;
    return { variant: value?.variant === "dev" ? "dev" : "release", engineSha256, packaged: true };
  } catch {
    return { variant: "release", engineSha256: null, packaged: true };
  }
}

export const desktopBuild = readDesktopBuild();

export function isReleaseBuild(build = desktopBuild) {
  return build.variant === "release";
}

/** Whether a release build may use `raw` as its account server or gateway (any address in the dev variant). */
export function gatewayUrlAllowedForBuild(raw, build = desktopBuild) {
  if (!isReleaseBuild(build)) return true;
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && url.port === ""
      && (host === "omnirush.ai" || host.endsWith(".omnirush.ai"));
  } catch {
    return false;
  }
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The Apple Developer ID team that signs the app and its bundled engine. */
export const ENGINE_SIGNING_TEAM = "2KFG4BXC8K";
/** codesign requirement: a Developer ID certificate (Apple anchor) of that team. */
export const ENGINE_SIGNING_REQUIREMENT = `anchor apple generic and certificate leaf[subject.OU] = "${ENGINE_SIGNING_TEAM}"`;

/**
 * macOS: whether `file` carries a valid signature by this app's team. Signing and
 * notarization rewrite the engine binary after packaging records its sha256, so on
 * macOS the signature, not the raw hash, says it is the bundled engine.
 */
const signedCache = new Map();
export function engineSignedByTeam(file, { platform = process.platform, run = spawnSync, stat = statSync } = {}) {
  if (platform !== "darwin") return false;
  let key = null;
  try { const info = stat(file); key = `${file}\0${info.size}\0${info.mtimeMs}`; } catch { return false; }
  if (signedCache.has(key)) return signedCache.get(key);
  let ok = false;
  try {
    const result = run("/usr/bin/codesign", ["--verify", "--strict", `-R=${ENGINE_SIGNING_REQUIREMENT}`, file], { stdio: "ignore", timeout: 20_000 });
    ok = result?.status === 0;
  } catch {
    ok = false;
  }
  // Only a pass is kept (same path, size and modification time); a failure is asked again next time.
  if (ok) signedCache.set(key, true);
  return ok;
}

/**
 * The engine binary a release build runs: the bundled one in <resources>/sidecars,
 * when its sha256 is the one recorded at packaging. Throws otherwise.
 * @param {{ fileNames: string[], build?: DesktopBuild, resourcesPath?: string, exists?: (file: string) => boolean, hash?: (file: string) => string }} input
 * @returns {{ path: string, source: "bundled" }}
 */
export function releaseEngineBinary({ build = desktopBuild, resourcesPath = process.resourcesPath, fileNames, exists = existsSync, hash = sha256File, signedByTeam = engineSignedByTeam }) {
  const directory = resourcesPath ? path.join(resourcesPath, "sidecars") : null;
  const candidate = directory ? fileNames.map((name) => path.join(directory, name)).find((file) => exists(file)) : null;
  if (!candidate || !build.engineSha256) throw new Error(`${RELEASE_ENGINE_ERROR} No bundled engine was found. Reinstall OmniRush.ai.`);
  // The recorded sha256 (Linux, Windows), or on macOS this team's valid signature (signing changes the bytes).
  if (!build.engineSha256.split(",").includes(hash(candidate)) && !signedByTeam(candidate)) throw new Error(`${RELEASE_ENGINE_ERROR} The bundled engine was changed. Reinstall OmniRush.ai.`);
  return { path: candidate, source: "bundled" };
}
