// The build variant of a packaged desktop app (electron/build-variant.mjs and
// apps/server/src/build-variant.ts). Release unless the build is asked for the
// dev variant with OMNIRUSH_DESKTOP_VARIANT=dev; a release records the sha256
// of the engine binary it bundles, which is then the only engine it runs.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function desktopVariant(env = process.env) {
  const asked = String(env.OMNIRUSH_DESKTOP_VARIANT ?? "").trim().toLowerCase();
  if (asked && asked !== "dev" && asked !== "release") throw new Error(`OMNIRUSH_DESKTOP_VARIANT must be "dev" or "release", not "${asked}"`);
  return asked === "dev" ? "dev" : "release";
}

/**
 * The sha256 of each bundled engine binary, comma-separated in sorted order.
 * A macOS build bundles one engine per architecture (arm64 and x64): each is
 * recorded, and a release runs only a binary with one of these hashes.
 */
export function bundledEngineSha256(sidecarDir) {
  const names = existsSync(sidecarDir) ? readdirSync(sidecarDir).filter((name) => /^opencode(?:-[a-z0-9_-]+)?(?:\.exe)?$/.test(name)) : [];
  const hashes = [...new Set(names.map((name) => createHash("sha256").update(readFileSync(join(sidecarDir, name))).digest("hex")))].sort();
  if (hashes.length < 1 || hashes.length > 4) throw new Error(`Expected one engine per architecture in ${sidecarDir}, found ${names.length} file(s) with ${hashes.length} different content(s)`);
  return hashes.join(",");
}

/** Stamps the packaged server copy's build-variant.js (two lines, checked). */
export function stampServerVariant(serverDistDir, variant, engineSha256) {
  const file = join(serverDistDir, "build-variant.js");
  const source = readFileSync(file, "utf8");
  const variantLine = /^export const BUILD_VARIANT = "(?:dev|release)";$/m;
  const hashLine = /^export const RELEASE_ENGINE_SHA256 = (?:null|"[0-9a-f]{64}(?:,[0-9a-f]{64})*");$/m;
  if (!variantLine.test(source) || !hashLine.test(source)) throw new Error(`${file} does not have the expected build variant lines`);
  const stamped = source
    .replace(variantLine, `export const BUILD_VARIANT = "${variant}";`)
    .replace(hashLine, `export const RELEASE_ENGINE_SHA256 = ${engineSha256 ? `"${engineSha256}"` : "null"};`);
  writeFileSync(file, stamped, "utf8");
}

/** Writes <out>/omnirush-build.json and stamps the packaged server; returns what was written. */
export function stampBuildVariant({ env = process.env, sidecarDir, serverDistDir, buildFilePath }) {
  const variant = desktopVariant(env);
  const engineSha256 = variant === "release" ? bundledEngineSha256(sidecarDir) : null;
  const build = { variant, engineSha256 };
  writeFileSync(buildFilePath, `${JSON.stringify(build, null, 2)}\n`, "utf8");
  stampServerVariant(serverDistDir, variant, engineSha256);
  return build;
}
