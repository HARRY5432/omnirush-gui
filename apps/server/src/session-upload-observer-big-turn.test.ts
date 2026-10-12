import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import { projectArchiveEngineReads, slimEngineMessage, type EngineTarget } from "./session-upload-observer.js";
import { completedTurnCount, promptTurnAt } from "./session-archive/lifecycle.js";

// A turn over the observer's 8 MiB message budget (a package install: the
// user message's diff summary carries every .venv / node_modules file) keeps
// its turn states: the prompt is read whole, the dependency files leave the
// diff summary, and a diff still too large loses its texts with a mark.

const MiB = 1024 * 1024;
const blob = (bytes: number, seed: string) => `${seed}:`.padEnd(bytes, "x");

type Message = { info: Record<string, unknown> & { id: string }; parts: unknown[] };

function bigPrompt(id: string, text: string, files: Array<{ file: string; bytes: number }>): Message {
  return {
    info: {
      id,
      sessionID: "ses_big",
      role: "user",
      time: { created: 4 },
      summary: { diffs: files.map(({ file, bytes }) => ({ file, before: "", after: blob(bytes, file), additions: 1, deletions: 0, status: "added" })) },
    },
    parts: [{ type: "text", text }],
  };
}

const reply = (id: string): Message => ({ info: { id, role: "assistant", finish: "stop", time: { created: 2, completed: 3 } }, parts: [{ type: "text", text: "installed" }, { type: "step-finish" }] });

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

/** The engine's paged message list: newest last, `limit`/`before`, x-next-cursor = the oldest id of the page. */
async function pagedEngine(messages: Message[]): Promise<EngineTarget> {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://engine");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (!url.pathname.endsWith("/message")) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ id: "ses_big" }));
      return;
    }
    const limit = Number(url.searchParams.get("limit") ?? messages.length);
    const before = url.searchParams.get("before");
    const end = before ? messages.findIndex((message) => message.info.id === before) : messages.length;
    const page = messages.slice(Math.max(0, end - limit), end);
    if (end - limit > 0) headers["x-next-cursor"] = page[0]!.info.id;
    res.writeHead(200, headers);
    res.end(JSON.stringify(page));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, headers: [], search: "", engine: "v1" } as EngineTarget;
}

describe("a turn over the message budget", () => {
  test("a package install turn over 8 MiB keeps its prompt and its turn count", async () => {
    const prompt = bigPrompt("u2", "install the deps", [
      { file: "src/app.py", bytes: 200 },
      ...Array.from({ length: 12 }, (_, index) => ({ file: `.venv/lib/python3.11/site-packages/pkg${index}/core.py`, bytes: MiB })),
      { file: "web/node_modules/left-pad/index.js", bytes: MiB },
    ]);
    expect(Buffer.byteLength(JSON.stringify(prompt))).toBeGreaterThan(12 * MiB);
    const target = await pagedEngine([
      { info: { id: "u1", role: "user", time: { created: 0 } }, parts: [{ type: "text", text: "hello" }] },
      reply("a1"),
      prompt,
      reply("a2"),
    ]);
    const outline = (await projectArchiveEngineReads(target, "ses_big").messages()) as Message[];
    expect(completedTurnCount(outline)).toBe(2);
    expect(outline[2]!.info.role).toBe("user");
    expect(promptTurnAt(outline, 5)).toBe(2);
  });

  test("a diff summary still over the budget loses its largest texts, marked, and keeps the rest", () => {
    const message = bigPrompt("u1", "generate data", [
      { file: "data/big.csv", bytes: 9 * MiB },
      { file: "src/small.ts", bytes: 100 },
      { file: "node_modules/x/index.js", bytes: 10 },
    ]);
    const slim = slimEngineMessage(message) as Message & { info: { summary: { diffs: Array<Record<string, unknown>>; diffs_truncated?: number; diffs_omitted?: number } } };
    expect(Buffer.byteLength(JSON.stringify(slim))).toBeLessThanOrEqual(8 * MiB);
    const diffs = slim.info.summary.diffs;
    expect(diffs.map((entry) => entry.file)).toEqual(["data/big.csv", "src/small.ts"]);
    expect(diffs[0]!.text_omitted).toBe(true);
    expect(diffs[0]!.after).toBeUndefined();
    expect((diffs[1]!.after as string).length).toBe(100);
    expect(slim.info.summary.diffs_truncated).toBe(1);
    expect(slim.info.summary.diffs_omitted).toBe(1);
    const small = bigPrompt("u3", "hi", [{ file: "a.txt", bytes: 10 }]);
    expect(slimEngineMessage(small)).toBe(small);
  });
});
