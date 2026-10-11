// Ported from the CLI (omnirush-cli src/box/launch.js, feat/local-box); keep
// the shared parts in step. Desktop differences: the per-project choice lives
// in the workspace's OmniRush settings (service.ts), not box.json; the plan
// is per workspace (one engine serves every project); a run tracks its turns
// per chat; there is no --sandbox flag (OMNIRUSH_BOX=1|0 still overrides).
//
// Whether a chat runs in its project's box, and the box's part in a run:
// the engine config bits (shell, plugin), the per-turn checkpoints, the
// trace label.
//
// Never blocking: the runtime probe and the image check are bounded; a
// missing image starts a download in the background and the project runs on
// this machine meanwhile (one line says so); the box itself starts in the
// background, and a shell call waits for it (boxsh).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { boxKey, containerName, gcBoxes, inspectImage, installShell, openBox, recordFile, rt, savedTurns, type Box, type BoxInstallLog, type BoxLabel, type BoxLog, type BoxRuntime, type CheckpointSummary } from "./box.js";
import { detectStack, imageFor, loadPins, type BoxImage } from "./images.js";
import { detectRuntime, runCommand, type RunCommand, type RuntimeResult } from "./runtime.js";

export const MODES = ["off", "offer", "on"] as const;
export type ServerBoxDefault = (typeof MODES)[number];
/** A project's own choice: "on", "off", or none (the server's default). */
export type ProjectBoxMode = "on" | "off" | null;

function isMode(value: unknown): value is ServerBoxDefault {
  return MODES.some((mode) => mode === value);
}

// --- the server's default -----------------------------------------------------------

/** The server's switch as last seen (GET /collect/capabilities -> local_box.default). */
export function serverDefault(stateDir: string): ServerBoxDefault {
  try {
    const value = JSON.parse(readFileSync(path.join(stateDir, "box-server.json"), "utf8"));
    return isMode(value?.default) ? value.default : "off";
  } catch {
    return "off";
  }
}

/** Remembers local_box.default of a capabilities answer; whether it changed. */
export function rememberServerDefault(stateDir: string, capabilities: { local_box?: unknown } | null | undefined): boolean {
  const block = capabilities?.local_box;
  if (!block || typeof block !== "object") return false;
  const fields = block as { default?: unknown; max_turn_bytes?: unknown };
  const value = isMode(fields.default) ? fields.default : "off";
  const before = serverDefault(stateDir);
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "box-server.json"), JSON.stringify({ default: value, max_turn_bytes: fields.max_turn_bytes ?? null, at: Date.now() }), { mode: 0o600 });
  } catch { /* best effort */ }
  return before !== value;
}

/**
 * On or off for a project, and why: OMNIRUSH_BOX=1|0 (every project), then
 * the project's setting, then the server's default ("on"; "offer" shows a
 * one-line offer until the project was offered it once; "off").
 */
export function resolveMode({ env = process.env, project, server, offered = false }: { env?: NodeJS.ProcessEnv; project: ProjectBoxMode; server: ServerBoxDefault; offered?: boolean }): { on: boolean; source: "env" | "project" | "server" | "default"; offer: boolean } {
  const asked = String(env.OMNIRUSH_BOX ?? "").trim().toLowerCase();
  if (["1", "on", "true"].includes(asked)) return { on: true, source: "env", offer: false };
  if (["0", "off", "false"].includes(asked)) return { on: false, source: "env", offer: false };
  if (project === "on" || project === "off") return { on: project === "on", source: "project", offer: false };
  if (server === "on") return { on: true, source: "server", offer: false };
  return { on: false, source: server === "offer" ? "server" : "default", offer: server === "offer" && !offered };
}

// --- background download ---------------------------------------------------------------

function pullMarker(home: string, image: string): string {
  return path.join(home, "pulls", `${image.replace(/[^a-zA-Z0-9._-]+/g, "_")}.pid`);
}

/** Whether a background download of `image` is running. */
export function pulling(home: string, image: string): boolean {
  try {
    const pid = Number(readFileSync(pullMarker(home, image), "utf8"));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start `pull` detached (survives this run); one at a time per image. */
export function pullInBackground(runtime: BoxRuntime, image: string, home: string, { spawnImpl = spawn }: { spawnImpl?: (command: string, args: string[], options: { detached: boolean; stdio: "ignore"; windowsHide: boolean }) => Pick<ChildProcess, "pid" | "unref"> } = {}): { started: boolean; pid: number | undefined } {
  const marker = pullMarker(home, image);
  try {
    const pid = Number(readFileSync(marker, "utf8"));
    if (pid) { process.kill(pid, 0); return { started: false, pid }; }
  } catch { /* none running */ }
  mkdirSync(path.dirname(marker), { recursive: true });
  const child = spawnImpl(runtime.bin, [...(runtime.prefix ?? []), "pull", image], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref?.();
  try { writeFileSync(marker, String(child.pid ?? "")); } catch { /* best effort */ }
  return { started: true, pid: child.pid };
}

// --- one project -----------------------------------------------------------------------

export type ReadyPlan = {
  box: { key: string; home: string; root: string; runtime: BoxRuntime };
  notice: null;
  shell: string;
  /**
   * Open the box (once); resolves the Box (state "ready" or "failed").
   * `pkglog`: the install log's folder (phase 1: { root, bin, py } with
   * POSIX wrappers), mounted into a new box and put on its PATH.
   */
  start: (options?: { pkglog?: BoxInstallLog | null }) => Promise<Box>;
};
export type NativePlan = { box: null; notice: string | null; runtime: RuntimeResult | null; image?: BoxImage; downloading?: boolean };
export type BoxPlan = ReadyPlan | NativePlan;

/**
 * Plan the box of the project at `root` (the project's box is on). Returns
 * { box: null, notice } when its chats run on this machine for now (no
 * runtime, no helpers, the image still downloading), else a ready plan.
 */
export async function planBox({ env = process.env, home, root, log = () => {}, run = runCommand, probeMs = 4_000, shims = null }: { env?: NodeJS.ProcessEnv; home: string; root: string; log?: BoxLog; run?: RunCommand; probeMs?: number; shims?: string | null }): Promise<BoxPlan> {
  const key = boxKey(root);
  const bounded = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
  const runtime = await bounded<RuntimeResult>(detectRuntime({ boxHome: home, env, run }), probeMs, { ok: false, reason: "the container runtime did not answer in time" });
  if (!runtime.ok) {
    log("info", "box unavailable", { reason: runtime.reason });
    return { box: null, notice: `Sandbox off for now: ${runtime.reason}.`, runtime };
  }
  let shell: string;
  try {
    shell = installShell(home, { env });
  } catch (error) {
    return { box: null, notice: `Sandbox off for now: ${error instanceof Error ? error.message : String(error)}.`, runtime };
  }
  // A box already made keeps its image (and its installs); a new one needs the image here.
  const existing = await bounded(rt(runtime, run)(["container", "inspect", containerName(key, env), "--format", "{{.Id}}"], { timeoutMs: probeMs }), probeMs, { code: -1, stdout: "", stderr: "" });
  if (existing.code !== 0) {
    const image = imageFor(detectStack(root), { env });
    const present = await bounded(inspectImage(runtime, image.pull, { run }), probeMs, null);
    if (!present) {
      pullInBackground(runtime, image.pull, home);
      return { box: null, notice: `Sandbox is downloading (${image.approxMb ? `about ${image.approxMb} MB, ` : ""}once); chats here run on this machine until it is ready.`, runtime, image, downloading: true };
    }
  }
  if (env.OMNIRUSH_BOX_GC !== "off") setTimeout(() => gcInBackground(runtime, home, { log }), 30_000).unref?.();
  let opening: Promise<Box> | null = null;
  return {
    box: { key, home, root, runtime },
    notice: null,
    shell,
    start: ({ pkglog = null } = {}) => {
      opening ??= openBox({ root, runtime, env, home, log, pull: false, shims, pkglog });
      return opening;
    },
  };
}

/**
 * Old boxes and images, at most once a day, in the background (never on the
 * start path): containers of folders that are gone or unused for 30 days,
 * box images that are neither current nor used. Labelled/named ones only.
 */
export function gcInBackground(runtime: BoxRuntime, home: string, { log = () => {}, now = Date.now(), everyMs = 24 * 3_600_000, gc = gcBoxes }: { log?: BoxLog; now?: number; everyMs?: number; gc?: typeof gcBoxes } = {}): Promise<Array<{ kind: string; name: string; reason: string }>> | null {
  const marker = path.join(home, "gc.json");
  try {
    if (now - Number(JSON.parse(readFileSync(marker, "utf8")).at) < everyMs) return null;
  } catch { /* never ran */ }
  try { mkdirSync(home, { recursive: true }); writeFileSync(marker, JSON.stringify({ at: now })); } catch { return null; }
  return gc(runtime, { home, pins: loadPins() })
    .then((removed) => { if (removed.length) log("info", "box gc", { removed: removed.map((item) => `${item.kind}:${item.name}`) }); return removed; })
    .catch((error) => { log("warn", "box gc failed", { error: String(error?.message || error) }); return []; });
}

/** The package-manager wrappers' source folder (phase 1), mounted read-only when present. */
export function shimsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const asked = String(env.OMNIRUSH_BOX_SHIMS_DIR || "").trim();
  if (asked) return existsSync(path.join(asked, "install.sh")) ? path.resolve(asked) : null;
  return null;
}

/** Engine config additions for box runs: the shell and the plugin. */
export function engineConfig(bits: { shell: string; plugin: string } | null, config: Record<string, unknown>): Record<string, unknown> {
  if (!bits) return config;
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  return {
    ...config,
    shell: bits.shell,
    plugin: [...plugins, bits.plugin],
  };
}

/** Turn the record off (the project went on without the box). */
export function recordOff(home: string, key: string, reason: string): void {
  try {
    const file = recordFile(home, key);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...rec, state: "off", error: reason, updated: Date.now() }), { mode: 0o600 });
  } catch { /* none */ }
}

// --- the box during a run ------------------------------------------------------------

export type Frozen = {
  label: string;
  turn: number | null;
  copied: number;
  carried: number;
  save: (outDir?: string) => Promise<{ label: string; changed: number; bytes: number }>;
  discard: () => Promise<null>;
};

export type BoxRun = {
  key: string;
  container: string;
  runtimeBin: string;
  /** Arguments before the runtime's own (`-e docker` for a WSL engine). */
  runtimeArgs: string[];
  root: string;
  readonly native: boolean;
  readonly box: Box | null;
  ready: () => Promise<Box | null>;
  /** environment.sandbox for a chat's uploads; null while it is not (or no longer) the chat's. */
  label: (sessionId: string) => BoxLabel | null;
  setTurn: (turn: number) => void;
  freeze: (label: string, options: { sessionId: string; turn?: number | null; chain?: string | null }) => Promise<Frozen | null>;
};

/**
 * What the capture wiring drives for one project's box: readiness, the
 * per-turn freeze, the label uploads carry (the toolchain probes run from
 * the capture worker: capture.ts). A box that
 * fails before any chat's first checkpoint turns the project native (record
 * "off"; the shell runs on this machine, its chats are not labelled); later
 * failures are logged and that turn has no checkpoint.
 */
export function boxRun(plan: ReadyPlan, { log = () => {}, readyWaitMs = 30_000, onNative = () => {}, tmpRoot, pkglog = null }: { log?: BoxLog; readyWaitMs?: number; onNative?: (reason: string) => void; tmpRoot?: string; pkglog?: BoxInstallLog | null } = {}): BoxRun {
  const { key, home, runtime, root } = plan.box;
  let box: Box | null = null;
  let native = false;
  const checkpoints = new Map<string, number>();
  const opening = plan.start({ pkglog }).then((opened) => { box = opened; return opened; });
  const goNative = (reason: string) => {
    if (native) return;
    native = true;
    recordOff(home, key, reason);
    log("warn", "box off for this project", { reason });
    onNative(reason);
  };
  const ready = async (): Promise<Box | null> => {
    if (native) return null;
    const opened = await Promise.race([opening, new Promise<null>((resolve) => setTimeout(() => resolve(null), readyWaitMs))]);
    if (opened?.ready) return opened;
    if ([...checkpoints.values()].every((count) => count === 0)) goNative(opened?.error || "the sandbox did not start in time");
    return null;
  };
  const pending = tmpRoot ?? path.join(home, "pending");
  return {
    key,
    container: containerName(key),
    runtimeBin: runtime.bin,
    runtimeArgs: runtime.prefix ?? [],
    root,
    get native() { return native; },
    get box() { return box; },
    ready,
    label: (sessionId) => (box?.ready && !native && (checkpoints.get(sessionId) ?? 0) > 0 ? box.label() : null),
    setTurn: (turn) => box?.setTurn(turn),
    /**
     * The old sandbox's freeze(label, { turn, chain }) -> { save(dir), discard() } | null:
     * the checkpoint is taken now and placed by save(); `final` (the state a
     * chat ends with) is a leaf, so a resumed chat chains on from its last turn.
     */
    freeze: async (label, { sessionId, turn = null, chain = null }) => {
      const opened = await ready();
      if (!opened) return null;
      const n = Number(turn ?? /^turn-(\d+)$/.exec(label)?.[1] ?? 0) || null;
      const name = n ? `turn-${n}` : label;
      const dir = chain ?? path.join(pending, `${process.pid}-${Date.now()}`);
      const taken = await opened.checkpoint(dir, n, { label: name, leaf: !n });
      checkpoints.set(sessionId, (checkpoints.get(sessionId) ?? 0) + 1);
      const summary: CheckpointSummary = taken.summary;
      return {
        label: name,
        turn: n,
        copied: summary.stats.copied,
        carried: Math.max(0, summary.stats.kept - summary.stats.copied),
        save: async (outDir) => {
          taken.commit(outDir ?? dir);
          return { label: name, changed: summary.delta.changed.length, bytes: summary.bytes };
        },
        discard: async () => { taken.discard(); return null; },
      };
    },
  };
}

/** A host path under the project, as the box sees it. */
export function mapToBox(p: string, root: string, croot: string): string {
  if (root === croot) return p;
  const rel = path.relative(root, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return croot;
  return rel ? `${croot}/${rel.split(path.sep).join("/")}` : croot;
}

export { savedTurns };
