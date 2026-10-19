import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { commandEvent, revertEvent, revertRequest, reviewTarget } from "./command-events.js";
import { SessionUploader } from "./session-uploader.js";

// The additive events of the review and undo commands: same names and fields as the CLI.

describe("reviewTarget", () => {
  test("names what a review looks at from its arguments", () => {
    expect(reviewTarget("")).toBe("uncommitted");
    expect(reviewTarget("   ")).toBe("uncommitted");
    expect(reviewTarget(undefined)).toBe("uncommitted");
    expect(reviewTarget("a1b2c3d")).toBe("commit");
    expect(reviewTarget("0123456789abcdef0123456789abcdef01234567")).toBe("commit");
    expect(reviewTarget("https://github.com/acme/app/pull/12")).toBe("pr");
    expect(reviewTarget("42")).toBe("pr");
    expect(reviewTarget("#42")).toBe("pr");
    expect(reviewTarget("main")).toBe("branch");
    expect(reviewTarget("feature/login-form")).toBe("branch");
    expect(reviewTarget("the auth changes please")).toBe("other");
  });
});

describe("commandEvent", () => {
  test("review and fix dispatches give their events; other commands give none", () => {
    expect(commandEvent(JSON.stringify({ command: "review", arguments: "" }))).toEqual({ type: "review.run", data: { target: "uncommitted", has_arguments: false } });
    expect(commandEvent(new TextEncoder().encode(JSON.stringify({ command: "/review", arguments: " main " })).buffer)).toEqual({ type: "review.run", data: { target: "branch", has_arguments: true } });
    expect(commandEvent({ command: "fix", arguments: "" })).toEqual({ type: "review.fix", data: { issues: "all" } });
    expect(commandEvent({ command: "fix", arguments: "1, 3" })).toEqual({ type: "review.fix", data: { issues: "some" } });
    expect(commandEvent({ command: "init", arguments: "" })).toBeNull();
    expect(commandEvent("not json")).toBeNull();
    expect(commandEvent(undefined)).toBeNull();
  });
});

describe("revertEvent", () => {
  const session = {
    id: "ses_1",
    revert: { messageID: "msg_4", restored: ["src/a.ts", "b.md"], merged: ["c.ts"], kept: ["d.ts"], snapshot: "x" },
  };

  test("an undo counts what happened to each file", () => {
    expect(revertEvent("revert", session)).toEqual({
      type: "turn.undone",
      data: {
        message_id: "msg_4",
        repeat: false,
        restored: 2,
        merged: 1,
        kept: 1,
        files: { restored: ["src/a.ts", "b.md"], merged: ["c.ts"], kept: ["d.ts"] },
      },
    });
    expect(revertEvent("revert", session, "msg_9")?.data.repeat).toBe(true);
  });

  test("an engine without the file lists records empty ones", () => {
    expect(revertEvent("revert", { revert: { messageID: "msg_1" } })?.data).toMatchObject({ restored: 0, merged: 0, kept: 0, files: { restored: [], merged: [], kept: [] } });
  });

  test("a redo names the revert point before it", () => {
    expect(revertEvent("unrevert", { id: "ses_1" }, "msg_4")).toEqual({ type: "turn.redone", data: { message_id: "msg_4" } });
    expect(revertEvent("unrevert", { id: "ses_1" })).toEqual({ type: "turn.redone", data: { message_id: null } });
  });

  test("no session, or no revert point after an undo, records nothing", () => {
    expect(revertEvent("revert", null)).toBeNull();
    expect(revertEvent("revert", { id: "ses_1" })).toBeNull();
    expect(revertEvent("unrevert", "oops")).toBeNull();
  });
});

describe("revertRequest", () => {
  test("matches only POST undo and redo", () => {
    expect(revertRequest("POST", "/session/ses_1/revert")).toEqual({ sessionId: "ses_1", kind: "revert" });
    expect(revertRequest("POST", "/session/ses_1/unrevert")).toEqual({ sessionId: "ses_1", kind: "unrevert" });
    expect(revertRequest("GET", "/session/ses_1/revert")).toBeNull();
    expect(revertRequest("POST", "/session/ses_1/message")).toBeNull();
  });
});

describe("SessionUploader.recordCommand", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("records the schema-1 events with upload-safe paths, and nothing for an untracked chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-cmd-"));
    roots.push(root);
    const envelopes: Array<Record<string, unknown>> = [];
    const sessionUploader = new SessionUploader({
      upload: async (_sessionId, compressed) => {
        const envelope = JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Record<string, unknown>;
        const files = Array.isArray(envelope.files) ? envelope.files as Array<{ path?: string; content?: string }> : [];
        const traceFile = files.find((file) => file.path === "__omnirush__/trace.json");
        envelopes.push(traceFile?.content && envelope.trace === undefined ? { ...envelope, trace: (JSON.parse(traceFile.content) as { events?: unknown[] }).events ?? [] } : envelope);
        return Response.json({ ok: true }, { status: 201 });
      },
      changeDebounceMs: 10,
      fallbackScanMs: 60_000,
    });
    const sessionId = "session-cmd-1234";
    sessionUploader.startSession(sessionId, "workspace-test", root);
    sessionUploader.captureSnapshot(sessionId, "prompt");
    const undone = revertEvent("revert", { revert: { messageID: "msg_2", restored: ["src/app.ts"], merged: [], kept: ["notes/jane.doe@gmail.com.txt"] } });
    sessionUploader.recordCommand(sessionId, undone!.type, undone!.data);
    sessionUploader.recordCommand(sessionId, "turn.redone", { message_id: "msg_2" });
    const review = commandEvent({ command: "review", arguments: "" })!;
    sessionUploader.recordCommand(sessionId, review.type, review.data);
    sessionUploader.recordCommand(sessionId, "review.fix", { issues: "all" });
    sessionUploader.recordCommand("session-unknown-1234", "review.fix", { issues: "all" });
    await sessionUploader.idle(sessionId);
    sessionUploader.flushTrace(sessionId);
    await sessionUploader.stop();

    const events = envelopes.flatMap((envelope) => (Array.isArray(envelope.trace) ? envelope.trace : []) as Array<{ type: string; data?: Record<string, unknown> }>);
    const pick = (type: string) => events.filter((event) => event.type === type);
    expect(pick("turn.undone")).toHaveLength(1);
    const data = pick("turn.undone")[0]!.data!;
    expect(data).toMatchObject({ schema: 1, message_id: "msg_2", repeat: false, restored: 1, merged: 0, kept: 1 });
    const files = data.files as { restored: string[]; kept: string[] };
    expect(files.restored).toEqual(["src/app.ts"]);
    // Paths take the same upload pass as every other path (an e-mail address in a name is not sent as is).
    expect(files.kept[0]).not.toContain("jane.doe@gmail.com");
    expect(pick("turn.redone")[0]!.data).toEqual({ schema: 1, message_id: "msg_2" });
    expect(pick("review.run")[0]!.data).toEqual({ schema: 1, target: "uncommitted", has_arguments: false });
    expect(pick("review.fix")).toHaveLength(1);
    expect(pick("review.fix")[0]!.data).toEqual({ schema: 1, issues: "all" });
  });
});
