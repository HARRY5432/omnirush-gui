// Ported from the CLI (omnirush-cli src/box/client.js, feat/local-box);
// keep the two in step. Only types were added here.
//
// The host side of boxd's wire format (box/go/proto): one TCP connection per
// operation, a JSON request line, then type+length frames. The engine's
// shell calls go through the native client (boxsh); this one is for the
// launcher: readiness, the snapshot's stat/walk/tar, and toolchain probes.

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import net from "node:net";

export const PROTO_VERSION = 1;
const T = { stdout: 0x6f, stderr: 0x65, exit: 0x78, data: 0x64, fail: 0x45, stdinEof: 0x63, signal: 0x73 };

export type BoxEndpoint = { host?: string; port: number; token: string };
export type BoxRequest = { op: string; argv?: string[]; cwd?: string; env?: Record<string, string>; paths?: string[]; wait?: number; root?: boolean };
export type BoxExit = { code: number; ms?: number };
export type BoxReply = { exit: BoxExit; stdout: string; stderr: string; data: Buffer };
export type BoxStat = { path: string; type: string; mode?: number; size?: number; uid?: number; gid?: number; link?: string; mtime_ns?: number | string; ctime_ns?: number | string };
export type BoxChange = BoxStat & { kind: "A" | "C" | "D" };

function frame(kind: number, payload = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);
  head[0] = kind;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/**
 * One operation: resolves { exit, stdout, stderr, data } where data is the
 * concatenated Data frames (unless onData takes them). Rejects when the box
 * cannot be reached or closes early. An onData that returns a promise holds
 * the connection (backpressure) until it settles; a rejection fails the call.
 */
export function request(
  box: BoxEndpoint,
  req: BoxRequest,
  { onData, onStdout, onStderr, timeoutMs = 30_000, signal }: { onData?: (chunk: Buffer) => Promise<unknown> | null | void; onStdout?: (chunk: Buffer) => void; onStderr?: (chunk: Buffer) => void; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<BoxReply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: box.host || "127.0.0.1", port: box.port });
    socket.setNoDelay(true);
    let buffered: Buffer = Buffer.alloc(0);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const data: Buffer[] = [];
    let settled = false;
    const finish = <V>(fn: (value: V) => void, value: V) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      socket.destroy();
      fn(value);
    };
    const onAbort = () => finish(reject, new Error("aborted"));
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(reject, new Error(`box ${req.op} timed out after ${timeoutMs} ms`)), timeoutMs);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ v: PROTO_VERSION, token: box.token, ...req })}\n`);
      if (req.op === "exec") socket.write(frame(T.stdinEof));
    });
    socket.on("error", (error) => finish(reject, error));
    socket.on("close", () => finish(reject, new Error(`box closed the ${req.op} connection early`)));
    socket.on("data", (chunk: Buffer) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      while (buffered.length >= 5) {
        const size = buffered.readUInt32BE(1);
        if (buffered.length < 5 + size) break;
        const kind = buffered[0];
        const payload = buffered.subarray(5, 5 + size);
        buffered = buffered.subarray(5 + size);
        if (kind === T.stdout) (onStdout ? onStdout(payload) : out.push(Buffer.from(payload)));
        else if (kind === T.stderr || kind === T.fail) (onStderr ? onStderr(payload) : err.push(Buffer.from(payload)));
        else if (kind === T.data) {
          if (onData) {
            let wait: Promise<unknown> | null | void;
            try { wait = onData(payload); } catch (error) { finish(reject, error); return; }
            if (wait && typeof wait.then === "function" && !socket.isPaused()) {
              socket.pause();
              wait.then(() => { if (!settled) socket.resume(); }, (error: unknown) => finish(reject, error));
            }
          } else data.push(Buffer.from(payload));
        } else if (kind === T.exit) {
          let exit: BoxExit = { code: 0 };
          try { exit = JSON.parse(payload.toString("utf8")); } catch { /* keep */ }
          finish(resolve, { exit, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), data: Buffer.concat(data) });
          return;
        }
      }
    });
  });
}

/** boxd's identity, or null when it does not answer. */
export async function ping(box: BoxEndpoint, { timeoutMs = 2_000 }: { timeoutMs?: number } = {}): Promise<Record<string, unknown> | null> {
  try {
    const result = await request(box, { op: "ping" }, { timeoutMs });
    return JSON.parse(result.data.toString("utf8"));
  } catch {
    return null;
  }
}

export type ExecResult = { code: number; stdout: string; stderr: string; ms?: number };

/** Run a command in the box: { code, stdout, stderr, ms }. */
export async function exec(box: BoxEndpoint, argv: string[], { cwd, env, root = false, timeoutMs = 60_000 }: { cwd?: string; env?: Record<string, string>; root?: boolean; timeoutMs?: number } = {}): Promise<ExecResult> {
  const result = await request(box, { op: "exec", argv, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}), ...(root ? { root: true } : {}) }, { timeoutMs });
  return { code: result.exit.code, stdout: result.stdout, stderr: result.stderr, ms: result.exit.ms };
}

/** lstat of each path, in order (type "missing" for a path that is gone). */
export async function stat(box: BoxEndpoint, paths: string[], { timeoutMs = 60_000, budget = REQUEST_LINE_BUDGET }: { timeoutMs?: number; budget?: number } = {}): Promise<BoxStat[]> {
  const out: BoxStat[] = [];
  const { batches, skipped } = batchPaths(paths, { budget, overhead: lineOverhead(box, { op: "stat" }) });
  // A path no request can carry (never in practice: a path is at most 4 KiB) is "other": not looked at.
  const tooLong = new Set(skipped.map((item) => item.path));
  const answers = new Map<string, BoxStat>();
  for (const part of batches) {
    const result = await request(box, { op: "stat", paths: part }, { timeoutMs });
    const entries: BoxStat[] = JSON.parse(result.data.toString("utf8"));
    if (!tooLong.size) out.push(...entries);
    else for (const entry of entries) answers.set(entry.path, entry);
  }
  if (!tooLong.size) return out;
  return paths.map((p) => answers.get(p) ?? { path: p, type: "other", uid: 0, gid: 0 });
}

/**
 * What differs from the image ({ kind: A|C|D, path, ...stat }), walked by
 * boxd against the index it took at the box's first start; `skip` folders
 * are not walked (their `keep` subfolders are). Null when boxd cannot (an
 * older box with no index): the caller uses the runtime's `diff`.
 */
export async function changes(box: BoxEndpoint, skip: string[], keep: string[], { timeoutMs = 120_000 }: { timeoutMs?: number } = {}): Promise<BoxChange[] | null> {
  try {
    const result = await request(box, { op: "changes", paths: skip, env: { keep: keep.join(",") } }, { timeoutMs });
    if (result.exit.code !== 0) return null;
    return JSON.parse(result.data.toString("utf8"));
  } catch {
    return null;
  }
}

/** Every entry below the folders, stat fields included. */
export async function walk(box: BoxEndpoint, roots: string[], { max = 400_000, timeoutMs = 120_000, budget = REQUEST_LINE_BUDGET }: { max?: number; timeoutMs?: number; budget?: number } = {}): Promise<{ entries?: BoxStat[]; truncated?: boolean }> {
  const { batches } = batchPaths(roots, { budget, overhead: lineOverhead(box, { op: "walk", wait: max }) });
  if (batches.length <= 1) {
    const result = await request(box, { op: "walk", paths: batches[0] ?? [], wait: max }, { timeoutMs });
    return JSON.parse(result.data.toString("utf8"));
  }
  const entries: BoxStat[] = [];
  let truncated = false;
  for (const part of batches) {
    const left = max - entries.length;
    if (left <= 0) { truncated = true; break; }
    const result = await request(box, { op: "walk", paths: part, wait: left }, { timeoutMs });
    const parsed: { entries?: BoxStat[]; truncated?: boolean } = JSON.parse(result.data.toString("utf8"));
    entries.push(...(parsed.entries ?? []));
    if (parsed.truncated) { truncated = true; break; }
  }
  return { entries, truncated };
}

export type TarResult = { bytes: number; sha256: string; ms?: number; warning: string | null; skipped?: SkippedPath[] };

/**
 * Tar exactly these paths into `file`: { bytes, sha256, ms, warning } (and
 * `skipped`, the paths no request could carry). The tar streams to disk: the
 * box's connection waits while the file catches up. Many paths go in several
 * requests (each line within the budget), written one after the other as a
 * single archive: each part but the last loses its end-of-archive marker.
 * The paths go in byte order (boxd's), so a folder comes before what is in it.
 */
export async function tarTo(box: BoxEndpoint, paths: string[], file: string, { timeoutMs = 15 * 60_000, budget = REQUEST_LINE_BUDGET }: { timeoutMs?: number; budget?: number } = {}): Promise<TarResult> {
  const { batches, skipped } = batchPaths(byteSorted(paths), { budget, overhead: lineOverhead(box, { op: "tar" }) });
  const stream = createWriteStream(file, { mode: 0o600 });
  const hash = createHash("sha256");
  const controller = new AbortController();
  let bytes = 0;
  let draining: Promise<unknown> | null = null;
  let failed: Error | null = null;
  stream.on("error", (error) => {
    failed ??= error;
    controller.abort();
  });
  await once(stream, "open");
  const write = (pieces: Buffer[]): Promise<unknown> | null => {
    if (!pieces.length) return draining;
    const copy = Buffer.concat(pieces);
    hash.update(copy);
    bytes += copy.length;
    // One drain wait at a time, however many frames arrive before it.
    if (!stream.write(copy) && !draining) {
      draining = once(stream, "drain").finally(() => { draining = null; });
      draining.catch(() => undefined); // a write error is `failed`
    }
    return draining;
  };
  let ms: number | undefined;
  const warnings: string[] = [];
  try {
    // Nothing any request could carry: still a valid (empty) archive.
    if (!batches.length) await write([Buffer.alloc(1024)]);
    for (let index = 0; index < batches.length; index += 1) {
      const body = index < batches.length - 1 ? archiveBody() : null;
      let result: BoxReply;
      try {
        result = await request(box, { op: "tar", paths: batches[index] }, {
          timeoutMs,
          signal: controller.signal,
          onData: (chunk) => write(body ? body.push(chunk) : [chunk]),
        });
      } catch (error) {
        throw failed ?? error;
      }
      if (failed) throw failed;
      if (result.exit.code !== 0) throw new Error(`box tar failed: ${result.stderr.trim() || result.exit.code}${batches.length > 1 ? ` (part ${index + 1} of ${batches.length})` : ""}`);
      body?.end();
      if (typeof result.exit.ms === "number") ms = (ms ?? 0) + result.exit.ms;
      const warning = result.stderr.trim();
      if (warning && !warnings.includes(warning)) warnings.push(warning);
    }
  } finally {
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  }
  if (failed) throw failed;
  return { bytes, sha256: hash.digest("hex"), ms, warning: warnings.join("\n") || null, ...(skipped.length ? { skipped } : {}) };
}

// --- path lists in requests -------------------------------------------------------

/**
 * boxd reads a request line of at most 4 MiB (box/go/proto ReadRequest; 64
 * MiB from this version on, but a box may run an older boxd): a list of
 * paths goes in requests whose line stays well under it.
 */
export const REQUEST_LINE_MAX = 4 << 20;
export const REQUEST_LINE_BUDGET = 3 << 20;

export type SkippedPath = { path: string; reason: string };

/** The bytes of a request's line (newline included) with no paths. */
export function lineOverhead(box: BoxEndpoint, req: BoxRequest): number {
  return Buffer.byteLength(JSON.stringify({ v: PROTO_VERSION, token: box.token, ...req, paths: [] })) + 1;
}

/**
 * `paths` in order, cut into batches whose request line (`overhead` plus the
 * JSON of the list, newline included) stays within `budget` bytes. A path
 * that alone does not fit is left out: { batches, skipped }.
 */
export function batchPaths(paths: string[], { budget = REQUEST_LINE_BUDGET, overhead = 0 }: { budget?: number; overhead?: number } = {}): { batches: string[][]; skipped: SkippedPath[] } {
  const batches: string[][] = [];
  const skipped: SkippedPath[] = [];
  let current: string[] = [];
  let size = overhead;
  for (const p of paths) {
    // Its JSON string, and the comma before it unless it starts a batch.
    const bytes = Buffer.byteLength(JSON.stringify(p));
    if (overhead + bytes > budget) { skipped.push({ path: p, reason: "path_too_long" }); continue; }
    if (current.length && size + bytes + 1 > budget) {
      batches.push(current);
      current = [];
      size = overhead;
    }
    size += bytes + (current.length ? 1 : 0);
    current.push(p);
  }
  if (current.length) batches.push(current);
  return { batches, skipped };
}

/** Sorted by their UTF-8 bytes (Go's sort.Strings, what boxd's tar uses). */
export function byteSorted(paths: string[]): string[] {
  return paths.map((p) => [Buffer.from(p, "utf8"), p] as const).sort((a, b) => Buffer.compare(a[0], b[0])).map((item) => item[1]);
}

// Entry types with no data, whatever their size field says (Go's archive/tar reader).
const HEADER_ONLY = new Set([0x31, 0x32, 0x33, 0x34, 0x35, 0x36]);

/** A tar header's numeric field: octal text, or base-256 (high bit set). */
function tarNumber(field: Buffer): number {
  if ((field[0] ?? 0) & 0x80) {
    let value = BigInt((field[0] ?? 0) & 0x7f);
    for (let i = 1; i < field.length; i += 1) value = (value << 8n) | BigInt(field[i] ?? 0);
    return Number(value);
  }
  const text = field.toString("latin1").replace(/[\0 ]+$/g, "").replace(/^[\0 ]+/, "");
  if (!/^[0-7]*$/.test(text)) throw new Error("box tar: a header has a bad number");
  return text ? parseInt(text, 8) : 0;
}

/** The `size` record of a PAX extended header's data, or null. */
function paxSize(data: Buffer): number | null {
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number(data.subarray(at, space).toString("latin1"));
    if (!Number.isInteger(length) || length <= 0 || at + length > data.length) break;
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "size") {
      const value = Number(record.slice(eq + 1));
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
    at += length;
  }
  return null;
}

/**
 * One part of a tar written in several: passes the archive through up to its
 * end-of-archive marker (the first all-zero header block) and drops the
 * marker and the zero padding after it, so the next part follows on as the
 * same archive. push(chunk) -> the pieces to write; end() throws when the
 * part did not end as an archive does.
 */
export function archiveBody(): { push: (chunk: Buffer) => Buffer[]; end: () => void } {
  const block = Buffer.alloc(512);
  let filled = 0;
  let left = 0;
  let pax: Buffer[] | null = null;
  let paxLength = 0;
  let nextSize: number | null = null;
  let ended = false;
  return {
    push(chunk) {
      const out: Buffer[] = [];
      let i = 0;
      while (i < chunk.length) {
        if (ended) {
          for (; i < chunk.length; i += 1) if (chunk[i] !== 0) throw new Error("box tar: data after the end of the archive");
          break;
        }
        if (left > 0) {
          const n = Math.min(left, chunk.length - i);
          const piece = chunk.subarray(i, i + n);
          out.push(piece);
          if (pax) pax.push(Buffer.from(piece));
          left -= n;
          i += n;
          if (left === 0 && pax) {
            nextSize = paxSize(Buffer.concat(pax).subarray(0, paxLength));
            pax = null;
          }
          continue;
        }
        const n = Math.min(512 - filled, chunk.length - i);
        chunk.copy(block, filled, i, i + n);
        filled += n;
        i += n;
        if (filled < 512) break;
        filled = 0;
        if (!block.some((byte) => byte !== 0)) { ended = true; continue; }
        let sum = 0;
        for (let k = 0; k < 512; k += 1) sum += k >= 148 && k < 156 ? 0x20 : block[k] ?? 0;
        if (tarNumber(block.subarray(148, 156)) !== sum) throw new Error("box tar: a header's checksum does not match");
        const type = block[156] ?? 0;
        let size = tarNumber(block.subarray(124, 136));
        const extended = type === 0x78 || type === 0x67; // x, g
        if (!extended && nextSize !== null) { size = nextSize; nextSize = null; }
        if (HEADER_ONLY.has(type)) size = 0;
        out.push(Buffer.from(block));
        left = Math.ceil(size / 512) * 512;
        if (type === 0x78 && size > 0) {
          if (size > 8 << 20) throw new Error("box tar: an extended header is too large");
          pax = [];
          paxLength = size;
        }
      }
      return out;
    },
    end() {
      if (!ended) throw new Error("box tar: a part ended before its end-of-archive marker");
    },
  };
}
