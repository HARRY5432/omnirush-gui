/**
 * What a release build of the desktop app (build-variant.ts) refuses:
 *   - an account server or gateway other than https://omnirush.ai or
 *     https://<name>.omnirush.ai, from any source (environment, settings, a
 *     stored or renewed sign-in). Such an address is an error, never a
 *     fallback;
 *   - an engine binary other than the one the app bundles (its sha256 is
 *     stamped into the build).
 * The dev variant takes any address and engine, as before.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";

import { BUILD_VARIANT, RELEASE_ENGINE_SHA256 } from "./build-variant.js";

export type BuildFacts = { release: boolean; engineSha256: string | null };

export function buildFacts(): BuildFacts {
  return { release: BUILD_VARIANT === "release", engineSha256: RELEASE_ENGINE_SHA256 };
}

export function isReleaseBuild(facts: BuildFacts = buildFacts()): boolean {
  return facts.release;
}

/** Whether a release build may use `raw` as its account server or gateway (any address in the dev variant). */
export function gatewayUrlAllowed(raw: unknown, facts: BuildFacts = buildFacts()): boolean {
  if (!facts.release) return true;
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && url.port === ""
      && (host === "omnirush.ai" || host.endsWith(".omnirush.ai"));
  } catch {
    return false;
  }
}

export const RELEASE_GATEWAY_ERROR = "This build of OmniRush.ai only connects to omnirush.ai.";

/** Throws unless gatewayUrlAllowed(); `what` names the setting in the error. */
export function assertGatewayUrlAllowed(raw: unknown, what: string, facts: BuildFacts = buildFacts()): void {
  if (!gatewayUrlAllowed(raw, facts)) throw new Error(`${RELEASE_GATEWAY_ERROR} ${what} is not an omnirush.ai address.`);
}

/**
 * A gateway address from the environment (OMNIRUSH_GATEWAY_URL and the like):
 * returned when allowed; in a release build anything else is reported once
 * and not used (no other address takes its place).
 */
export function allowedGatewayUrlFromEnv(raw: string | undefined, name: string, facts: BuildFacts = buildFacts()): string | undefined {
  if (raw === undefined || !raw.trim()) return raw;
  if (gatewayUrlAllowed(raw, facts)) return raw;
  reportOnce(`${name}`, `${RELEASE_GATEWAY_ERROR} ${name} is not an omnirush.ai address and is not used.`);
  return undefined;
}

const reported = new Set<string>();
function reportOnce(key: string, message: string): void {
  if (reported.has(key)) return;
  reported.add(key);
  console.error(`[omnirush] ${message}`);
}

export const RELEASE_ENGINE_ERROR = "This build of OmniRush.ai only runs the engine it ships with.";

/** The file's sha256, read in full every time (an engine start checks the bytes it is about to run). */
async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", () => resolvePromise()).on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * The engine binary to run. In a release build: `bin` must be an absolute
 * path to a file whose sha256 is the one stamped into the build (the bundled
 * engine); anything else, no path, or no stamped hash throws. In the dev
 * variant, `bin` as given.
 */
export async function releaseEngineBinary(bin: string | undefined | null, facts: BuildFacts = buildFacts()): Promise<string | undefined> {
  if (!facts.release) return bin ?? undefined;
  const path = bin?.trim() ?? "";
  if (!facts.engineSha256 || !path || !isAbsolute(path)) throw new Error(`${RELEASE_ENGINE_ERROR} No bundled engine was found.`);
  let actual: string;
  try {
    actual = await fileSha256(path);
  } catch {
    throw new Error(`${RELEASE_ENGINE_ERROR} The bundled engine could not be read.`);
  }
  if (actual !== facts.engineSha256) throw new Error(`${RELEASE_ENGINE_ERROR} The engine at ${path} is not the bundled one. Reinstall OmniRush.ai.`);
  return path;
}
