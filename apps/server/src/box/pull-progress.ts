// Desktop only (the CLI prints its own pull): how far the background image
// download is, for the Settings card's progress bar.
//
// The detached `<runtime> pull` writes its output next to its pid marker
// (launch.ts pullInBackground). bubblewrap's boxrun says its bytes
// ({"progress":{"bytes","total"}}, the CLI's progress.js reads the same).
// Piped, Docker prints one line per layer
// state and no byte counts, so the bytes come from the image's manifest
// (`docker manifest inspect -v`, asked once per image, in the background):
// a layer counts once its download is complete. Only the layers the runtime
// names count: one already here (shared with another box image) is not
// downloaded and may not be named at all. Without the manifest (Podman, a
// local image, no network) only the layer counts are known.

import { readFileSync, statSync } from "node:fs";

import type { BoxRuntime } from "./common.js";
import type { BoxImage } from "./images.js";
import { runCommand, type RunCommand } from "./run.js";

export type PullProgress = {
  /** Bytes of the layers already downloaded (null: the layer sizes are not known). */
  bytesDone: number | null;
  bytesTotal: number | null;
  layersDone: number;
  /** The layers the runtime downloads (0 until it has listed them). */
  layersTotal: number;
  /** When the download started (ms since the epoch), when known. */
  startedAt: number | null;
};

const DOWNLOADED = /^(Download complete|Extracting|Pull complete|Already exists)\b/;
/** At most this much of the log's end is read (a pull writes a few lines per layer). */
const LOG_TAIL = 256 << 10;

/**
 * Layers seen and downloaded in a pull's output (Docker: `<id>: <state>`;
 * Podman: `Copying blob <id> [done|skipped]`), and boxrun's own byte count
 * (`{"progress":{"bytes":N,"total":M}}`, its older `layer i/n <digest> <size> bytes`).
 */
export function parsePullLog(text: string): { seen: string[]; done: Set<string>; bytes: { done: number; total: number | null } | null; layers: number } {
  const seen: string[] = [];
  const done = new Set<string>();
  let bytesDone: number | null = null;
  let bytesTotal: number | null = null;
  // boxrun names a layer once it is in, with how many there are.
  let layers = 0;
  const see = (id: string) => { if (!seen.includes(id)) seen.push(id); };
  for (const raw of text.split(/\r?\n|\r/)) {
    const line = raw.trim();
    if (line.startsWith("{\"progress\"")) {
      try {
        const parsed: { progress?: { bytes?: unknown; total?: unknown } } | null = JSON.parse(line);
        const read = Number(parsed?.progress?.bytes);
        const total = Number(parsed?.progress?.total);
        if (Number.isFinite(read)) bytesDone = read;
        if (total > 0) bytesTotal = total;
      } catch { /* a torn line */ }
      continue;
    }
    const layer = /^layer (\d+)\/(\d+) sha256:([0-9a-f]{12})\S* (\d+) bytes$/.exec(line);
    if (layer) {
      // An older boxrun says only whole layers: they count once done.
      see(layer[3]!);
      done.add(layer[3]!);
      layers = Math.max(layers, Number(layer[2]));
      continue;
    }
    const docker = /^([0-9a-f]{12}): (.+)$/.exec(line);
    if (docker) {
      see(docker[1]!);
      if (DOWNLOADED.test(docker[2]!)) done.add(docker[1]!);
      continue;
    }
    const podman = /^Copying blob (?:sha256:)?([0-9a-f]{12})[0-9a-f]*(.*)$/.exec(line);
    if (podman) {
      see(podman[1]!);
      if (/\b(done|skipped)\b/.test(podman[2]!)) done.add(podman[1]!);
    }
  }
  return { seen, done, bytes: bytesDone === null ? null : { done: bytesDone, total: bytesTotal }, layers: Math.max(layers, seen.length) };
}

type LayerSizes = Map<string, number>;

const GOARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };

/** Layer sizes by short id (the first 12 hex digits of the digest) for this machine's platform, from `manifest inspect -v`. */
export function parseManifestSizes(stdout: string, arch: string = GOARCH[process.arch] ?? process.arch): LayerSizes | null {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return null; }
  const entries = Array.isArray(value) ? value : [value];
  type Entry = { Descriptor?: { platform?: { os?: string; architecture?: string } }; SchemaV2Manifest?: { layers?: unknown }; OCIManifest?: { layers?: unknown } };
  const isEntry = (entry: unknown): entry is Entry => typeof entry === "object" && entry !== null;
  const pick = entries.filter(isEntry).find((entry) => {
    const platform = entry.Descriptor?.platform;
    return !platform || (platform.os === "linux" && platform.architecture === arch);
  });
  const layers = pick?.SchemaV2Manifest?.layers ?? pick?.OCIManifest?.layers;
  if (!Array.isArray(layers) || !layers.length) return null;
  const sizes: LayerSizes = new Map();
  for (const layer of layers) {
    const digest = typeof layer?.digest === "string" ? layer.digest : "";
    const size = typeof layer?.size === "number" ? layer.size : NaN;
    const id = /^sha256:([0-9a-f]{12})/.exec(digest)?.[1];
    if (!id || !Number.isFinite(size)) return null;
    sizes.set(id, size);
  }
  return sizes;
}

/** Per image: the sizes once known, or when the last ask failed (asked again a minute later). */
const sizesCache = new Map<string, { sizes: LayerSizes | null; at: number; asking: boolean }>();
const RETRY_MS = 60_000;

/** The layer sizes of `image` if known now; starts asking in the background otherwise (Docker only). */
export function layerSizes(runtime: BoxRuntime, image: BoxImage, { run = runCommand, now = Date.now() }: { run?: RunCommand; now?: number } = {}): LayerSizes | null {
  if (runtime.name !== "docker") return null;
  const cached = sizesCache.get(image.pull);
  if (cached?.sizes) return cached.sizes;
  if (cached && (cached.asking || now - cached.at < RETRY_MS)) return null;
  const entry = { sizes: null, at: now, asking: true };
  sizesCache.set(image.pull, entry);
  void run(runtime.bin, [...(runtime.prefix ?? []), "manifest", "inspect", "-v", image.pull], { timeoutMs: 20_000 })
    .then((res) => { if (res.code === 0) sizesCache.set(image.pull, { sizes: parseManifestSizes(res.stdout), at: Date.now(), asking: false }); else entry.asking = false; })
    .catch(() => { entry.asking = false; });
  return null;
}

/** Forget the sizes asked (tests). */
export function clearLayerSizes(): void {
  sizesCache.clear();
}

/** The progress of a background download from its log; null when there is no log (a download in this process: the WSL distro). */
export function pullProgress(log: string, marker: string, sizes: LayerSizes | null): PullProgress | null {
  let text: string;
  try {
    const buffer = readFileSync(log);
    text = buffer.subarray(Math.max(0, buffer.length - LOG_TAIL)).toString("utf8");
  } catch {
    return null;
  }
  let startedAt: number | null = null;
  try { startedAt = Math.round(statSync(marker).mtimeMs); } catch { /* unknown */ }
  const { seen, done, bytes, layers } = parsePullLog(text);
  if (bytes?.total) return { bytesDone: Math.min(bytes.done, bytes.total), bytesTotal: bytes.total, layersDone: done.size, layersTotal: layers, startedAt };
  // Bytes only when every layer the runtime named has a size (else the sizes are another image's or platform's).
  const sized = sizes && seen.length && seen.every((id) => sizes.has(id)) ? sizes : null;
  const bytesTotal = sized ? seen.reduce((sum, id) => sum + (sized.get(id) ?? 0), 0) : null;
  const bytesDone = sized ? [...done].reduce((sum, id) => sum + (sized.get(id) ?? 0), 0) : null;
  return { bytesDone, bytesTotal, layersDone: done.size, layersTotal: layers, startedAt };
}
