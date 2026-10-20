import { describe, expect, mock, test } from "bun:test";

import { notifyFilesRewound, onFilesRewound, rewoundFiles, type FilesRewound } from "../src/app/lib/files-rewound";
import { revertSession, unrevertSession } from "../src/app/lib/opencode-session";
import { isPersonUserMessage, personUserMessages } from "../src/react-app/domains/session/commands/turn-messages";

// Monaco itself does not load outside the app; the documents only need a language name.
mock.module("../src/react-app/domains/session/editor/monaco", () => ({ languageForPath: () => "plaintext" }));
const { EditorDocuments } = await import("../src/react-app/domains/session/editor/editor-models");
const { undoTarget } = await import("../src/react-app/domains/session/commands/use-session-commands");

type Part = Record<string, unknown>;
const msg = (id: string, role: "user" | "assistant", parts: Part[], info: Record<string, unknown> = {}) => ({ info: { id, role, ...info }, parts });
const text = (value: string, extra: Part = {}) => ({ type: "text", text: value, ...extra });

// One turn with an automatic compaction in the middle of it: the person's prompt, the agent's
// work, the compaction's request and summary, the automatic "continue", the rest of the work.
const COMPACTED_TURN = [
  msg("m01", "user", [text("first")]),
  msg("m02", "assistant", [text("done")]),
  msg("m03", "user", [text("refactor the parser"), { type: "file", url: "file:///a.ts" }, text("Called the Read tool", { synthetic: true })]),
  msg("m04", "assistant", [{ type: "tool", tool: "edit" }]),
  msg("m05", "user", [{ type: "compaction", auto: true }]),
  msg("m06", "assistant", [text("summary")], { summary: true, mode: "compaction" }),
  msg("m07", "user", [text("Continue if you have next steps", { synthetic: true, metadata: { compaction_continue: true } })]),
  msg("m08", "assistant", [{ type: "tool", tool: "write" }, text("finished")]),
];

describe("turn user messages", () => {
  test("a compaction's request and its automatic follow-up do not start turns", () => {
    expect(personUserMessages(COMPACTED_TURN).map((message) => message.info.id)).toEqual(["m01", "m03"]);
    expect(isPersonUserMessage(msg("x", "user", [text("hi")]))).toBe(true);
    // A prompt that is only an attachment (no typed text) is still the person's.
    expect(isPersonUserMessage(msg("x", "user", [{ type: "file", url: "file:///a.png" }]))).toBe(true);
    expect(isPersonUserMessage(msg("x", "user", [{ type: "data-compaction" }]))).toBe(false);
    // Only synthetic text (an attachment whose read failed) is still the person's prompt.
    expect(isPersonUserMessage(msg("x", "user", [text("Could not read a.png", { synthetic: true })]))).toBe(true);
    // A user message's diff summary object is not a compaction mark.
    expect(isPersonUserMessage(msg("x", "user", [text("hi")], { summary: { diffs: [] } }))).toBe(true);
    expect(isPersonUserMessage(msg("x", "assistant", [text("hi")]))).toBe(false);
    expect(isPersonUserMessage(null)).toBe(false);
  });

  test("a prompt the engine replays after an overflow compaction counts as the original", () => {
    const replayed = [
      msg("m01", "user", [text("first")]),
      msg("m02", "assistant", [text("done")]),
      msg("m03", "user", [text("big prompt")]),
      msg("m04", "user", [{ type: "compaction", auto: true, overflow: true }]),
      msg("m05", "assistant", [text("summary")], { summary: true }),
      msg("m06", "user", [text("big prompt")]),
      msg("m07", "user", [{ type: "compaction", auto: true, overflow: true }]),
      msg("m08", "assistant", [text("summary")], { summary: true }),
      msg("m09", "user", [text("big prompt")]),
      msg("m10", "assistant", [text("answer")]),
    ];
    expect(personUserMessages(replayed).map((message) => message.info.id)).toEqual(["m01", "m03"]);
    expect(undoTarget({ session: { id: "s", revert: null }, messages: replayed } as never)?.info.id).toBe("m03");
    // A different prompt after a compaction is a turn of its own.
    const next = [...replayed.slice(0, 5), msg("m06", "user", [text("something else")])];
    expect(personUserMessages(next).map((message) => message.info.id)).toEqual(["m01", "m03", "m06"]);
  });

  test("undo picks the turn's own prompt in one press", () => {
    const snapshot = { session: { id: "s", revert: null }, messages: COMPACTED_TURN } as never;
    expect(undoTarget(snapshot)?.info.id).toBe("m03");
    // After that undo the chat shows m01–m02: the next undo picks m01.
    const after = { session: { id: "s", revert: { messageID: "m03" } }, messages: COMPACTED_TURN } as never;
    expect(undoTarget(after)?.info.id).toBe("m01");
  });
});

describe("files rewound", () => {
  test("rewoundFiles lists the restored and merged files once", () => {
    expect(rewoundFiles({ revert: { restored: ["a.ts", "b.ts"], merged: ["b.ts", "c.ts"], kept: ["d.ts"], outside: ["e.ts"] } })).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(rewoundFiles({ revert: null })).toEqual([]);
    expect(rewoundFiles(null)).toEqual([]);
  });

  test("every successful revert and unrevert says so; a failed one does not", async () => {
    const seen: FilesRewound[] = [];
    const off = onFilesRewound((event) => seen.push(event));
    const client = {
      session: {
        revert: async ({ messageID }: { messageID: string }) => (messageID === "bad"
          ? { error: { name: "BusyError" }, response: { status: 409 } }
          : { data: { id: "s1", revert: { messageID, restored: ["a.ts"], merged: [] } } }),
        unrevert: async () => ({ data: { id: "s1" } }),
      },
    } as never;
    await revertSession(client, "s1", "m03");
    await unrevertSession(client, "s1");
    await expect(revertSession(client, "s1", "bad")).rejects.toBeDefined();
    off();
    notifyFilesRewound({ kind: "redo", sessionId: "s1", files: [] });
    expect(seen).toEqual([
      { kind: "undo", sessionId: "s1", files: ["a.ts"] },
      { kind: "redo", sessionId: "s1", files: [] },
    ]);
  });
});

// A Monaco text model as far as the documents use it.
function fakeModel(initial: string) {
  let value = initial;
  let version = 1;
  const listeners: Array<() => void> = [];
  const set = (next: string) => {
    value = next;
    version += 1;
    for (const listener of listeners) listener();
  };
  return {
    getValue: () => value,
    getValueLength: () => value.length,
    getAlternativeVersionId: () => version,
    getFullModelRange: () => ({}),
    pushEditOperations: (_: unknown, ops: Array<{ text: string }>) => set(ops[0]?.text ?? ""),
    onDidChangeContent: (listener: () => void) => listeners.push(listener),
    dispose: () => undefined,
    type: (next: string) => set(next),
  };
}

describe("editor documents after an undo", () => {
  test("a clean buffer takes the restored text; a buffer with unsaved changes is flagged once", async () => {
    const disk = new Map<string, { content: string; updatedAt: number }>([
      ["agent.ts", { content: "agent edit\n", updatedAt: 10 }],
      ["mine.ts", { content: "agent edit too\n", updatedAt: 10 }],
      ["same.ts", { content: "untouched\n", updatedAt: 10 }],
    ]);
    const models: ReturnType<typeof fakeModel>[] = [];
    const monaco = {
      Uri: { from: (value: unknown) => value },
      editor: {
        createModel: (content: string) => {
          // Indentation settings are applied on open; the fake model takes them and does nothing.
          const model = Object.assign(fakeModel(content), { detectIndentation: () => undefined, updateOptions: () => undefined });
          models.push(model);
          return model;
        },
        EndOfLinePreference: { TextDefined: 0 },
        getModels: () => [],
      },
    } as never;
    const client = {
      editorReadFile: async (_: string, path: string) => {
        const file = disk.get(path);
        if (!file) throw Object.assign(new Error("missing"), { status: 404 });
        return { path, content: file.content, updatedAt: file.updatedAt };
      },
    } as never;
    const docs = new EditorDocuments(monaco, client, "ws-undo-test");
    for (const path of ["agent.ts", "mine.ts", "same.ts"]) expect((await docs.open(path)).ok).toBe(true);
    // Unsaved typing in mine.ts.
    (docs.get("mine.ts")!.model as unknown as ReturnType<typeof fakeModel>).type("my unsaved text\n");

    // The undo restores both agent-edited files on disk.
    disk.set("agent.ts", { content: "original\n", updatedAt: 20 });
    disk.set("mine.ts", { content: "original too\n", updatedAt: 20 });
    expect(await docs.refreshAfterRewind()).toEqual(["mine.ts"]);
    expect(docs.get("agent.ts")!.model.getValue()).toBe("original\n");
    expect(docs.isDirty(docs.get("agent.ts")!)).toBe(false);
    expect(docs.get("agent.ts")!.updatedAt).toBe(20);
    expect(docs.get("mine.ts")!.model.getValue()).toBe("my unsaved text\n");
    expect(docs.get("mine.ts")!.conflict).toBe(true);
    expect(docs.get("same.ts")!.model.getValue()).toBe("untouched\n");
    // Already flagged: a second refresh does not report it again.
    expect(await docs.refreshAfterRewind()).toEqual([]);
    // Reload takes the disk text and clears the flag.
    await docs.revert("mine.ts");
    expect(docs.get("mine.ts")!.model.getValue()).toBe("original too\n");
    expect(docs.get("mine.ts")!.conflict).toBe(false);
    expect(docs.isDirty(docs.get("mine.ts")!)).toBe(false);
  });
});
