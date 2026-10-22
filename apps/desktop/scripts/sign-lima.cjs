// The OmniRush VM's limactl (sidecars/lima/bin/limactl, prepare-lima.mjs) needs
// Apple's virtualization entitlement (com.apple.security.virtualization) to run a
// VM through Virtualization.framework. electron-builder signs every nested binary
// with the one inherited entitlements file, so limactl is left out of its signing
// (mac.signIgnore in electron-builder.base.yml) and signed here instead, from
// afterPack (before electron-builder signs and seals the app around it): the same
// Developer ID, the hardened runtime, a secure timestamp and
// build/entitlements.lima.plist. An unsigned build gets an ad-hoc signature with
// the entitlement (after afterSign's deep ad-hoc signature, limactl is signed again
// and the app sealed again). Nothing hashes limactl before this runs: any stamp of
// its bytes must come after signing.
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const LIMACTL = ["Contents", "Resources", "sidecars", "lima", "bin", "limactl"];
const ENTITLEMENT = "com.apple.security.virtualization";
const LIMA_ENTITLEMENTS = path.join(__dirname, "..", "build", "entitlements.lima.plist");
const APP_ENTITLEMENTS = path.join(__dirname, "..", "build", "entitlements.mac.plist");

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}

function limactlPath(appPath) {
  return path.join(appPath, ...LIMACTL);
}

/** The Developer ID identity in `security find-identity -v -p codesigning` output: its SHA-1, or null. */
function developerIdHash(output) {
  for (const line of String(output || "").split("\n")) {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"Developer ID Application: /.exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * Who signs limactl: OMNIRUSH_LIMA_CODESIGN_IDENTITY, CSC_NAME or
 * APPLE_CODESIGN_IDENTITY; else the Developer ID in MACOS_SIGNING_KEYCHAIN (the
 * release and the build-electron-desktop smoke import it there:
 * scripts/release/macos-signing-env.sh); else one electron-builder would find
 * itself (unless CSC_IDENTITY_AUTO_DISCOVERY=false); else ad hoc ("-").
 * { identity, keychain }.
 */
function limaIdentity({ env = process.env, run = defaultRun } = {}) {
  const keychain = String(env.MACOS_SIGNING_KEYCHAIN || "").trim() || null;
  const named = [env.OMNIRUSH_LIMA_CODESIGN_IDENTITY, env.CSC_NAME, env.APPLE_CODESIGN_IDENTITY].map((v) => String(v || "").trim()).find(Boolean);
  if (named) return { identity: named, keychain };
  if (keychain) {
    const hash = developerIdHash(run("security", ["find-identity", "-v", "-p", "codesigning", keychain]).stdout);
    if (hash) return { identity: hash, keychain };
  }
  if (env.CSC_IDENTITY_AUTO_DISCOVERY !== "false") {
    const hash = developerIdHash(run("security", ["find-identity", "-v", "-p", "codesigning"]).stdout);
    if (hash) return { identity: hash, keychain: null };
  }
  return { identity: "-", keychain: null };
}

/** codesign's arguments for limactl: the hardened runtime and the virtualization entitlement; a timestamp unless ad hoc. */
function limaCodesignArgs({ identity, keychain = null, file, entitlements = LIMA_ENTITLEMENTS }) {
  return ["--force", "--sign", identity, "--options", "runtime", ...(identity === "-" ? ["--timestamp=none"] : ["--timestamp"]), ...(keychain ? ["--keychain", keychain] : []), "--entitlements", entitlements, file];
}

function must(res, what) {
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${what} failed (${res.status}): ${String(res.stderr || res.stdout).trim().split("\n").pop()}`);
  return res;
}

/**
 * Sign the bundled limactl (afterPack). No limactl in this build: nothing (the app
 * downloads Lima's own signed release on first use). A notarized build
 * (MACOS_NOTARIZE=true) refuses an ad-hoc limactl.
 */
function signLimactl(appPath, { env = process.env, run = defaultRun, log = console.log } = {}) {
  const file = limactlPath(appPath);
  if (!existsSync(file)) return { signed: false, reason: "no bundled limactl" };
  const { identity, keychain } = limaIdentity({ env, run });
  if (identity === "-" && env.MACOS_NOTARIZE === "true") throw new Error("MACOS_NOTARIZE is true but no Developer ID identity was found to sign limactl (set MACOS_SIGNING_KEYCHAIN or CSC_NAME)");
  must(run("codesign", limaCodesignArgs({ identity, keychain, file })), "codesign of limactl");
  log(`[sign-lima] limactl signed (${identity === "-" ? "ad hoc" : "Developer ID"}) with ${ENTITLEMENT} and the hardened runtime`);
  return { signed: true, identity, keychain };
}

/**
 * After afterSign's deep ad-hoc signature (a build with no Developer ID): limactl
 * signed again with its entitlement, then the app sealed again around it (not deep:
 * every other signature stays as it is).
 */
function resignLimaAdHoc(appPath, { run = defaultRun } = {}) {
  const file = limactlPath(appPath);
  if (!existsSync(file)) return false;
  must(run("codesign", limaCodesignArgs({ identity: "-", file })), "ad-hoc codesign of limactl");
  must(run("codesign", ["--force", "--sign", "-", "--timestamp=none", "--options", "runtime", "--entitlements", APP_ENTITLEMENTS, appPath]), "ad-hoc seal of the app");
  return true;
}

/**
 * Check the bundled limactl as shipped: the virtualization entitlement and the
 * hardened runtime; for a notarized build also the Developer ID and a timestamp.
 * Throws with what is wrong.
 */
function verifyLimactl(appPath, { requireDeveloperId = false, run = defaultRun } = {}) {
  const file = limactlPath(appPath);
  if (!existsSync(file)) return { present: false };
  must(run("codesign", ["--verify", "--strict", "--verbose=2", file]), "codesign --verify of limactl");
  const entitlements = must(run("codesign", ["-d", "--entitlements", "-", "--xml", file]), "codesign -d --entitlements of limactl");
  if (!`${entitlements.stdout}${entitlements.stderr}`.includes(ENTITLEMENT)) throw new Error(`limactl is not signed with ${ENTITLEMENT}`);
  const details = must(run("codesign", ["-dv", "--verbose=4", file]), "codesign -dv of limactl");
  const info = `${details.stdout}${details.stderr}`;
  if (!/flags=0x[0-9a-f]*\([^)]*runtime/.test(info)) throw new Error("limactl is not signed with the hardened runtime");
  if (requireDeveloperId) {
    if (!/^Authority=Developer ID Application/m.test(info)) throw new Error("limactl is not Developer ID signed");
    if (!/^Timestamp=/m.test(info)) throw new Error("limactl's signature has no secure timestamp");
  }
  return { present: true };
}

module.exports = { ENTITLEMENT, LIMA_ENTITLEMENTS, developerIdHash, limaCodesignArgs, limaIdentity, limactlPath, resignLimaAdHoc, signLimactl, verifyLimactl };
