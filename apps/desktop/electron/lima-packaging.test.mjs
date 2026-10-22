// The OmniRush VM in the macOS build: the linux boxrun and Lima ship in sidecars
// (electron-builder.base.yml), limactl is left out of electron-builder's signing
// (signIgnore) and signed on its own with the virtualization entitlement, the
// hardened runtime and the Developer ID (scripts/sign-lima.cjs, from afterPack),
// checked again in afterSign. No signed build runs here: the codesign calls are
// recorded and their arguments checked.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const require = createRequire(import.meta.url);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(dirname, "..");
const sign = require("../scripts/sign-lima.cjs");

const config = () => YAML.parse(readFileSync(path.join(desktop, "electron-builder.base.yml"), "utf8"));
const DEV_ID = "  1) 0123456789ABCDEF0123456789ABCDEF01234567 \"Developer ID Application: Example (2KFG4BXC8K)\"\n     1 valid identities found\n";

function fakeApp() {
  const root = mkdtempSync(path.join(tmpdir(), "lima-app-"));
  const app = path.join(root, "omnirush.app");
  const limactl = sign.limactlPath(app);
  mkdirSync(path.dirname(limactl), { recursive: true });
  writeFileSync(limactl, "limactl");
  return { root, app, limactl };
}

function recorder(answers = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    const key = `${command} ${args[0]}`;
    const answer = typeof answers[key] === "function" ? answers[key](args) : answers[key];
    return { status: 0, stdout: "", stderr: "", ...(answer ?? {}) };
  };
  return { calls, run };
}

describe("macOS build: the OmniRush VM ships", () => {
  it("the sidecars hold the linux boxrun, limactl, the Linux guest agent and Lima's licence", () => {
    const sidecars = config().mac.extraResources.find((resource) => resource.to === "sidecars");
    for (const entry of ["box/darwin-*/boxsh", "box/linux-*/boxd", "box/linux-*/boxrun", "lima/bin/limactl", "lima/share/lima/lima-guestagent.Linux-*.gz", "lima/LICENSE"]) {
      assert.ok(sidecars.filter.includes(entry), `${entry} is not packaged`);
    }
    assert.ok(!sidecars.filter.some((entry) => /Darwin|libexec|templates/.test(entry)), "nothing else of the Lima release ships");
  });

  it("limactl alone is left out of electron-builder's signing (the inherited entitlements would replace its own)", () => {
    const { mac } = config();
    assert.equal(mac.hardenedRuntime, true);
    const ignore = mac.signIgnore.map((pattern) => new RegExp(pattern));
    const res = "/x/dist-electron/mac-arm64/omnirush.app/Contents/Resources";
    assert.ok(ignore.some((re) => re.test(`${res}/sidecars/lima/bin/limactl`)));
    for (const other of [`${res}/sidecars/opencode-aarch64-apple-darwin`, `${res}/sidecars/box/darwin-arm64/boxsh`, `${res}/sidecars/lima/share/lima/lima-guestagent.Linux-aarch64.gz`, `${res}/../MacOS/omnirush`, `${res}/sidecars/lima/bin/limactl.bak`]) {
      assert.ok(!ignore.some((re) => re.test(other)), `${other} must still be signed by electron-builder`);
    }
  });

  it("limactl's entitlements are exactly Apple's virtualization one; the app's own entitlements are unchanged", () => {
    const lima = readFileSync(path.join(desktop, "build", "entitlements.lima.plist"), "utf8");
    assert.deepEqual([...lima.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]), ["com.apple.security.virtualization"]);
    const app = readFileSync(path.join(desktop, "build", "entitlements.mac.plist"), "utf8");
    assert.ok(!app.includes("com.apple.security.virtualization"), "the app and its other binaries do not get it");
  });
});

describe("sign-lima.cjs", () => {
  it("identity: a named one, else the Developer ID in MACOS_SIGNING_KEYCHAIN (CI), else one electron-builder would find, else ad hoc", () => {
    const { run } = recorder({ "security find-identity": { stdout: DEV_ID } });
    assert.deepEqual(sign.limaIdentity({ env: { CSC_NAME: "Example (2KFG4BXC8K)", MACOS_SIGNING_KEYCHAIN: "/k" }, run }), { identity: "Example (2KFG4BXC8K)", keychain: "/k" });
    assert.deepEqual(sign.limaIdentity({ env: { MACOS_SIGNING_KEYCHAIN: "/k" }, run }), { identity: "0123456789ABCDEF0123456789ABCDEF01234567", keychain: "/k" });
    assert.deepEqual(sign.limaIdentity({ env: {}, run }), { identity: "0123456789ABCDEF0123456789ABCDEF01234567", keychain: null });
    assert.deepEqual(sign.limaIdentity({ env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" }, run }), { identity: "-", keychain: null });
    assert.equal(sign.developerIdHash("  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 \"Apple Development: x\""), null);
  });

  it("afterPack: limactl signed with the virtualization entitlement, the hardened runtime and a timestamp; a notarized build never ad hoc", (t) => {
    const { root, app, limactl } = fakeApp();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { calls, run } = recorder({ "security find-identity": { stdout: DEV_ID } });
    const signed = sign.signLimactl(app, { env: { MACOS_SIGNING_KEYCHAIN: "/k", MACOS_NOTARIZE: "true" }, run, log: () => {} });
    assert.equal(signed.signed, true);
    const codesign = calls.find((c) => c[0] === "codesign");
    assert.deepEqual(codesign, ["codesign", "--force", "--sign", "0123456789ABCDEF0123456789ABCDEF01234567", "--options", "runtime", "--timestamp", "--keychain", "/k", "--entitlements", sign.LIMA_ENTITLEMENTS, limactl]);
    assert.throws(() => sign.signLimactl(app, { env: { MACOS_NOTARIZE: "true", CSC_IDENTITY_AUTO_DISCOVERY: "false" }, run: recorder().run, log: () => {} }), /no Developer ID identity/);
    const adHoc = recorder();
    sign.signLimactl(app, { env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" }, run: adHoc.run, log: () => {} });
    assert.deepEqual(adHoc.calls[0].slice(1, 7), ["--force", "--sign", "-", "--options", "runtime", "--timestamp=none"]);
    assert.deepEqual(sign.signLimactl(path.join(root, "none.app"), { run: recorder().run }), { signed: false, reason: "no bundled limactl" });
  });

  it("afterSign (no Developer ID): after the deep ad-hoc signature limactl gets its entitlement back, then the app is sealed again, not deep", (t) => {
    const { root, app, limactl } = fakeApp();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { calls, run } = recorder();
    assert.equal(sign.resignLimaAdHoc(app, { run }), true);
    assert.equal(calls[0].at(-1), limactl);
    assert.ok(calls[0].includes(sign.LIMA_ENTITLEMENTS));
    assert.equal(calls[1].at(-1), app);
    assert.ok(!calls[1].includes("--deep"), "every other signature stays");
  });

  it("verify: the entitlement and the hardened runtime always; Developer ID and a timestamp when notarized", (t) => {
    const { root, app } = fakeApp();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const good = {
      "codesign -d": { stdout: "<plist><dict><key>com.apple.security.virtualization</key><true/></dict></plist>" },
      "codesign -dv": { stderr: "Authority=Developer ID Application: Example (2KFG4BXC8K)\nTimestamp=22 Oct 2026\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1\n" },
    };
    assert.deepEqual(sign.verifyLimactl(app, { requireDeveloperId: true, run: recorder(good).run }), { present: true });
    assert.throws(() => sign.verifyLimactl(app, { run: recorder({ ...good, "codesign -d": { stdout: "<plist/>" } }).run }), /com\.apple\.security\.virtualization/);
    assert.throws(() => sign.verifyLimactl(app, { run: recorder({ ...good, "codesign -dv": { stderr: "CodeDirectory v=20500 flags=0x2(adhoc)\n" } }).run }), /hardened runtime/);
    const adHoc = { ...good, "codesign -dv": { stderr: "Signature=adhoc\nCodeDirectory v=20500 flags=0x10002(adhoc,runtime)\n" } };
    assert.deepEqual(sign.verifyLimactl(app, { run: recorder(adHoc).run }), { present: true });
    assert.throws(() => sign.verifyLimactl(app, { requireDeveloperId: true, run: recorder(adHoc).run }), /not Developer ID signed/);
    assert.deepEqual(sign.verifyLimactl(path.join(root, "none.app"), { run: recorder().run }), { present: false });
  });

  it("the hooks: afterPack signs limactl before electron-builder signs the app; afterSign re-signs it after an ad-hoc deep signature and checks it", () => {
    const pack = readFileSync(path.join(desktop, "scripts", "electron-after-pack.cjs"), "utf8");
    const body = pack.slice(pack.indexOf("async function afterPack"));
    assert.ok(body.indexOf("signLimactl(") > 0 && body.indexOf("signLimactl(") < body.indexOf("targetTriple("), "signed for every darwin pack, before anything can return early");
    const after = readFileSync(path.join(desktop, "scripts", "electron-after-sign.cjs"), "utf8");
    assert.match(after, /if \(adHocSignIfUnsigned\(appPath\)\) resignLimaAdHoc\(appPath\);/);
    assert.ok(after.indexOf("verifyLimactl(") < after.indexOf("notarizeFile("), "checked before notarization");
  });
});
