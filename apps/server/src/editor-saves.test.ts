import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { EDITOR_SAVES_MAX_FILES, EditorSaveLog, revertBodyWithEditorSaves, revertMessageId, withRevertKeep } from "./editor-saves.js";

const encode = (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
const decode = (body: ArrayBuffer | undefined) => (body ? JSON.parse(new TextDecoder().decode(body)) : undefined);

const root = resolve("/tmp/editor-saves-project");

describe("EditorSaveLog", () => {
  test("remembers each file's newest save per folder, as absolute paths", () => {
    const log = new EditorSaveLog();
    expect(log.has(root)).toBe(false);
    log.record(root, "src/a.ts", 100);
    log.record(root, "b.md", 200);
    log.record(root, "src/a.ts", 300);
    log.record(resolve("/tmp/other"), "c.txt", 400);
    expect(log.has(root)).toBe(true);
    expect(log.savedSince(root, 0).sort()).toEqual([resolve(root, "b.md"), resolve(root, "src/a.ts")]);
    expect(log.savedSince(root, 250)).toEqual([resolve(root, "src/a.ts")]);
    expect(log.savedSince(root, 301)).toEqual([]);
    expect(log.savedSince(`${root}/`, 0)).toHaveLength(2);
  });

  test("lets the oldest saves go past its limit", () => {
    const log = new EditorSaveLog();
    for (let i = 0; i <= EDITOR_SAVES_MAX_FILES; i += 1) log.record(root, `f${i}.txt`, i);
    const saved = log.savedSince(root, 0);
    expect(saved).toHaveLength(EDITOR_SAVES_MAX_FILES);
    expect(saved).not.toContain(resolve(root, "f0.txt"));
  });
});

describe("undo request bodies", () => {
  test("revertMessageId reads the rewound message", () => {
    expect(revertMessageId(encode({ messageID: "msg_1" }))).toBe("msg_1");
    expect(revertMessageId(encode({ messageID: "" }))).toBeNull();
    expect(revertMessageId(encode({}))).toBeNull();
    expect(revertMessageId(new TextEncoder().encode("nope").buffer as ArrayBuffer)).toBeNull();
    expect(revertMessageId(undefined)).toBeNull();
  });

  test("withRevertKeep merges the saves into the body's keep list", () => {
    expect(decode(withRevertKeep(encode({ messageID: "m", partID: "p" }), ["/x/a"])!)).toEqual({ messageID: "m", partID: "p", keep: ["/x/a"] });
    expect(decode(withRevertKeep(encode({ messageID: "m", keep: ["b.txt", "/x/a"] }), ["/x/a", "/x/c"])!)).toEqual({ messageID: "m", keep: ["b.txt", "/x/a", "/x/c"] });
    // Nothing new: the body goes as it came.
    expect(withRevertKeep(encode({ messageID: "m", keep: ["/x/a"] }), ["/x/a"])).toBeNull();
    expect(withRevertKeep(encode({ messageID: "m" }), [])).toBeNull();
    expect(withRevertKeep(undefined, ["/x/a"])).toBeNull();
  });
});

describe("revertBodyWithEditorSaves", () => {
  const body = encode({ messageID: "msg_turn" });

  test("keeps the files saved at or after the rewound message was sent", async () => {
    const saves = new EditorSaveLog();
    saves.record(root, "before.txt", 900);
    saves.record(root, "during.txt", 1_000);
    saves.record(root, "later.txt", 1_500);
    const asked: string[] = [];
    const out = await revertBodyWithEditorSaves({
      saves,
      root,
      body,
      messageCreated: async (id) => {
        asked.push(id);
        return 1_000;
      },
    });
    expect(asked).toEqual(["msg_turn"]);
    expect(decode(out)).toEqual({ messageID: "msg_turn", keep: [resolve(root, "during.txt"), resolve(root, "later.txt")] });
  });

  test("a folder without editor saves, an unknown message time or no message: the body is unchanged and the engine is not asked", async () => {
    let asked = 0;
    const messageCreated = async () => {
      asked += 1;
      return null;
    };
    const empty = new EditorSaveLog();
    expect(await revertBodyWithEditorSaves({ saves: empty, root, body, messageCreated })).toBe(body);
    expect(asked).toBe(0);

    const saves = new EditorSaveLog();
    saves.record(root, "a.txt", 5);
    expect(await revertBodyWithEditorSaves({ saves, root, body, messageCreated })).toBe(body);
    expect(asked).toBe(1);
    const noMessage = encode({});
    expect(await revertBodyWithEditorSaves({ saves, root, body: noMessage, messageCreated })).toBe(noMessage);
    expect(asked).toBe(1);
    // Saved only before the turn: nothing to keep.
    expect(await revertBodyWithEditorSaves({ saves, root, body, messageCreated: async () => 10 })).toBe(body);
  });
});
