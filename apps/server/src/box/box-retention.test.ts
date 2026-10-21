// Old sandbox images across box-version updates (retention.mjs, shared with the CLI):
// kept are the current and previous pins and every image a box uses.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { gcBoxes } from "./box.js";
import { bwrapDriver } from "./backends/bwrap.js";
import { wslDriver } from "./backends/wsl.js";
import { keptImages } from "./retention.mjs";
import type { BoxRuntime } from "./common.js";
import type { RunCommand } from "./run.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;
const pinsOf = (version: string, digest: string) => ({ version, images: { base: { ref: `ghcr.io/omnirush-ai/box-base:${version}`, digest: D(digest) } } });
const homes: string[] = [];
const home = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "box-ret-")); homes.push(dir); return dir; };
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("box image retention", () => {
  test("first run (no pins recorded yet): no image goes", async () => {
    const h = home();
    const removed: string[] = [];
    const run = (async (_bin: string, args: string[]) => {
      if (args[0] === "images") return { code: 0, stdout: `ghcr.io/omnirush-ai/box-base\t<none>\t${D("0")}\t000000000000\t1GB\n`, stderr: "" };
      if (args[0] === "rmi") { removed.push(String(args[1])); return { code: 0, stdout: "", stderr: "" }; }
      return { code: 0, stdout: "", stderr: "" };
    }) as unknown as RunCommand;
    await gcBoxes({ name: "docker", backend: "docker", bin: "docker" } as unknown as BoxRuntime, { home: h, run, pins: pinsOf("2026.10.2", "c") as never, exists: () => true });
    expect(removed).toEqual([]);
  });

  test("docker: three box versions on disk, the oldest (a digest pull, <none> tag) goes as repo@digest", async () => {
    const h = home();
    keptImages(h, pinsOf("2026.10.1", "a"));
    const rows = [
      ["ghcr.io/omnirush-ai/box-base", "<none>", D("c"), "cccccccccccc", "1.03GB"],
      ["ghcr.io/omnirush-ai/box-base", "<none>", D("a"), "aaaaaaaaaaaa", "1.02GB"],
      ["ghcr.io/omnirush-ai/box-base", "<none>", D("0"), "000000000000", "1.01GB"],
      ["ghcr.io/omnirush-ai/sandbox", "1", D("2"), "222222222222", "1.21GB"],
    ];
    const removed: string[] = [];
    const run = (async (_bin: string, args: string[]) => {
      if (args[0] === "ps") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "images") return { code: 0, stdout: rows.map((r) => r.join("\t")).join("\n") + "\n", stderr: "" };
      if (args[0] === "rmi") { removed.push(String(args[1])); return { code: 0, stdout: "", stderr: "" }; }
      return { code: 1, stdout: "", stderr: "" };
    }) as unknown as RunCommand;
    const runtime = { name: "docker", backend: "docker", bin: "docker" } as unknown as BoxRuntime;
    const dry = await gcBoxes(runtime, { home: h, run, pins: pinsOf("2026.10.2", "c") as never, exists: () => true, dryRun: true });
    expect(removed).toEqual([]);
    expect(dry.map((r) => r.name)).toEqual([`ghcr.io/omnirush-ai/box-base@${D("0")}`]);
    await gcBoxes(runtime, { home: h, run, pins: pinsOf("2026.10.2", "c") as never, exists: () => true });
    expect(removed).toEqual([`ghcr.io/omnirush-ai/box-base@${D("0")}`]);
  });

  test("bwrap: old store images go; a stopped pull's download goes; current and previous stay", async () => {
    const h = home();
    keptImages(h, pinsOf("2026.10.1", "a"));
    const store = path.join(h, "bwrap", "store");
    const weekAgo = new Date(Date.now() - 8 * 86_400_000);
    const image = (id: string, digest: string) => { mkdirSync(path.join(store, "images", id), { recursive: true }); writeFileSync(path.join(store, "images", id, "image.json"), JSON.stringify({ ref: `ghcr.io/omnirush-ai/box-base@${digest}`, digest })); utimesSync(path.join(store, "images", id, "image.json"), weekAgo, weekAgo); };
    image("cur", D("c")); image("prev", D("a")); image("old", D("0")); image("young", D("9"));
    utimesSync(path.join(store, "images", "young", "image.json"), new Date(), new Date());
    const stale = path.join(store, "tmp", "a1b2c3");
    mkdirSync(stale, { recursive: true });
    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(stale, old, old);
    const removed: string[] = [];
    const run = (async (_bin: string, args: string[]) => {
      if (args[0] === "rmimage") { removed.push(String(args[args.indexOf("--id") + 1])); return { code: 0, stdout: '{"ok":true}\n', stderr: "" }; }
      return { code: 0, stdout: "", stderr: "" };
    }) as unknown as RunCommand;
    const keep = keptImages(h, pinsOf("2026.10.2", "c"));
    await bwrapDriver.gcImages({ bin: "boxrun" } as unknown as BoxRuntime, { run, home: h, current: keep.refs, keep, used: new Set() });
    expect(removed).toEqual(["old"]);
    expect(existsSync(stale)).toBe(false);
  });

  test("WSL: images in the distro's store are collected; rootfs tarballs of other pins go", async () => {
    const h = home();
    const cache = path.join(h, "wsl", "cache");
    mkdirSync(cache, { recursive: true });
    const cur = "1".repeat(64), other = "2".repeat(64);
    writeFileSync(path.join(cache, `${cur}.tar.gz`), "x");
    writeFileSync(path.join(cache, `${other}.tar.gz`), "x");
    utimesSync(path.join(cache, `${other}.tar.gz`), new Date(Date.now() - 30 * 86_400_000), new Date(Date.now() - 30 * 86_400_000));
    const prev = "4".repeat(64);
    writeFileSync(path.join(cache, `${prev}.tar.gz`), "previous pins");
    const longAgo = Math.floor((Date.now() - 30 * 86_400_000) / 1000);
    const store = [`cur\t${longAgo}\t${JSON.stringify({ ref: `ghcr.io/omnirush-ai/box-base@${D("c")}`, digest: D("c") })}`, `old\t${longAgo}\t${JSON.stringify({ ref: `ghcr.io/omnirush-ai/box-base@${D("0")}`, digest: D("0") })}`].join("\n");
    const removed: string[] = [];
    const run = (async (_bin: string, args: string[]) => {
      if (args.includes("--list")) return { code: 0, stdout: "  NAME          STATE      VERSION\n* OmniRushBox   Stopped    2\n", stderr: "" };
      if (args.includes("/bin/sh")) return { code: 0, stdout: store + "\n", stderr: "" };
      if (args.includes("rmimage")) { removed.push(String(args[args.indexOf("--id") + 1])); return { code: 0, stdout: '{"ok":true}\n', stderr: "" }; }
      return { code: 1, stdout: "", stderr: "" };
    }) as unknown as RunCommand;
    const keep = keptImages(h, pinsOf("2026.10.2", "c"));
    await wslDriver.gcImages({ bin: "wsl.exe", distro: "OmniRushBox" } as unknown as BoxRuntime, { run, env: {}, home: h, current: keep.refs, keep, used: new Set(), pins: { assets: { amd64: { url: null, sha256: cur } } } } as never);
    expect(removed).toEqual(["old"]);
    expect(existsSync(path.join(cache, `${cur}.tar.gz`))).toBe(true);
    expect(existsSync(path.join(cache, `${other}.tar.gz`))).toBe(false);
    expect(existsSync(path.join(cache, `${prev}.tar.gz`))).toBe(true);
  });
});
