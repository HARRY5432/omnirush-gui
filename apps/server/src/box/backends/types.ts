// The shape every box backend's driver has (the CLI's drivers are plain
// objects of the same functions: src/box/backends/*.js).

import type { ChildProcess, SpawnOptions } from "node:child_process";

import type { BoxEndpoint } from "../client.js";
import type { BoxInstallLog, BoxLog, BoxRuntime } from "../common.js";
import type { BoxImage } from "../images.js";
import type { RunCommand, RunResult } from "../run.js";

type Env = NodeJS.ProcessEnv;

export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** How to run a program in the box with stdin open (files-used reads) when it is not `docker exec`. */
export type BoxExec = { bin: string; args: string[]; env?: Record<string, string> };

export type CreatedImage = { ref: string; pull: string; digest: string | null; id: string; stack: string };

export type OpenContext = {
  key: string;
  name: string;
  root: string;
  croot: string;
  runtime: BoxRuntime;
  run: RunCommand;
  home: string;
  runFolder: string;
  image: BoxImage;
  pull: boolean;
  shims: string | null;
  pkglog: BoxInstallLog | null;
  env: Env;
  platform: NodeJS.Platform;
  log: BoxLog;
  onPulling: () => void;
  spawnImpl?: SpawnLike;
};

export type Opened =
  | {
    ok: true;
    created: CreatedImage | null;
    endpoint: BoxEndpoint;
    /** Other ways to boxd, tried in turn when the first does not answer (Apple: the container's own address). */
    alternates?: BoxEndpoint[];
    uid: number;
    gid: number;
    containerId: string;
    imageId: string;
    mounts: string[];
    timing?: { ms?: number; reused: boolean };
  }
  | { ok: false; error: string };

export type PresentImage = { id: string; digest: string | null; arch: string; config?: string };
export type ListedBox = { key: string; name: string; root: string; running: boolean; image: string; created: string };
export type Removed = { kind: string; name: string; reason: string };
export type DriverOptions = { run?: RunCommand; env?: Env; home?: string; timeoutMs?: number; log?: BoxLog };

export type BoxDriver = {
  kind: "container" | "bwrap" | "apple" | "wsl" | "wslc";
  /** boxsh may fall back to `<runtime> exec` when boxd does not answer (container engines and wslc). */
  execFallback: boolean;
  imagePresent: (runtime: BoxRuntime, image: BoxImage, opts?: DriverOptions) => Promise<PresentImage | null>;
  pull: (runtime: BoxRuntime, image: BoxImage, opts?: DriverOptions) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** The detached download; null: the download runs in this process (Desktop: the WSL distro). */
  pullCommand: (runtime: BoxRuntime, image: BoxImage, home: string) => { bin: string; args: string[] } | null;
  exists: (runtime: BoxRuntime, key: string, opts?: DriverOptions) => Promise<boolean>;
  open: (ctx: OpenContext) => Promise<Opened>;
  list: (runtime: BoxRuntime, opts?: DriverOptions) => Promise<ListedBox[]>;
  remove: (runtime: BoxRuntime, key: string, opts?: DriverOptions) => Promise<{ removed: boolean }>;
  stop: (runtime: BoxRuntime, key: string, opts?: DriverOptions) => Promise<{ stopped: boolean }>;
  gcImages: (runtime: BoxRuntime, opts: DriverOptions & { current: Set<string>; used: Set<string> }) => Promise<Removed[]>;
  upperBytes: (runtime: BoxRuntime, key: string, opts?: DriverOptions) => Promise<number | null>;
  /** `<runtime> diff` (container engines only): the snapshot fallback when boxd cannot walk. */
  diff?: (runtime: BoxRuntime, key: string, opts?: DriverOptions) => Promise<RunResult>;
  /** An interactive shell in the box. */
  shellCommand: (runtime: BoxRuntime, opts: { key: string; croot: string; home: string; uid?: number; gid?: number; env?: Env }) => { bin: string; args: string[] };
  execCommand: (runtime: BoxRuntime, opts: { key: string; home: string; env?: Env }) => BoxExec;
};
