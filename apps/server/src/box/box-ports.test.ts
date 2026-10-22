// Ported from the CLI (omnirush-cli test/box-ports.test.js): a server the
// agent starts in a box with its own network (Docker, Podman) answers at the
// same port on this computer's 127.0.0.1: the project's box run lists the
// box's listeners through boxd and carries each connection through a boxd
// stream (ports.ts). No container runtime here: a stand-in boxd speaks the
// wire format (box/go/proto) and dials local servers.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { connectPort, listPorts, type BoxEndpoint, type BoxListener } from "./client.js";
import { bwrapDriver } from "./backends/bwrap.js";
import { containerDriver } from "./backends/container.js";
import { wslDriver } from "./backends/wsl.js";
import type { Box } from "./box.js";
import { boxRun, type ReadyPlan } from "./launch.js";
import { forwardable, portForwards, portLine, type PortForwardOptions, type PortForwards } from "./ports.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => boolean, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}

function frame(kind: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);
  head[0] = kind.charCodeAt(0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A server that upper-cases what it reads and answers with it once the client half-closes. */
async function upperServer(): Promise<net.Server> {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const parts: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => parts.push(chunk));
    socket.on("end", () => socket.end(Buffer.concat(parts).toString("utf8").toUpperCase()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
const portOf = (server: net.Server) => (server.address() as net.AddressInfo).port;

/** A stand-in boxd: op "ports" answers `ports()` ("unknown op" when `old`), op "connect" dials `target(port)` here. */
async function fakeBoxd({ token = "tok", ports = () => [] as BoxListener[], target = (p: number) => p, old = false }: { token?: string; ports?: () => BoxListener[]; target?: (port: number) => number; old?: boolean } = {}) {
  const calls: Array<{ op: string; port?: number; token?: string }> = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const nl = buffered.indexOf(0x0a);
      if (nl < 0) return;
      socket.removeListener("data", onData);
      const req = JSON.parse(buffered.subarray(0, nl).toString("utf8"));
      const rest = buffered.subarray(nl + 1);
      calls.push(req);
      const fail = (text: string) => socket.end(Buffer.concat([frame("E", Buffer.from(text)), frame("x", Buffer.from(JSON.stringify({ code: 125 })))]));
      if (req.token !== token) return fail("unauthorized");
      if (old || (req.op !== "ports" && req.op !== "connect")) return fail(`unknown op "${req.op}"`);
      if (req.op === "ports") {
        socket.end(Buffer.concat([frame("d", Buffer.from(JSON.stringify(ports()))), frame("x", Buffer.from(JSON.stringify({ code: 0 })))]));
        return;
      }
      const inner = net.connect({ host: "127.0.0.1", port: target(req.port), allowHalfOpen: true });
      inner.once("error", () => fail(`nothing answers on port ${req.port} in the sandbox`));
      inner.once("connect", () => {
        socket.write(frame("d", Buffer.from('{"ok":true}')));
        if (rest.length) inner.write(rest);
        socket.pipe(inner);
        inner.pipe(socket);
      });
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint: BoxEndpoint = { host: "127.0.0.1", port: portOf(server), token };
  return { server, calls, endpoint };
}

/** Send `text` to 127.0.0.1:<port>, half-close, read the answer. */
function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    const parts: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => parts.push(chunk));
    socket.on("end", () => { socket.end(); resolve(Buffer.concat(parts).toString("utf8")); });
    socket.on("error", reject);
    socket.once("connect", () => socket.end(text));
  });
}

describe("box ports on this computer", () => {
  test("the backends that need forwards say so; bwrap and the WSL distro share or forward localhost", () => {
    expect(containerDriver.forwardsPorts).toBe(false);
    expect(bwrapDriver.forwardsPorts).not.toBe(false);
    expect(wslDriver.forwardsPorts).not.toBe(false);
  });

  test("which box ports are forwarded, and the one line", () => {
    expect(forwardable(8765)).toBe(true);
    expect(forwardable(1023)).toBe(false);
    expect(forwardable(65536)).toBe(false);
    expect(forwardable(7777)).toBe(false);
    expect(forwardable(3000, new Set())).toBe(true);
    expect(portLine(8765)).toBe("Port 8765 in the sandbox is open on this computer at http://127.0.0.1:8765");
  });

  test("client: ports lists the box's listeners; connect streams both ways; an old boxd reads as null", async () => {
    const inner = await upperServer();
    const boxd = await fakeBoxd({ ports: () => [{ port: 3000, addr: "0.0.0.0" }], target: () => portOf(inner) });
    try {
      expect(await listPorts(boxd.endpoint)).toEqual([{ port: 3000, addr: "0.0.0.0" }]);
      const { socket, head } = await connectPort(boxd.endpoint, 3000);
      expect(head.length).toBe(0);
      const parts: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => parts.push(chunk));
      const ended = new Promise((resolve) => socket.on("end", resolve));
      socket.resume();
      socket.end("hello box");
      await ended;
      expect(Buffer.concat(parts).toString("utf8")).toBe("HELLO BOX");
      await expect(connectPort({ ...boxd.endpoint, token: "nope" }, 3000)).rejects.toThrow(/unauthorized/);
    } finally {
      boxd.server.close();
      inner.close();
    }
    const old = await fakeBoxd({ old: true });
    try {
      expect(await listPorts(old.endpoint)).toBeNull();
    } finally {
      old.server.close();
    }
  });

  test("a new box listener opens on 127.0.0.1 here, carries connections, closes when it goes", async () => {
    const port = await freePort();
    const inner = await upperServer();
    let listening: BoxListener[] = [{ port, addr: "0.0.0.0" }, { port: 80, addr: "0.0.0.0" }, { port: 7777, addr: "0.0.0.0" }];
    const boxd = await fakeBoxd({ ports: () => listening, target: () => portOf(inner) });
    const opened: Array<[number, string]> = [];
    const closed: Array<[number, string]> = [];
    const forwards = portForwards({ endpoint: () => boxd.endpoint, timers: false, onOpen: (p, line) => opened.push([p, line]), onClose: (p, why) => closed.push([p, why]) });
    try {
      await forwards.tick();
      expect(forwards.ports()).toEqual([port]);
      expect(opened).toEqual([[port, portLine(port)]]);
      expect(await roundTrip(port, "page please")).toBe("PAGE PLEASE");
      expect(await Promise.all([roundTrip(port, "one"), roundTrip(port, "two")])).toEqual(["ONE", "TWO"]);
      expect(boxd.calls.filter((c) => c.op === "connect").length).toBe(3);
      listening = [];
      await forwards.tick();
      expect(forwards.ports()).toEqual([]);
      expect(closed).toEqual([[port, "gone"]]);
      await expect(roundTrip(port, "x")).rejects.toThrow();
    } finally {
      forwards.close();
      boxd.server.close();
      inner.close();
    }
  });

  test("a port this computer already uses stays its own (said once); nothing beyond 127.0.0.1", async () => {
    const mine = await upperServer();
    const port = portOf(mine);
    const inner = await upperServer();
    const free = await freePort();
    const boxd = await fakeBoxd({ ports: () => [{ port, addr: "0.0.0.0" }, { port: free, addr: "127.0.0.1" }], target: () => portOf(inner) });
    const logged: Array<[string, string]> = [];
    const forwards = portForwards({ endpoint: () => boxd.endpoint, timers: false, log: (level, message) => logged.push([level, message]) });
    try {
      await forwards.tick();
      await forwards.tick();
      expect(forwards.ports()).toEqual([free]);
      expect(logged.filter((l) => l[1] === "box port not forwarded: in use on this computer").length).toBe(1);
      expect(await roundTrip(port, "host")).toBe("HOST");
      const other = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
      if (other) {
        await expect(new Promise<void>((resolve, reject) => {
          const s = net.connect({ host: other.address, port: free });
          s.once("connect", () => { s.destroy(); resolve(); });
          s.once("error", reject);
        })).rejects.toThrow();
      }
    } finally {
      forwards.close();
      boxd.server.close();
      inner.close();
      mine.close();
    }
  });

  test("none while the box is not usable; an old boxd stops the poll; close() ends every forward", async () => {
    const port = await freePort();
    const inner = await upperServer();
    const boxd = await fakeBoxd({ ports: () => [{ port, addr: "0.0.0.0" }], target: () => portOf(inner) });
    let ep: BoxEndpoint | null = null;
    const forwards = portForwards({ endpoint: () => ep, timers: false });
    try {
      await forwards.tick();
      expect(boxd.calls.length).toBe(0);
      ep = boxd.endpoint;
      await forwards.tick();
      expect(forwards.ports()).toEqual([port]);
      ep = { ...boxd.endpoint, port: await freePort() };
      await forwards.tick();
      expect(forwards.ports()).toEqual([port]);
      forwards.close();
      expect(forwards.ports()).toEqual([]);
      await expect(roundTrip(port, "x")).rejects.toThrow();
    } finally {
      forwards.close();
      boxd.server.close();
      inner.close();
    }
    const old = await fakeBoxd({ old: true });
    const logged: string[] = [];
    const legacy = portForwards({ endpoint: () => old.endpoint, timers: false, log: (_level, message) => logged.push(message) });
    try {
      await legacy.tick();
      await legacy.tick();
      expect(old.calls.length).toBe(1);
      expect(logged[0]).toMatch(/older version/);
    } finally {
      legacy.close();
      old.server.close();
    }
  });

  test("the poll runs on its own every pollMs", async () => {
    const port = await freePort();
    const inner = await upperServer();
    let listening: BoxListener[] = [];
    const boxd = await fakeBoxd({ ports: () => listening, target: () => portOf(inner) });
    const forwards = portForwards({ endpoint: () => boxd.endpoint, pollMs: 30 });
    try {
      listening = [{ port, addr: "::" }];
      expect(await until(() => forwards.ports().includes(port))).toBe(true);
      expect(await roundTrip(port, "late server")).toBe("LATE SERVER");
    } finally {
      forwards.close();
      boxd.server.close();
      inner.close();
    }
  });

  test("boxRun: forwards only for a backend with its own network, unless OMNIRUSH_BOX_PORTS=off; closed with the run", async () => {
    const box = { ready: true, error: null, endpoint: { host: "127.0.0.1", port: 1, token: "t" }, setTurn() {} };
    const plan = (backend: string): ReadyPlan => {
      const home = mkdtempSync(path.join(os.tmpdir(), "box-ports-"));
      mkdirSync(path.join(home, "boxes"), { recursive: true });
      return { box: { key: "k1", home, root: "/p", runtime: { name: backend, backend, bin: "/x/rt" } }, notice: null, shell: "/x/boxsh", phase: "ready", start: async () => box as unknown as Box } as unknown as ReadyPlan;
    };
    const made: Array<{ opts: PortForwardOptions; closed: boolean }> = [];
    const stub = (opts: PortForwardOptions): PortForwards => {
      const entry = { opts, closed: false };
      made.push(entry);
      return { tick: async () => {}, ports: () => [4000], close() { entry.closed = true; } };
    };
    const said: unknown[] = [];
    const docker = boxRun(plan("docker"), { forwards: stub, env: {}, ping: (async () => ({})) as never, onPort: (e) => said.push(e) });
    expect(made.length).toBe(1);
    await docker.ready();
    expect(made[0]!.opts.endpoint()).toEqual(box.endpoint);
    expect(docker.forwardedPorts?.()).toEqual([4000]);
    made[0]!.opts.onOpen!(3000, portLine(3000));
    expect(said).toEqual([{ port: 3000, line: portLine(3000), open: true }]);
    docker.close();
    expect(made[0]!.closed).toBe(true);
    expect(made[0]!.opts.endpoint()).toBeNull();
    boxRun(plan("bwrap"), { forwards: stub, env: {} }).close();
    boxRun(plan("wsl"), { forwards: stub, env: {} }).close();
    boxRun(plan("podman"), { forwards: stub, env: { OMNIRUSH_BOX_PORTS: "off" } }).close();
    expect(made.length).toBe(1);
  });
});
