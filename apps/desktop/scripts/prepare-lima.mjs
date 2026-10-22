#!/usr/bin/env node
// The OmniRush VM's Lima (macOS builds only), next to the engine in the sidecars
// folder: lima/bin/limactl, lima/share/lima/lima-guestagent.Linux-<arch>.gz (the
// guest agent for the VM, of this build's architecture) and lima/LICENSE
// (Apache 2.0). The pinned release from the shared rules
// (apps/server/src/box/required.json setup.darwin.lima: url + sha256 per
// arch), downloaded and checked here, or a prepared tree from OMNIRUSH_LIMA_DIR
// (the CLI's build reads the same variable). Nothing else of the release ships
// (the vz driver is built into limactl). limactl is signed with the
// virtualization entitlement at packaging (electron-after-pack.cjs, sign-lima.cjs).
// OMNIRUSH_LIMA=0 skips it; without it the app downloads the same pinned
// release on first use (backends/lima.ts).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const RULES = resolve(here, "..", "..", "server", "src", "box", "required.json");

/** The pinned release for a Go arch: { version, url, sha256, agent } (agent: the guest agent's file name). */
export function limaPin(goarch, rules = JSON.parse(readFileSync(RULES, "utf8"))) {
  const lima = rules?.setup?.darwin?.lima;
  const asset = lima?.assets?.[goarch === "arm64" ? "arm64" : "x64"];
  if (!lima?.version || !asset?.url || !/^[0-9a-f]{64}$/.test(String(asset.sha256 || ""))) return null;
  return { version: lima.version, url: asset.url, sha256: asset.sha256, agent: `lima-guestagent.Linux-${goarch === "arm64" ? "aarch64" : "x86_64"}.gz` };
}

/** The files that ship, from a release tree to sidecars/lima. */
export function limaFiles(agent) {
  return [["bin/limactl", "bin/limactl"], [`share/lima/${agent}`, `share/lima/${agent}`], ["share/doc/lima/LICENSE", "LICENSE"]];
}

async function download(url, dest, sha256, fetchImpl) {
  const res = await fetchImpl(url, { redirect: "follow", headers: { "user-agent": "omnirush-build" } });
  if (!res.ok) throw new Error(`Lima download: HTTP ${res.status} (${url})`);
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(body).digest("hex");
  if (got !== sha256) throw new Error(`Lima download: sha256 ${got} is not the pinned ${sha256}`);
  writeFileSync(dest, body);
}

/**
 * Put Lima under <out>/lima for a darwin build. Returns { ok, source, version }
 * or { ok: false, reason } (skipped, not pinned); throws on a wrong download.
 */
export async function prepareLima({ goos, goarch, out, env = process.env, fetchImpl = globalThis.fetch, rules } = {}) {
  if (goos !== "darwin") return { ok: false, reason: "not a macOS build" };
  if (env.OMNIRUSH_LIMA === "0") return { ok: false, reason: "OMNIRUSH_LIMA=0" };
  const pin = limaPin(goarch, rules);
  if (!pin) return { ok: false, reason: "no Lima pinned for this arch" };
  const dest = join(out, "lima");
  rmSync(dest, { recursive: true, force: true });
  let tree = String(env.OMNIRUSH_LIMA_DIR || "").trim() || null;
  let tmp = null;
  try {
    if (!tree) {
      tmp = mkdtempSync(join(tmpdir(), "omnirush-lima-"));
      const tarball = join(tmp, "lima.tar.gz");
      await download(pin.url, tarball, pin.sha256, fetchImpl);
      tree = join(tmp, "tree");
      mkdirSync(tree);
      const res = spawnSync("tar", ["-xzf", tarball, "-C", tree], { stdio: "inherit" });
      if (res.status !== 0) throw new Error("Lima download: could not unpack the release");
    }
    for (const [from, to] of limaFiles(pin.agent)) {
      const src = join(tree, from);
      if (!existsSync(src)) throw new Error(`Lima: ${from} is missing from ${env.OMNIRUSH_LIMA_DIR ? "OMNIRUSH_LIMA_DIR" : "the release"}`);
      mkdirSync(dirname(join(dest, to)), { recursive: true });
      copyFileSync(src, join(dest, to));
    }
    chmodSync(join(dest, "bin", "limactl"), 0o755);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  return { ok: true, source: env.OMNIRUSH_LIMA_DIR ? "dir" : "release", version: pin.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [goos = "darwin", goarch = "arm64", out = resolve(here, "..", "resources", "sidecars")] = process.argv.slice(2);
  prepareLima({ goos, goarch, out }).then((res) => console.log(res.ok ? `Lima ${res.version} ready (${res.source}).` : `Lima skipped: ${res.reason}.`), (error) => { console.error(error.message); process.exit(1); });
}
