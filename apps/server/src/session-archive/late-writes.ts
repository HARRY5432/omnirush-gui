/**
 * Late writes: a turn's background processes still writing after the turn
 * ended (`cmd &`, `npm install &`, a watcher or a dev server writing a
 * build folder). When the next prompt arrives, its turn must start from the
 * workspace those writes leave, not from one taken while they were still
 * landing. lateWriters() finds the processes a turn left running in the
 * workspace (Linux /proc; elsewhere none are found and nothing is waited
 * for), and settleLateWriters() waits, at most until a cap measured from the
 * turn's end, for them to exit. The wait runs while the prompt is being
 * dispatched, and only when such a process is still running, so a user who
 * types for longer than the cap never waits. Identical in the CLI and the
 * desktop app.
 */
import { readdir, readFile, readlink } from "node:fs/promises";
import { sep } from "node:path";

/** How long after a turn ended its next prompt may wait for the turn's background processes. */
export const LATE_WRITES_CAP_MS = 10_000;
/** How often the processes are looked at again while waiting. */
export const LATE_WRITES_POLL_MS = 200;
/** At most this many processes are reported. */
const MAX_REPORTED = 16;
const MAX_COMMAND_CHARS = 120;

export type LateWriter = { pid: number; command: string };

export type LateWritersInput = {
  /** The workspace: a process whose working directory is in it is a candidate. */
  root: string;
  /** When the turn started (epoch ms): older processes (a dev server from an earlier turn, the user's own shell) are not its. */
  since: number;
  /** Processes never waited for, with their descendants: this app, the engine. */
  exclude: readonly number[];
  /** Tests: the /proc directory and the platform. */
  proc?: string;
  platform?: NodeJS.Platform;
};

type ProcEntry = { pid: number; ppid: number; startedAt: number; uid: number | null; command: string };

/** Boot time (epoch ms) and clock ticks per second, for /proc/<pid>/stat start times. */
async function bootTime(proc: string): Promise<number | null> {
  try {
    const text = await readFile(`${proc}/stat`, "utf8");
    const match = /^btime (\d+)$/m.exec(text);
    return match ? Number(match[1]) * 1000 : null;
  } catch {
    return null;
  }
}

/** USER_HZ: 100 on every Linux the app runs on. */
const CLOCK_TICKS = 100;

async function procEntry(proc: string, pid: number, boot: number): Promise<ProcEntry | null> {
  try {
    const stat = await readFile(`${proc}/${pid}/stat`, "utf8");
    // `pid (comm) state ppid ...`: comm may hold spaces and parentheses; the fields follow the last `)`.
    const close = stat.lastIndexOf(")");
    const open = stat.indexOf("(");
    if (close < 0 || open < 0) return null;
    const fields = stat.slice(close + 2).split(" ");
    const ppid = Number(fields[1]);
    const ticks = Number(fields[19]);
    if (!Number.isFinite(ppid) || !Number.isFinite(ticks)) return null;
    // A zombie has exited: it writes nothing.
    if (fields[0] === "Z") return null;
    let uid: number | null = null;
    try {
      const status = await readFile(`${proc}/${pid}/status`, "utf8");
      const match = /^Uid:\s+(\d+)/m.exec(status);
      uid = match ? Number(match[1]) : null;
    } catch {
      uid = null;
    }
    let command = stat.slice(open + 1, close);
    try {
      const cmdline = (await readFile(`${proc}/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean).join(" ");
      if (cmdline) command = cmdline;
    } catch {
      // The short name will do.
    }
    return { pid, ppid, startedAt: boot + (ticks * 1000) / CLOCK_TICKS, uid, command: command.slice(0, MAX_COMMAND_CHARS) };
  } catch {
    return null;
  }
}

function inside(root: string, path: string): boolean {
  const base = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(base);
}

/**
 * The processes a turn left running in the workspace: started since the turn
 * began, working in the workspace, owned by this user, and neither an
 * excluded process nor one of its descendants (the engine's own helpers, a
 * tool call still running). Empty off Linux, or when /proc cannot be read.
 */
export async function lateWriters(input: LateWritersInput): Promise<LateWriter[]> {
  const platform = input.platform ?? process.platform;
  if (platform !== "linux") return [];
  const proc = input.proc ?? "/proc";
  const boot = await bootTime(proc);
  if (boot === null) return [];
  let names: string[];
  try {
    names = await readdir(proc);
  } catch {
    return [];
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  // Only a process working in the workspace is read in full (another user's cwd cannot even be read).
  const candidates: number[] = [];
  await Promise.all(names.filter((name) => /^\d+$/.test(name)).map(async (name) => {
    const pid = Number(name);
    if (pid === process.pid) return;
    try {
      if (inside(input.root, await readlink(`${proc}/${pid}/cwd`))) candidates.push(pid);
    } catch {
      // Gone, or not this user's.
    }
  }));
  if (candidates.length === 0) return [];
  const entries = new Map<number, ProcEntry | null>();
  const entryOf = async (pid: number): Promise<ProcEntry | null> => {
    if (!entries.has(pid)) entries.set(pid, await procEntry(proc, pid, boot));
    return entries.get(pid) ?? null;
  };
  const excluded = new Set(input.exclude.filter((pid) => Number.isSafeInteger(pid) && pid > 0));
  const excludedTree = async (pid: number): Promise<boolean> => {
    for (let current: number | undefined = pid, hops = 0; current !== undefined && current > 1 && hops < 64; hops += 1) {
      if (excluded.has(current)) return true;
      current = (await entryOf(current))?.ppid;
    }
    return false;
  };
  const found: LateWriter[] = [];
  for (const pid of candidates) {
    const entry = await entryOf(pid);
    if (!entry || entry.startedAt < input.since) continue;
    if (uid !== null && entry.uid !== null && entry.uid !== uid) continue;
    if (await excludedTree(pid)) continue;
    found.push({ pid, command: entry.command });
  }
  found.sort((left, right) => left.pid - right.pid);
  return found.slice(0, MAX_REPORTED);
}

export type SettleResult = {
  /** How long the prompt waited. */
  waitedMs: number;
  /** No process of the turn was left running (or all of them exited within the cap). */
  settled: boolean;
  /** The processes found running when the wait began. */
  processes: LateWriter[];
};

/**
 * Waits for the processes the turn that ended at `endedAt` left running in the
 * workspace to exit, until `endedAt + capMs` at the latest (never past it,
 * whenever it is called). Returns at once when none runs. Never throws.
 */
export async function settleLateWriters(input: LateWritersInput & {
  endedAt: number;
  capMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<SettleResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms).unref?.()));
  const deadline = input.endedAt + (input.capMs ?? LATE_WRITES_CAP_MS);
  const started = now();
  let processes: LateWriter[];
  try {
    processes = await lateWriters(input);
  } catch {
    return { waitedMs: 0, settled: true, processes: [] };
  }
  if (processes.length === 0) return { waitedMs: now() - started, settled: true, processes };
  let running = processes;
  while (running.length > 0 && now() < deadline && !input.signal?.aborted) {
    await sleep(Math.min(input.pollMs ?? LATE_WRITES_POLL_MS, Math.max(0, deadline - now())));
    const pids = new Set(running.map((process) => process.pid));
    try {
      running = (await lateWriters(input)).filter((process) => pids.has(process.pid));
    } catch {
      running = [];
    }
  }
  return { waitedMs: now() - started, settled: running.length === 0, processes };
}
