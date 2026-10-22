import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { limaFiles, limaPin, prepareLima } from "./prepare-lima.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "prepare-box-helpers.mjs");
const vendored = resolve(here, "..", "box", "bwrap");
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function sums() {
  return Object.fromEntries(readFileSync(join(vendored, "SHA256SUMS"), "utf8").trim().split("\n").map((line) => line.trim().split(/\s+/).reverse()));
}

for (const [triple, arch] of [["x86_64-unknown-linux-gnu", "amd64"], ["aarch64-unknown-linux-gnu", "arm64"]]) {
  test(`a Linux build (${arch}) ships the vendored static bubblewrap, checked, with its licence texts`, (t) => {
    const out = mkdtempSync(join(tmpdir(), "omnirush-box-helpers-"));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    const res = spawnSync(process.execPath, [script, "--outdir", out], { env: { ...process.env, GO: "/nonexistent/go", TAURI_ENV_TARGET_TRIPLE: triple, OMNIRUSH_BOX_PREBUILT_DIR: "" }, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    const bwrap = join(out, "box", `linux-${arch}`, "bwrap");
    assert.equal(sha(bwrap), sums()[`linux-${arch}/bwrap`]);
    assert.equal(statSync(bwrap).mode & 0o111, 0o111);
    for (const [src, to] of [["COPYING.bubblewrap", "LICENSE-bwrap-LGPL-2.0"], ["COPYING.libcap", "LICENSE-libcap"], ["COPYING.musl", "LICENSE-musl"]]) {
      assert.equal(sha(join(out, "box", to)), sums()[src]);
    }
  });
}

test("macOS and Windows builds ship no bubblewrap", (t) => {
  const out = mkdtempSync(join(tmpdir(), "omnirush-box-helpers-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  for (const triple of ["aarch64-apple-darwin", "x86_64-pc-windows-msvc"]) {
    const res = spawnSync(process.execPath, [script, "--outdir", out], { env: { ...process.env, GO: "/nonexistent/go", TAURI_ENV_TARGET_TRIPLE: triple, OMNIRUSH_BOX_PREBUILT_DIR: "", OMNIRUSH_LIMA: "0" }, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
  }
  assert.throws(() => statSync(join(out, "box", "linux-arm64", "bwrap")));
  assert.throws(() => statSync(join(out, "box", "linux-amd64", "bwrap")));
});

test("the vendored files are the ones SHA256SUMS pins (the CLI's box/bwrap, byte for byte)", () => {
  for (const [name, digest] of Object.entries(sums())) assert.equal(sha(join(vendored, name)), digest, name);
});

// --- the OmniRush VM's Lima (macOS builds) ---------------------------------------------

/** A Lima release tree like the real one (bin, libexec, share/lima with both guest agents and templates, share/doc). */
function limaTree() {
  const dir = mkdtempSync(join(tmpdir(), "omnirush-lima-tree-"));
  for (const f of ["bin/limactl", "bin/lima", "libexec/lima/lima-driver-qemu", "share/lima/lima-guestagent.Linux-aarch64.gz", "share/lima/lima-guestagent.Linux-x86_64.gz", "share/lima/lima-guestagent.Darwin-aarch64.gz", "share/lima/templates/default.yaml", "share/doc/lima/LICENSE"]) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), f);
  }
  return dir;
}

test("the Lima pin comes from the shared rules (apps/server/src/box/required.json), per arch", () => {
  const rules = JSON.parse(readFileSync(resolve(here, "..", "..", "server", "src", "box", "required.json"), "utf8"));
  assert.deepEqual(limaPin("arm64"), { version: rules.setup.darwin.lima.version, url: rules.setup.darwin.lima.assets.arm64.url, sha256: rules.setup.darwin.lima.assets.arm64.sha256, agent: "lima-guestagent.Linux-aarch64.gz" });
  assert.equal(limaPin("amd64").agent, "lima-guestagent.Linux-x86_64.gz");
  assert.deepEqual(limaFiles("a.gz").map(([from]) => from), ["bin/limactl", "share/lima/a.gz", "share/doc/lima/LICENSE"]);
});

test("a macOS build ships limactl, this arch's Linux guest agent and the licence, nothing else of the release; never on Linux/Windows", async (t) => {
  const tree = limaTree();
  const out = mkdtempSync(join(tmpdir(), "omnirush-lima-out-"));
  t.after(() => { rmSync(tree, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); });
  const got = await prepareLima({ goos: "darwin", goarch: "arm64", out, env: { OMNIRUSH_LIMA_DIR: tree } });
  assert.equal(got.ok, true);
  const list = (d) => readdirSync(d, { recursive: true }).filter((f) => statSync(join(d, f)).isFile()).sort();
  assert.deepEqual(list(join(out, "lima")), ["LICENSE", "bin/limactl", "share/lima/lima-guestagent.Linux-aarch64.gz"]);
  assert.equal(statSync(join(out, "lima", "bin", "limactl")).mode & 0o111, 0o111);
  assert.deepEqual(await prepareLima({ goos: "linux", goarch: "arm64", out, env: {} }), { ok: false, reason: "not a macOS build" });
  assert.deepEqual(await prepareLima({ goos: "darwin", goarch: "arm64", out, env: { OMNIRUSH_LIMA: "0" } }), { ok: false, reason: "OMNIRUSH_LIMA=0" });
});

test("the release download is checked against the pinned sha256: a different file stops the build", async (t) => {
  const tree = limaTree();
  const out = mkdtempSync(join(tmpdir(), "omnirush-lima-out-"));
  const tarball = join(mkdtempSync(join(tmpdir(), "omnirush-lima-tgz-")), "lima.tar.gz");
  t.after(() => { for (const d of [tree, out, dirname(tarball)]) rmSync(d, { recursive: true, force: true }); });
  spawnSync("tar", ["-czf", tarball, "-C", tree, "bin", "libexec", "share"]);
  const body = readFileSync(tarball);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const rules = { setup: { darwin: { lima: { version: "9.9.9", assets: { arm64: { url: "https://example.invalid/lima.tar.gz", sha256 } } } } } };
  const asked = [];
  const fetchImpl = async (url) => { asked.push(url); return new Response(body, { status: 200 }); };
  assert.deepEqual(await prepareLima({ goos: "darwin", goarch: "arm64", out, env: {}, fetchImpl, rules }), { ok: true, source: "release", version: "9.9.9" });
  assert.deepEqual(asked, ["https://example.invalid/lima.tar.gz"]);
  assert.equal(readFileSync(join(out, "lima", "bin", "limactl"), "utf8"), "bin/limactl");
  const wrong = { setup: { darwin: { lima: { version: "9.9.9", assets: { arm64: { url: "https://example.invalid/lima.tar.gz", sha256: "0".repeat(64) } } } } } };
  await assert.rejects(prepareLima({ goos: "darwin", goarch: "arm64", out, env: {}, fetchImpl, rules: wrong }), /is not the pinned/);
});
