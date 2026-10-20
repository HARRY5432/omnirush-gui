/**
 * Screenshots and other tool-result images of a chat (computer-use/shared/media.mjs),
 * staged for its project archive under `__media__/` (MEDIA_ROOT_NAME):
 *   __media__/<sha256>.<ext>       the exact bytes the model saw
 *   __media__/full/<sha256>.png    full resolution, only when larger
 * The bytes stay in the local media spool until archived; every capture of
 * the chain lists all of them again (like attachments), so none reads as deleted.
 * Their caps are the media module's (media_model_bytes / media_full_bytes per
 * chat), apart from the project's files.
 */
import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { stateKey } from "./files.js";
import { MEDIA_ROOT_NAME } from "./manifest.js";

export { MEDIA_ROOT_NAME };

export type MediaRecord = { path: string; file: string; sha: string; kind: "model" | "full"; bytes: number };

const PATH = /^__media__\/(full\/)?[a-f0-9]{64}\.(png|jpg|gif|webp)$/;

export class MediaStore {
  constructor(private readonly dir: string) {}

  private indexOf(sessionId: string): string {
    return join(this.dir, `${stateKey(sessionId)}.jsonl`);
  }

  /** Stages frames for a chat (each archive path once). Never throws. */
  async add(sessionId: string, records: readonly MediaRecord[]): Promise<number> {
    const valid = records.filter((r) => PATH.test(r.path) && typeof r.file === "string" && r.file.length > 0 && Number.isInteger(r.bytes) && r.bytes > 0);
    if (!valid.length) return 0;
    try {
      const known = new Set((await this.list(sessionId)).map((r) => r.path));
      const fresh: MediaRecord[] = [];
      for (const record of valid) {
        if (known.has(record.path)) continue;
        known.add(record.path);
        fresh.push(record);
      }
      if (!fresh.length) return 0;
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await appendFile(this.indexOf(sessionId), fresh.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
      return fresh.length;
    } catch {
      return 0;
    }
  }

  async list(sessionId: string): Promise<MediaRecord[]> {
    let text = "";
    try {
      text = await readFile(this.indexOf(sessionId), "utf8");
    } catch {
      return [];
    }
    const out: MediaRecord[] = [];
    const seen = new Set<string>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "object" || value === null) continue;
        const record = value as Partial<MediaRecord>;
        if (typeof record.path === "string" && PATH.test(record.path) && typeof record.file === "string" && typeof record.sha === "string" && !seen.has(record.path)) {
          seen.add(record.path);
          out.push({ path: record.path, file: record.file, sha: record.sha, kind: record.kind === "full" ? "full" : "model", bytes: Number(record.bytes) || 0 });
        }
      } catch {
        // A torn last line: skipped.
      }
    }
    return out;
  }

  /** The staged frames still in the spool, with their sizes now. */
  async present(sessionId: string): Promise<Array<MediaRecord & { size: number }>> {
    const out: Array<MediaRecord & { size: number }> = [];
    for (const record of await this.list(sessionId)) {
      try {
        const stats = await lstat(record.file);
        if (stats.isFile()) out.push({ ...record, size: stats.size });
      } catch {
        // Gone from the spool: not archived again.
      }
    }
    return out;
  }
}
