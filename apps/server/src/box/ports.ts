// Ported from the CLI (omnirush-cli src/box/ports.js); keep the two in step.
// Only types were added here.
//
// A server the agent starts in the box (`npm run dev` on :3000), at the same
// port on this computer's 127.0.0.1, for backends whose box has its own
// network (Docker, Podman, Apple container: driver.forwardsPorts === false).
// bubblewrap shares this computer's network, WSL forwards localhost, and the
// macOS VM forwards its guest's ports: they need none of this.
//
// While the box is in use, its listening ports are read from boxd every
// ~2 s; a new one (1024-65535, not boxd's own, free on this computer) gets a
// listener on 127.0.0.1:<port> here, and each connection to it goes through
// its own boxd stream (op "connect"). The listener closes when the box stops
// listening there or the box is let go. Nothing is ever bound beyond 127.0.0.1.

import net from "node:net";

import * as client from "./client.js";
import type { BoxEndpoint, BoxListener } from "./client.js";
import { BOX_PORT, type BoxLog } from "./common.js";

export const PORT_POLL_MS = 2_000;
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;
/** At most this many forwards at once (a box listening on hundreds of ports is not a dev server). */
export const PORT_FORWARDS_MAX = 32;

/** The one line a forward's opening is told with. */
export function portLine(port: number): string {
  return `Port ${port} in the sandbox is open on this computer at http://127.0.0.1:${port}`;
}

/** Whether a box listener is one to forward (`skip`: ports never forwarded). */
export function forwardable(port: number, skip: Set<number> = new Set([BOX_PORT])): boolean {
  return Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX && !skip.has(port);
}

/** Whether something on this computer answers at 127.0.0.1:<port>. */
export function hostAnswers(port: number, { timeoutMs = 300 }: { timeoutMs?: number } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Listen on 127.0.0.1:<port> (only there); resolves the server, or null when the port is taken. */
export function listenLoopback(port: number, onConnection: (socket: net.Socket) => void): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, onConnection);
    const onError = () => { server.close(); resolve(null); };
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.removeListener("error", onError);
      server.on("error", () => {});
      server.unref();
      resolve(server);
    });
  });
}

/** Join a connection on this computer to a boxd stream: both ways, each end half-closing the other. */
export function joinStreams(local: net.Socket, remote: net.Socket, head: Buffer = Buffer.alloc(0)): void {
  const both = () => { local.destroy(); remote.destroy(); };
  local.on("error", both);
  remote.on("error", both);
  local.on("close", () => remote.destroy());
  remote.on("close", () => { if (!local.destroyed) local.end(); });
  if (head.length) local.write(head);
  remote.pipe(local);
  local.pipe(remote);
  local.resume();
  remote.resume();
}

export type PortForwards = { tick: () => Promise<void>; ports: () => number[]; close: () => void };

export type PortForwardOptions = {
  /** boxd's address now; null while the box is not usable. */
  endpoint: () => BoxEndpoint | null;
  log?: BoxLog;
  onOpen?: (port: number, line: string) => void;
  onClose?: (port: number, why: string) => void;
  pollMs?: number;
  skip?: Set<number>;
  max?: number;
  list?: (endpoint: BoxEndpoint) => Promise<BoxListener[] | null>;
  connect?: (endpoint: BoxEndpoint, port: number) => Promise<{ socket: net.Socket; head: Buffer }>;
  hostBusy?: (port: number) => Promise<boolean>;
  listen?: (port: number, onConnection: (socket: net.Socket) => void) => Promise<net.Server | null>;
  /** Poll on its own (false: only tick(), tests). */
  timers?: boolean;
};

/** The forwards of one project's box; the poll runs until close(). */
export function portForwards({
  endpoint,
  log = () => {},
  onOpen = () => {},
  onClose = () => {},
  pollMs = PORT_POLL_MS,
  skip = new Set([BOX_PORT]),
  max = PORT_FORWARDS_MAX,
  list = (ep) => client.listPorts(ep),
  connect = (ep, port) => client.connectPort(ep, port),
  hostBusy = (port) => hostAnswers(port),
  listen = listenLoopback,
  timers = true,
}: PortForwardOptions): PortForwards {
  const forwards = new Map<number, { server: net.Server; sockets: Set<net.Socket> }>();
  const told = new Set<number>(); // ports already said to be taken here (said once)
  let closed = false;
  let running: Promise<void> | null = null;
  let unsupported = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const shut = (port: number, why: string) => {
    const forward = forwards.get(port);
    if (!forward) return;
    forwards.delete(port);
    forward.server.close();
    for (const socket of forward.sockets) socket.destroy();
    log("info", "box port forward closed", { port, why });
    onClose(port, why);
  };

  const taken = (port: number) => {
    if (told.has(port)) return;
    told.add(port);
    log("info", "box port not forwarded: in use on this computer", { port });
  };

  const open = async (port: number) => {
    // Something of this computer's own answers there: it stays this computer's.
    if (await hostBusy(port)) return taken(port);
    const sockets = new Set<net.Socket>();
    const server = await listen(port, (local) => {
      sockets.add(local);
      local.on("close", () => sockets.delete(local));
      const ep = endpoint();
      if (!ep) { local.destroy(); return; }
      connect(ep, port).then(({ socket, head }) => {
        if (local.destroyed || closed) { socket.destroy(); return; }
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        joinStreams(local, socket, head);
      }, (error: unknown) => {
        log("info", "box port connection failed", { port, error: error instanceof Error ? error.message : String(error) });
        local.destroy();
      });
    });
    if (!server) return taken(port);
    if (closed) { server.close(); return; }
    told.delete(port);
    forwards.set(port, { server, sockets });
    log("info", "box port forwarded", { port, line: portLine(port) });
    onOpen(port, portLine(port));
  };

  const once = async () => {
    const ep = endpoint();
    if (!ep || unsupported) return;
    let listening: BoxListener[] | null;
    try {
      listening = await list(ep);
    } catch {
      return; // the box does not answer now (stopped, restarting): the forwards stay until it says otherwise
    }
    if (listening === null) {
      unsupported = true;
      log("info", "box ports not forwarded: this sandbox was made by an older version (Reset sandbox gives it the new helper)");
      return;
    }
    const wanted = new Set(listening.map((item) => item.port).filter((port) => forwardable(port, skip)));
    for (const port of [...forwards.keys()]) if (!wanted.has(port)) shut(port, "gone");
    for (const port of [...wanted].sort((a, b) => a - b)) {
      if (closed) return;
      if (forwards.has(port)) continue;
      if (forwards.size >= max) break;
      await open(port);
    }
  };

  const tick = (): Promise<void> => {
    if (closed) return Promise.resolve();
    running ??= once()
      .catch((error: unknown) => log("warn", "box port forwards failed", { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = null; });
    return running;
  };

  if (timers) {
    timer = setInterval(() => { void tick(); }, pollMs);
    timer.unref?.();
    void tick();
  }

  return {
    tick,
    ports: () => [...forwards.keys()].sort((a, b) => a - b),
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      for (const port of [...forwards.keys()]) shut(port, "ended");
    },
  };
}
