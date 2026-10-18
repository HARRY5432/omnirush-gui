// A box whose boxd stopped while the app ran (its idle limit, a crash, the WSL
// distro restarted): the project's box run starts it again when a shell call
// asks (boxsh writes boxes/<key>.revive) or at a turn's checkpoint, and says
// once when it cannot. Never this computer instead. No container runtime here.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { reviveFile, type Box } from "./box.js";
import { wslDriver } from "./backends/wsl.js";
import type { OpenContext } from "./backends/types.js";
import { boxRun, reviveError, type ReadyPlan } from "./launch.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = () => mkdtempSync(join(tmpdir(), "box-revive-"));
async function until(fn: () => boolean, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}

type FakeBox = { ready: boolean; error: string | null; endpoint: { host: string; port: number; token: string }; turns: number[]; failed: string | null; setTurn: (turn: number) => void; fail: (message: string) => FakeBox; checkpoint: () => Promise<unknown> };
function fakeBox(port: number, { ready = true, error = null }: { ready?: boolean; error?: string | null } = {}): FakeBox {
  const box: FakeBox = {
    ready, error, endpoint: { host: "127.0.0.1", port, token: "t" }, turns: [], failed: null,
    setTurn(turn) { box.turns.push(turn); },
    fail(message) { box.ready = false; box.failed = message; box.error = message; return box; },
    checkpoint: async () => ({ summary: { stats: { copied: 0, kept: 0 }, delta: { changed: [] }, bytes: 0 }, commit() {}, discard() {} }),
  };
  return box;
}

function fakePlan(first: FakeBox, next: FakeBox[]): ReadyPlan & { restarts: number } {
  const home = tmp();
  mkdirSync(join(home, "boxes"), { recursive: true });
  const plan = {
    box: { key: "k1", home, root: "/p", runtime: { name: "bwrap", backend: "bwrap", bin: "/x/boxrun" } },
    notice: null,
    shell: "/x/boxsh",
    restarts: 0,
    phase: "ready",
    start: async () => first as unknown as Box,
    restart: async () => { plan.restarts += 1; return next.shift() as unknown as Box; },
  };
  return plan as unknown as ReadyPlan & { restarts: number };
}

const pinger = (live: Set<number>) => async (endpoint: { port: number }) => (live.has(endpoint.port) ? { ok: true } : null);

describe("box revive", () => {
  test("a restart request from boxsh: a stopped boxd is started again, the request answered, the turn carried", async () => {
    const live = new Set([41001]);
    const plan = fakePlan(fakeBox(41001), [fakeBox(41002)]);
    const said: unknown[] = [];
    const run = boxRun(plan, { pollMs: 20, ping: pinger(live) as never, onRevive: (e) => said.push(e) });
    try {
      expect((await run.ready())?.endpoint?.port).toBe(41001);
      run.setTurn(3);
      live.clear();
      live.add(41002);
      const request = reviveFile(plan.box.home, "k1");
      writeFileSync(request, "{}");
      expect(await until(() => !existsSync(request))).toBe(true);
      expect(plan.restarts).toBe(1);
      expect(run.box?.endpoint?.port).toBe(41002);
      expect((run.box as unknown as FakeBox).turns).toEqual([3]);
      expect(said).toEqual([{ ok: true, why: "request" }]);
      expect(run.native).toBe(false);
    } finally {
      run.close();
    }
  });

  test("a box that cannot start again: failed with what to do, said once, never this computer", async () => {
    const down = () => fakeBox(0, { ready: false, error: "boxd did not answer in 30s" });
    const plan = fakePlan(fakeBox(41021), [down(), down()]);
    const said: Array<{ ok: boolean }> = [];
    const natives: string[] = [];
    const run = boxRun(plan, { pollMs: 20, ping: pinger(new Set()) as never, onRevive: (e) => said.push(e), onNative: (r) => natives.push(r) });
    try {
      await run.ready();
      const request = reviveFile(plan.box.home, "k1");
      writeFileSync(request, "{}");
      expect(await until(() => !existsSync(request))).toBe(true);
      expect((run.box as unknown as FakeBox).failed).toContain("could not start again (boxd did not answer in 30s)");
      expect((run.box as unknown as FakeBox).failed).toContain("Restart OmniRush");
      expect(await run.freeze("turn-2", { sessionId: "s1", turn: 2 })).toBeNull();
      expect(plan.restarts).toBe(2);
      expect(said.length).toBe(1);
      expect(said[0]!.ok).toBe(false);
      expect(natives).toEqual([]);
      expect(run.native).toBe(false);
    } finally {
      run.close();
    }
  });

  test("each turn starts with a box that answers: a stopped boxd is started before the checkpoint", async () => {
    const live = new Set([41031]);
    const plan = fakePlan(fakeBox(41031), [fakeBox(41032)]);
    const run = boxRun(plan, { pollMs: 10_000, ping: pinger(live) as never });
    try {
      expect(await run.freeze("turn-1", { sessionId: "s1", turn: 1 })).not.toBeNull();
      expect(plan.restarts).toBe(0);
      live.clear();
      expect(await run.freeze("turn-2", { sessionId: "s1", turn: 2 })).not.toBeNull();
      expect(plan.restarts).toBe(1);
      expect(run.box?.endpoint?.port).toBe(41032);
    } finally {
      run.close();
    }
  });

  test("reviveError names why and what to do", () => {
    const text = reviveError("dial tcp 127.0.0.1:44897: connect: connection refused");
    expect(text.startsWith("the sandbox stopped and could not start again (dial tcp 127.0.0.1:44897: connect: connection refused).")).toBe(true);
    expect(text).toContain("Restart OmniRush (installs are kept)");
    expect(reviveError("")).toContain("(it did not answer)");
  });

  test("WSL: a keeper still running whose boxd does not answer is replaced, not reused", async () => {
    const home = tmp();
    const bin = join(home, "bin");
    mkdirSync(join(bin, "linux-amd64"), { recursive: true });
    for (const name of ["boxrun", "boxd"]) writeFileSync(join(bin, "linux-amd64", name), "");
    const env = { OMNIRUSH_BOX_BIN_DIR: bin };
    const runtime = { name: "wsl", backend: "wsl", bin: "C:\\Windows\\System32\\wsl.exe", distro: "OmniRushBox", installed: true, arch: "amd64" };
    const run = async (_bin: string, args: string[]) => (args.includes("image")
      ? { code: 0, stdout: '{"present":true,"id":"img1","digest":"sha256:x","arch":"amd64","config":"cfg1"}\n', stderr: "" }
      : { code: 0, stdout: "", stderr: "" });
    let port = 40100;
    const spawned: Array<EventEmitter & { killed: boolean }> = [];
    const spawnImpl = (_bin: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, args, unref() {}, killed: false, kill() { child.killed = true; return true; } });
      const p = ++port;
      setTimeout(() => child.stdout.write(`{"ok":true,"reused":false,"pid":7,"port":${p}}\n`), 5);
      spawned.push(child);
      return child;
    };
    const live = new Set<number>();
    const ctx = {
      key: "wk1", name: "omnirush-box-wk1", root: "C:\\p", croot: "/c/p", runtime, run, home, runFolder: join(home, "run"), image: { ref: "r", pull: "r", stack: "base" },
      pull: false, shims: null, pkglog: null, env, platform: "win32", log: () => {}, onPulling: () => {}, spawnImpl, ping: pinger(live),
    } as unknown as OpenContext;
    const first = await wslDriver.open(ctx);
    if (!first.ok) throw new Error(first.error);
    live.add(first.endpoint.port);
    const again = await wslDriver.open(ctx);
    if (!again.ok) throw new Error(again.error);
    expect(again.endpoint.port).toBe(first.endpoint.port);
    expect(spawned.length).toBe(1);
    live.clear();
    const third = await wslDriver.open(ctx);
    if (!third.ok) throw new Error(third.error);
    expect(spawned.length).toBe(2);
    expect(spawned[0]!.killed).toBe(true);
    expect(third.endpoint.port).not.toBe(first.endpoint.port);
  });
});
