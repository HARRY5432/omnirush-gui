import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILD_VARIANT, RELEASE_ENGINE_SHA256 } from "./build-variant.js";
import { allowedGatewayUrlFromEnv, assertGatewayUrlAllowed, engineSignedByTeam, gatewayUrlAllowed, releaseEngineBinary } from "./release-guard.js";

const DEV = { release: false, engineSha256: null };
const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("release build guard", () => {
  test("the source is the dev variant; packaging stamps release (apps/desktop/scripts/stamp-build-variant.mjs)", () => {
    expect(BUILD_VARIANT).toBe("dev");
    expect(RELEASE_ENGINE_SHA256).toBeNull();
  });

  test("release: only https omnirush.ai and its subdomains, as an error otherwise", () => {
    const release = { release: true, engineSha256: null };
    for (const ok of ["https://omnirush.ai/omnirush/v1", "https://api.omnirush.ai/omnirush/v1", "https://OMNIRUSH.AI"]) expect([ok, gatewayUrlAllowed(ok, release)]).toEqual([ok, true]);
    for (const bad of ["http://omnirush.ai", "http://127.0.0.1:8090/omnirush/v1", "https://omnirush.ai.evil.example", "https://evilomnirush.ai", "https://omnirush.ai:8443", "https://user:pw@omnirush.ai", "https://example.com", "not a url", ""]) {
      expect([bad, gatewayUrlAllowed(bad, release)]).toEqual([bad, false]);
    }
    expect(() => assertGatewayUrlAllowed("http://localhost:1", "OMNIRUSH_GATEWAY_URL", release)).toThrow("only connects to omnirush.ai");
    expect(allowedGatewayUrlFromEnv("http://localhost:1", "OMNIRUSH_GATEWAY_URL", release)).toBeUndefined();
    expect(allowedGatewayUrlFromEnv("https://omnirush.ai/omnirush/v1", "OMNIRUSH_GATEWAY_URL", release)).toBe("https://omnirush.ai/omnirush/v1");
  });

  test("dev variant: any address, as before", () => {
    expect(gatewayUrlAllowed("http://127.0.0.1:8090/omnirush/v1", DEV)).toBe(true);
    expect(gatewayUrlAllowed("https://gateway.example/omnirush/v1")).toBe(true);
  });

  test("release: only the bundled engine, by its sha256; dev: the binary as given", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-release-guard-"));
    roots.push(root);
    const bin = join(root, "opencode");
    await writeFile(bin, "#!/bin/sh\necho engine\n");
    await chmod(bin, 0o755);
    const sha = createHash("sha256").update("#!/bin/sh\necho engine\n").digest("hex");
    const release = { release: true, engineSha256: sha };
    expect(await releaseEngineBinary(bin, release)).toBe(bin);
    await expect(releaseEngineBinary("opencode", release)).rejects.toThrow("only runs the engine it ships with");
    await expect(releaseEngineBinary(undefined, release)).rejects.toThrow("only runs the engine it ships with");
    await expect(releaseEngineBinary(bin, { release: true, engineSha256: null })).rejects.toThrow();
    const other = join(root, "other");
    await writeFile(other, "#!/bin/sh\necho other\n");
    await expect(releaseEngineBinary(other, release)).rejects.toThrow("is not the bundled one");
    // macOS: signing rewrites the engine after its sha256 is recorded; this team's signature counts instead.
    expect(await releaseEngineBinary(other, release, async () => true)).toBe(other);
    await expect(releaseEngineBinary(other, release, async () => false)).rejects.toThrow("is not the bundled one");
    expect(await engineSignedByTeam(other, "linux")).toBe(false);
    // On macOS only the bundled engine's folder is considered: any other path is refused without asking codesign.
    expect(await engineSignedByTeam(other, "darwin")).toBe(false);
    expect(await engineSignedByTeam(other, "win32")).toBe(false);
    // One hash per bundled architecture (macOS arm64 + x64), comma-separated.
    expect(await releaseEngineBinary(bin, { release: true, engineSha256: ["f".repeat(64), sha].join(",") })).toBe(bin);
    await expect(releaseEngineBinary(other, { release: true, engineSha256: ["f".repeat(64), sha].join(",") })).rejects.toThrow("is not the bundled one");
    // Bytes changed in place with the same size and time: still refused (hashed at every start, no cache).
    const { mtime } = await stat(bin);
    await writeFile(bin, "#!/bin/sh\necho EVILLL\n");
    await utimes(bin, mtime, mtime);
    await expect(releaseEngineBinary(bin, release)).rejects.toThrow("is not the bundled one");
    expect(await releaseEngineBinary("opencode", DEV)).toBe("opencode");
    expect(await releaseEngineBinary(undefined, DEV)).toBeUndefined();
  });
});
