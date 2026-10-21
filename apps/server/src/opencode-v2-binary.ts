import { externalFetch } from "./server-fetch.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import artifacts from "./opencode-v2-artifacts.json" with { type: "json" };

const exec = promisify(execFile);

/** Install only the pinned native executable; never run registry lifecycle scripts. */
export async function installOpencodeV2Binary(cacheRoot: string, version: string): Promise<string> {
  if (version !== artifacts.version) throw new Error(`No verified OmniRush v2 artifacts for ${version}`);
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const report = process.platform === "linux" ? process.report?.getReport() : undefined;
  const glibc = typeof report === "object" && report !== null && "header" in report
    && typeof report.header === "object" && report.header !== null && "glibcVersionRuntime" in report.header;
  const key = `${platform}-${process.arch}${process.arch === "x64" ? "-baseline" : ""}${platform === "linux" && !glibc ? "-musl" : ""}`;
  const artifact = Object.entries(artifacts.platforms).find(([name]) => name === key)?.[1];
  if (!artifact) throw new Error(`OmniRush v2 does not support ${key}`);
  const directory = join(cacheRoot, version, key);
  const name = platform === "windows" ? "opencode2.exe" : "opencode2";
  const binary = join(directory, name);
  try { await access(binary); void pruneOpencodeV2Versions(cacheRoot, version); return binary; } catch { /* First installation. */ }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await chmod(cacheRoot, 0o700);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const staging = await mkdtemp(join(directory, ".install-"));
  try {
    const response = await externalFetch(artifact.url, { redirect: "error", signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`OmniRush v2 download returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (integrity !== artifact.integrity) throw new Error("OmniRush v2 archive integrity mismatch");
    const archive = join(staging, "binary.tgz");
    await writeFile(archive, bytes, { mode: 0o600 });
    await exec("tar", ["-xzf", archive, "-C", staging, `package/bin/${name}`], { timeout: 60_000 });
    const extracted = join(staging, "package", "bin", name);
    await chmod(extracted, 0o755);
    await rename(extracted, binary);
    void pruneOpencodeV2Versions(cacheRoot, version);
    return binary;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function versionParts(value: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function olderThan(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/**
 * Downloaded engine versions other than the current one and the newest older
 * one (what the previous app version runs) go; newer ones (an app version
 * ahead of this one) and names that are not versions stay. Never throws.
 */
export async function pruneOpencodeV2Versions(cacheRoot: string, current: string): Promise<string[]> {
  const now = versionParts(current);
  if (!now) return [];
  let names: string[] = [];
  try { names = await readdir(cacheRoot); } catch { return []; }
  const older = names
    .map((name) => ({ name, parts: versionParts(name) }))
    .filter((entry): entry is { name: string; parts: number[] } => Boolean(entry.parts) && entry.name !== current && /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(entry.name))
    .filter((entry) => olderThan(entry.parts, now))
    .sort((a, b) => (olderThan(a.parts, b.parts) ? -1 : olderThan(b.parts, a.parts) ? 1 : 0));
  const removed: string[] = [];
  for (const entry of older.slice(0, -1)) {
    try { await rm(join(cacheRoot, entry.name), { recursive: true, force: true, maxRetries: 2 }); removed.push(entry.name); } catch { /* in use (Windows): next start */ }
  }
  return removed;
}
