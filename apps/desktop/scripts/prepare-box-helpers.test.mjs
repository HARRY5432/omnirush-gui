import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
    const res = spawnSync(process.execPath, [script, "--outdir", out], { env: { ...process.env, GO: "/nonexistent/go", TAURI_ENV_TARGET_TRIPLE: triple, OMNIRUSH_BOX_PREBUILT_DIR: "" }, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
  }
  assert.throws(() => statSync(join(out, "box", "linux-arm64", "bwrap")));
  assert.throws(() => statSync(join(out, "box", "linux-amd64", "bwrap")));
});

test("the vendored files are the ones SHA256SUMS pins (the CLI's box/bwrap, byte for byte)", () => {
  for (const [name, digest] of Object.entries(sums())) assert.equal(sha(join(vendored, name)), digest, name);
});
