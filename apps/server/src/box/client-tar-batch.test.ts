import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { Box, type BoxRuntime } from "./box.js";
import { REQUEST_LINE_BUDGET, REQUEST_LINE_MAX, archiveBody, batchPaths, byteSorted, lineOverhead, request, stat, tarTo, walk, type BoxEndpoint } from "./client.js";

// A snapshot's path lists in boxd requests (client.ts; the CLI's src/box/client.js
// has the same): boxd reads a request line of at most 4 MiB (box/go/proto
// ReadRequest in the boxd builds out there), so tar, stat and walk send long
// lists in batches, and the tar parts land in one file as one archive (each
// part but the last loses its end-of-archive marker). A checkpoint whose tar
// fails anyway is marked incomplete and the turn goes on. A fake boxd speaks
// the wire format and writes real tars (ustar + PAX, ended as Go's archive/tar ends them).

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const frame = (kind: number, payload: Buffer) => {
  const head = Buffer.alloc(5);
  head[0] = kind;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};

// --- a small tar writer (what boxd's writeTar emits: PAX for long names, two zero blocks at the end) ---

function header(name: string, { type = "0", size = 0 }: { type?: string; size?: number } = {}): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}
const pad = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}
/** One entry: a folder for a name ending in "/", else a file holding `content`. */
function entry(name: string, content: Buffer): Buffer {
  const parts: Buffer[] = [];
  const isDir = name.endsWith("/");
  if (Buffer.byteLength(name) > 100) {
    const pax = Buffer.from(paxRecord("path", name));
    parts.push(header("PaxHeaders/x", { type: "x", size: pax.length }), pad(pax));
  }
  parts.push(header(name, { type: isDir ? "5" : "0", size: isDir ? 0 : content.length }));
  if (!isDir && content.length) parts.push(pad(content));
  return Buffer.concat(parts);
}
const contentOf = (p: string) => (p.endsWith("/zeros") ? Buffer.alloc(1024) : Buffer.from(p));
function tarOf(paths: string[], { padding = 0 }: { padding?: number } = {}): Buffer {
  const sorted = [...paths].sort();
  return Buffer.concat([...sorted.map((p) => entry(p.slice(1), contentOf(p))), Buffer.alloc(1024 + padding)]);
}

/** Member names of a tar (and their data), read block by block; stops at the first zero block. */
function members(buf: Buffer): { members: Array<{ name: string; data: Buffer }>; end: number } {
  const out: Array<{ name: string; data: Buffer }> = [];
  let at = 0;
  let longName: string | null = null;
  while (at + 512 <= buf.length) {
    const block = buf.subarray(at, at + 512);
    if (!block.some((byte) => byte !== 0)) break;
    const size = parseInt(block.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim() || "0", 8);
    const type = String.fromCharCode(block[156] ?? 0);
    const data = buf.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") { longName = /\d+ path=(.*)\n/.exec(data.toString("utf8"))?.[1] ?? null; continue; }
    out.push({ name: longName ?? block.subarray(0, 100).toString("utf8").replace(/\0.*$/s, ""), data: Buffer.from(data) });
    longName = null;
  }
  return { members: out, end: at };
}

// --- a fake boxd ---------------------------------------------------------------------------

type Change = { kind: "A"; path: string; type: string; size: number; mode: number; mtime_ns: number; ctime_ns: number; ino: number; uid: number; gid: number };

/** boxd's request-line limit and its tar/stat/walk/changes ops. `fail(paths)` may answer a tar request with an error instead. */
async function fakeBoxd({ padding = 0, fail = () => null, changes = [], limit = REQUEST_LINE_MAX }: { padding?: number; fail?: (paths: string[]) => string | null; changes?: Change[]; limit?: number } = {}): Promise<{ box: BoxEndpoint; seen: { lines: number[]; ops: Array<{ op: string; count: number }> } }> {
  const seen = { lines: [] as number[], ops: [] as Array<{ op: string; count: number }> };
  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
    let buffered = Buffer.alloc(0);
    let done = false;
    socket.on("data", (chunk: Buffer) => {
      if (done) return;
      buffered = Buffer.concat([buffered, chunk]);
      const nl = buffered.indexOf(0x0a);
      // boxd: readLine(r, 4<<20) counts the line without its newline.
      if ((nl < 0 ? buffered.length : nl) > limit) {
        done = true;
        socket.end(Buffer.concat([frame(0x45, Buffer.from("request line too long")), frame(0x78, Buffer.from(JSON.stringify({ code: 125, ms: 0 })))]));
        seen.lines.push(nl < 0 ? buffered.length : nl);
        return;
      }
      if (nl < 0) return;
      done = true;
      seen.lines.push(nl);
      const req = JSON.parse(buffered.subarray(0, nl).toString("utf8")) as { op: string; paths?: string[]; wait?: number };
      const paths = req.paths ?? [];
      seen.ops.push({ op: req.op, count: paths.length });
      const exit = (code = 0) => frame(0x78, Buffer.from(JSON.stringify({ code, ms: 2 })));
      if (req.op === "tar") {
        const error = fail(paths);
        if (error) { socket.end(Buffer.concat([frame(0x45, Buffer.from(error)), exit(125)])); return; }
        const tar = tarOf(paths, { padding });
        const out: Buffer[] = [];
        // In odd-sized frames, so no block boundary lines up with a frame.
        for (let i = 0; i < tar.length; i += 7777) out.push(frame(0x64, tar.subarray(i, i + 7777)));
        socket.end(Buffer.concat([...out, frame(0x65, Buffer.from("busy: a command was running during the snapshot\n")), exit()]));
      } else if (req.op === "stat") {
        socket.end(Buffer.concat([frame(0x64, Buffer.from(JSON.stringify(paths.map((p) => ({ path: p, type: "file", size: 1, uid: 0, gid: 0 }))))), exit()]));
      } else if (req.op === "walk") {
        const entries = paths.map((p) => ({ path: `${p}/x`, type: "file", size: 1, uid: 0, gid: 0 }));
        const wait = req.wait ?? 400_000;
        socket.end(Buffer.concat([frame(0x64, Buffer.from(JSON.stringify({ entries: entries.slice(0, wait), truncated: entries.length > wait }))), exit()]));
      } else if (req.op === "changes") {
        socket.end(Buffer.concat([frame(0x64, Buffer.from(JSON.stringify(changes))), exit()]));
      } else {
        socket.end(exit(0));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  const address = server.address();
  return { box: { host: "127.0.0.1", port: typeof address === "object" && address ? address.port : 0, token: "tok" }, seen };
}

const tmp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "omnirush-tarbatch-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** n paths of node_modules depth (~130 bytes each), one folder per 1000 files. */
function manyPaths(n: number, prefix = "/root/app/node_modules"): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    if (i % 1000 === 0) out.push(`${prefix}/pkg-${i / 1000}`);
    out.push(`${prefix}/pkg-${Math.floor(i / 1000)}/lib/some/deeper/folder/structure/that/node/packages/have/file-${String(i).padStart(6, "0")}.js`);
  }
  return out;
}

describe("box path lists in requests", () => {
  test("batchPaths keeps every request line within the budget, in order, and leaves out a path no line can carry", () => {
    const paths = manyPaths(5000);
    const overhead = 100;
    const { batches, skipped } = batchPaths(paths, { budget: 64 * 1024, overhead });
    expect(skipped).toEqual([]);
    expect(batches.flat()).toEqual(paths);
    expect(batches.length).toBeGreaterThan(5);
    for (const part of batches) expect(overhead - 2 + Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(64 * 1024);
    const huge = `/${"a".repeat(70 * 1024)}`;
    const second = batchPaths(["/a", huge, "/b"], { budget: 64 * 1024, overhead });
    expect(second.batches).toEqual([["/a", "/b"]]);
    expect(second.skipped).toEqual([{ path: huge, reason: "path_too_long" }]);
  });

  test("batchPaths budgets by encoded bytes, not by count (multi-byte names, escapes)", () => {
    const paths = Array.from({ length: 300 }, (_, i) => `/tmp/ü"\\名前-${i}`);
    const { batches } = batchPaths(paths, { budget: 2048, overhead: 50 });
    for (const part of batches) expect(48 + Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(2048);
    expect(batches.flat()).toEqual(paths);
  });

  test("byteSorted is Go's byte order (a folder before what is in it, astral after BMP text)", () => {
    expect(byteSorted(["/a/b", "/a", "/a-b", "/\u{1F600}", "/�"])).toEqual(["/a", "/a-b", "/a/b", "/�", "/\u{1F600}"]);
  });

  test("the exact 4 MiB boundary: a line of 4 MiB is one request, one byte more is two, and boxd takes both", async () => {
    const { box, seen } = await fakeBoxd();
    const overhead = lineOverhead(box, { op: "tar" });
    // `overhead` holds the empty list's "[]" and the newline; boxd counts the line without its newline.
    const lineOf = (paths: string[]) => overhead - 3 + Buffer.byteLength(JSON.stringify(paths));
    const fill = (lineBytes: number) => ["/a", `/${"b".repeat(lineBytes - lineOf(["/a", "/"]))}`];
    const exact = fill(REQUEST_LINE_MAX);
    expect(lineOf(exact)).toBe(REQUEST_LINE_MAX);
    // The budget at boxd's limit (+1: the budget counts the newline).
    const budget = REQUEST_LINE_MAX + 1;
    expect(batchPaths(exact, { budget, overhead }).batches.length).toBe(1);
    const over = fill(REQUEST_LINE_MAX + 1);
    expect(batchPaths(over, { budget, overhead }).batches.length).toBe(2);
    // One request with every path (as before): boxd refuses the line one byte past 4 MiB.
    const old = await request(box, { op: "tar", paths: over });
    expect(old.exit.code).toBe(125);
    expect(old.stderr).toMatch(/request line too long/);
    const dir = tmp();
    await tarTo(box, exact, path.join(dir, "exact.tar"), { budget });
    await tarTo(box, over, path.join(dir, "over.tar"), { budget });
    expect(seen.lines.slice(-3).every((n) => n <= REQUEST_LINE_MAX)).toBe(true);
    expect(seen.lines.at(-3)).toBe(REQUEST_LINE_MAX);
    expect(members(readFileSync(path.join(dir, "exact.tar"))).members.map((m) => `/${m.name}`)).toEqual(exact);
    expect(members(readFileSync(path.join(dir, "over.tar"))).members.map((m) => `/${m.name}`)).toEqual(over);
  });

  test("tarTo: 40k paths (~5 MiB of names) go in parts under 3 MiB and land as one archive with every member", async () => {
    const paths = [...manyPaths(40_000), "/root/app/node_modules/pkg-0/zeros"];
    const { box, seen } = await fakeBoxd();
    const file = path.join(tmp(), "turn-2.tar");
    // Shuffled: tarTo sorts (a folder before what is in it, across parts too).
    const result = await tarTo(box, [...paths].sort(() => Math.random() - 0.5), file);
    const tarOps = seen.ops.filter((item) => item.op === "tar");
    expect(tarOps.length).toBeGreaterThanOrEqual(2);
    for (const n of seen.lines) expect(n).toBeLessThan(REQUEST_LINE_BUDGET);
    const written = readFileSync(file);
    expect(result.bytes).toBe(written.length);
    expect(result.sha256).toBe(createHash("sha256").update(written).digest("hex"));
    expect(result.ms).toBe(2 * tarOps.length);
    expect(result.warning).toBe("busy: a command was running during the snapshot");
    const read = members(written);
    const sorted = byteSorted(paths);
    expect(read.members.map((m) => `/${m.name}`)).toEqual(sorted);
    for (const m of read.members.slice(0, 50)) expect(m.data.equals(contentOf(`/${m.name}`))).toBe(true);
    // One end-of-archive marker, at the very end.
    expect(read.end).toBe(written.length - 1024);
    expect(written.subarray(read.end).some((byte) => byte !== 0)).toBe(false);
    // GNU tar and Python's tarfile (what the backend reads checkpoint tars with) see every member.
    const gnu = spawnSync("tar", ["-tf", file], { maxBuffer: 64 << 20 });
    if (gnu.status === 0) expect(gnu.stdout.toString().trim().split("\n").length).toBe(sorted.length);
    const py = spawnSync("python3", ["-I", "-c", "import sys,tarfile\nwith tarfile.open(sys.argv[1], mode='r|*') as t: print(sum(1 for _ in t))", file]);
    if (py.status === 0) expect(Number(py.stdout.toString().trim())).toBe(sorted.length);
  }, 60_000);

  test("tarTo: a part padded past its two zero blocks (a 10 KiB record) still joins into one archive", async () => {
    const paths = manyPaths(3000);
    const { box, seen } = await fakeBoxd({ padding: 9 * 1024 });
    const file = path.join(tmp(), "padded.tar");
    await tarTo(box, paths, file, { budget: 64 * 1024 });
    expect(seen.ops.length).toBeGreaterThan(3);
    const written = readFileSync(file);
    const read = members(written);
    expect(read.members.length).toBe(paths.length);
    // The last part keeps its own ending (marker + padding); no zero block before it.
    expect(read.end).toBe(written.length - 1024 - 9 * 1024);
  });

  test("tarTo: a part that fails fails the whole tar, naming the part", async () => {
    let calls = 0;
    const { box } = await fakeBoxd({ fail: () => ((calls += 1) === 2 ? "open /x: input/output error" : null) });
    await expect(tarTo(box, manyPaths(3000), path.join(tmp(), "f.tar"), { budget: 64 * 1024 })).rejects.toThrow(/box tar failed: open \/x: input\/output error \(part 2 of \d+\)/);
  });

  test("archiveBody refuses a part with no end-of-archive marker, or data after it", () => {
    const whole = tarOf(["/a", "/b"]);
    const body = archiveBody();
    body.push(whole.subarray(0, whole.length - 1024));
    expect(() => body.end()).toThrow(/before its end-of-archive marker/);
    const after = archiveBody();
    expect(() => after.push(Buffer.concat([whole, Buffer.from("x")]))).toThrow(/after the end of the archive/);
    const ok = archiveBody();
    const out = Buffer.concat(ok.push(whole));
    ok.end();
    expect(out.length).toBe(whole.length - 1024);
  });

  test("stat and walk batch long lists by bytes and keep their answers in order", async () => {
    const { box, seen } = await fakeBoxd();
    const paths = manyPaths(4000);
    const stats = await stat(box, paths, { budget: 64 * 1024 });
    expect(stats.map((item) => item.path)).toEqual(paths);
    expect(seen.ops.filter((item) => item.op === "stat").length).toBeGreaterThan(3);
    const roots = Array.from({ length: 2000 }, (_, i) => `/root/app/packages/p${i}/node_modules`);
    const walked = await walk(box, roots, { budget: 16 * 1024, max: 1500 });
    expect(walked.entries?.length).toBe(1500);
    expect(walked.truncated).toBe(true);
    const all = await walk(box, roots, { budget: 16 * 1024 });
    expect(all.entries?.length).toBe(2000);
    expect(all.truncated).toBe(false);
  });
});

// --- the checkpoint ------------------------------------------------------------------------

function fakeBox(endpoint: BoxEndpoint) {
  const work = tmp();
  const root = path.join(work, "proj");
  mkdirSync(root);
  const logs: Array<{ level: string; message: string }> = [];
  const box = new Box({
    key: "k1", name: "omnirush-box-k1", root, croot: root, runtime: { name: "docker" } as BoxRuntime, home: path.join(work, "home"), runFolder: path.join(work, "run"),
    run: (() => { throw new Error("no runtime"); }) as never, log: (level, message) => logs.push({ level, message }), platform: "linux", env: {},
  });
  box.connect({ ...endpoint, uid: 1000, gid: 1000, containerId: "c1", imageId: "sha256:img" });
  box.state = "ready";
  return { box, logs, snaps: path.join(work, "snaps") };
}

const changeOf = (p: string): Change => ({ kind: "A", path: p, type: p.includes("/pkg-") && !p.endsWith(".js") ? "dir" : "file", size: 10, mode: 0o644, mtime_ns: 1, ctime_ns: 1, ino: 1, uid: 0, gid: 0 });

describe("box checkpoint with many changed files", () => {
  test("a checkpoint of 40k new files (npm install in turn 1) writes them all in one tar", async () => {
    const paths = manyPaths(40_000, "/usr/local/lib/node_modules");
    const { box: endpoint } = await fakeBoxd({ changes: paths.map(changeOf) });
    const { box, snaps } = fakeBox(endpoint);
    const taken = await box.checkpoint(snaps, 2);
    expect(taken.summary.checkpoint.status).toBe("complete");
    expect(taken.summary.delta.changed.length).toBe(paths.length);
    taken.commit();
    const written = readFileSync(path.join(snaps, "turn-2.tar"));
    expect(taken.summary.sha256).toBe(createHash("sha256").update(written).digest("hex"));
    expect(members(written).members.length).toBe(paths.length);
  }, 60_000);

  test("a checkpoint whose tar fails is incomplete, the turn goes on, and the next one tries the paths again", async () => {
    const paths = manyPaths(2000, "/usr/local/lib/node_modules");
    let failing = true;
    const { box: endpoint } = await fakeBoxd({ changes: paths.map(changeOf), fail: () => (failing ? "request line too long" : null) });
    const { box, logs, snaps } = fakeBox(endpoint);
    const first = await box.checkpoint(snaps, 2);
    const s = first.summary;
    expect(s.checkpoint.status).toBe("incomplete");
    expect(s.tar).toBeNull();
    expect(s.delta.changed).toEqual([]);
    expect(s.skipped.filter((item) => item.reason === "tar_failed").length).toBe(paths.length);
    expect(s.stats.tar_error).toMatch(/request line too long/);
    expect(logs.some((line) => line.level === "warn" && line.message === "box checkpoint tar failed")).toBe(true);
    first.commit();
    failing = false;
    const second = await box.checkpoint(snaps, 3);
    expect(second.summary.checkpoint.status).toBe("complete");
    expect(second.summary.delta.parent).toBe(s.checkpoint.id as string);
    expect(second.summary.delta.changed.length).toBe(paths.length);
  });
});
