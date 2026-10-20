import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { gatewayUrlAllowedForBuild, readDesktopBuild, releaseEngineBinary } from "./build-variant.mjs";
import { createDesktopOmniRushAccountStore } from "./omnirush-account.mjs";
import { desktopVariant, stampBuildVariant } from "../scripts/stamp-build-variant.mjs";

/** @typedef {import("./build-variant.mjs").DesktopBuild} DesktopBuild */
/** @type {DesktopBuild} */
const RELEASE = { variant: "release", engineSha256: "a".repeat(64), packaged: true };
/** @type {DesktopBuild} */
const DEV = { variant: "dev", engineSha256: null, packaged: false };

test("the build marker: source tree is dev, a packaged app is release unless it says dev", () => {
  assert.deepEqual(readDesktopBuild({ resourcesPath: undefined }), DEV);
  const files = new Map();
  const at = { resourcesPath: "/r", exists: (file) => file === "/r/app.asar" || files.has(file), read: (file) => { if (!files.has(file)) throw new Error("missing"); return files.get(file); } };
  assert.equal(readDesktopBuild(at).variant, "release");
  files.set("/r/app.asar/server/omnirush-build.json", "not json");
  assert.equal(readDesktopBuild(at).variant, "release");
  files.set("/r/app.asar/server/omnirush-build.json", JSON.stringify({ variant: "dev", engineSha256: null }));
  assert.equal(readDesktopBuild(at).variant, "dev");
  files.set("/r/app.asar/server/omnirush-build.json", JSON.stringify({ variant: "release", engineSha256: "b".repeat(64) }));
  assert.deepEqual(readDesktopBuild(at), { variant: "release", engineSha256: "b".repeat(64), packaged: true });
});

test("release: only https omnirush.ai addresses", () => {
  assert.equal(gatewayUrlAllowedForBuild("https://omnirush.ai/omnirush/v1", RELEASE), true);
  assert.equal(gatewayUrlAllowedForBuild("https://api.omnirush.ai/omnirush/v1", RELEASE), true);
  for (const bad of ["http://localhost:8090/omnirush/v1", "https://omnirush.ai.evil.example", "https://omnirush.ai:444", "https://staging.example/omnirush/v1"]) {
    assert.equal(gatewayUrlAllowedForBuild(bad, RELEASE), false, bad);
  }
  assert.equal(gatewayUrlAllowedForBuild("http://localhost:8090/omnirush/v1", DEV), true);
});

test("release: the account store refuses other servers from env, sign-in and stored credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omnirush-build-variant-"));
  const requested = [];
  const make = (env) => createDesktopOmniRushAccountStore({
    build: RELEASE,
    filePath: path.join(directory, `account-${requested.length}-${Math.random()}.bin`),
    loadSafeStorage: () => ({ isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => "keychain", encryptStringAsync: async (v) => Buffer.from(v), decryptStringAsync: async (v) => ({ result: v.toString(), shouldReEncrypt: false }) }),
    platform: "linux",
    env,
    sleep: async () => undefined,
    execFileImpl: async () => { throw new Error("no keychain"); },
    fetchImpl: async (url) => { requested.push(String(url)); return Response.json({}, { status: 503 }); },
  });
  const sign = (store, gatewayUrl) => store.authorize({ gatewayUrl, deviceName: "t", openVerification: async () => undefined });
  await assert.rejects(sign(make({ OMNIRUSH_GATEWAY_URL: "https://staging.example/omnirush/v1" })), /only connects to omnirush.ai/);
  await assert.rejects(sign(make({ OMNIRUSH_DEV_MODE: "1", OMNIRUSH_LOCAL_API: "1" })), /only connects to omnirush.ai/);
  await assert.rejects(sign(make({}), "http://localhost:8090/omnirush/v1"), /only connects to omnirush.ai/);
  assert.deepEqual(requested, []);
  await assert.rejects(sign(make({})));
  assert.deepEqual(requested, ["https://omnirush.ai/omnirush/device/authorize"]);
  const status = await make({ OMNIRUSH_GATEWAY_URL: "http://127.0.0.1:1/omnirush/v1" }).status();
  assert.equal(status.gatewayUrl, null);
  assert.equal(status.gatewayConfigured, false);
});

test("release: only the bundled engine with the recorded sha256", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omnirush-build-engine-"));
  await mkdir(path.join(directory, "sidecars"));
  await writeFile(path.join(directory, "sidecars", "opencode"), "engine");
  const sha = createHash("sha256").update("engine").digest("hex");
  /** @type {DesktopBuild} */
  const build = { variant: "release", engineSha256: sha, packaged: true };
  assert.deepEqual(releaseEngineBinary({ build, resourcesPath: directory, fileNames: ["opencode"] }), { path: path.join(directory, "sidecars", "opencode"), source: "bundled" });
  assert.throws(() => releaseEngineBinary({ build: { ...build, engineSha256: "c".repeat(64) }, resourcesPath: directory, fileNames: ["opencode"] }), /was changed/);
  assert.throws(() => releaseEngineBinary({ build, resourcesPath: directory, fileNames: ["missing"] }), /No bundled engine/);
});

test("packaging stamps release with the engine hash, or dev when asked at build time", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omnirush-build-stamp-"));
  const sidecarDir = path.join(directory, "sidecars");
  const serverDistDir = path.join(directory, "dist");
  await mkdir(sidecarDir);
  await mkdir(serverDistDir);
  await writeFile(path.join(sidecarDir, "opencode"), "engine");
  await writeFile(path.join(sidecarDir, "opencode-x86_64-unknown-linux-gnu"), "engine");
  const source = 'export const BUILD_VARIANT = "dev";\nexport const RELEASE_ENGINE_SHA256 = null;\n';
  await writeFile(path.join(serverDistDir, "build-variant.js"), source);
  const buildFilePath = path.join(directory, "omnirush-build.json");
  const sha = createHash("sha256").update("engine").digest("hex");
  assert.deepEqual(stampBuildVariant({ env: {}, sidecarDir, serverDistDir, buildFilePath }), { variant: "release", engineSha256: sha });
  assert.equal(await readFile(path.join(serverDistDir, "build-variant.js"), "utf8"), `export const BUILD_VARIANT = "release";\nexport const RELEASE_ENGINE_SHA256 = "${sha}";\n`);
  assert.deepEqual(JSON.parse(await readFile(buildFilePath, "utf8")), { variant: "release", engineSha256: sha });
  assert.deepEqual(stampBuildVariant({ env: { OMNIRUSH_DESKTOP_VARIANT: "dev" }, sidecarDir, serverDistDir, buildFilePath }), { variant: "dev", engineSha256: null });
  assert.equal(await readFile(path.join(serverDistDir, "build-variant.js"), "utf8"), source);
  assert.throws(() => desktopVariant({ OMNIRUSH_DESKTOP_VARIANT: "staging" }));
  await writeFile(path.join(sidecarDir, "opencode-x86_64-unknown-linux-gnu"), "other");
  assert.throws(() => stampBuildVariant({ env: {}, sidecarDir, serverDistDir, buildFilePath }), /one bundled engine/);
});
