import { afterEach, expect, test } from "bun:test";

import { createSessionObservers, observeUploadedSession, type EngineTarget, type ObservedUploader } from "./session-upload-observer.js";
import { settledMessage, settledPrefix, TurnProgress, turnProgressIntervalMs, TURN_PROGRESS_FLOOR_MS, TURN_PROGRESS_INTERVAL_MS } from "./session-archive/turn-progress.js";

// A long turn sends what is final while it runs (session-archive/turn-progress.ts,
// the same file as the CLI's, PARITY.sha256): the parent's settled messages
// ahead as turn.messages, a sub-agent's as session.child as soon as it ends,
// and the turn's end only what was not sent ahead (or changed since). The
// CLI's test/turn-progress.test.js runs the same cases.

type Message = { info: Record<string, unknown> & { id: string }; parts: unknown[] };

const user = (id: string, text: string, created: number): Message => ({ info: { id, role: "user", time: { created } }, parts: [{ type: "text", text }] });
const running = (id: string, created: number, tool = "task"): Message => ({ info: { id, role: "assistant", time: { created } }, parts: [{ type: "tool", tool, state: { status: "running" } }] });
const done = (id: string, created: number, extra: unknown[] = []): Message => ({ info: { id, role: "assistant", finish: "stop", time: { created, completed: created + 1 } }, parts: [{ type: "text", text: `answer ${id}` }, { type: "step-finish" }, ...extra] });

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

test("settled messages: a user message, an ended answer with no open tool call", () => {
  expect(settledMessage(user("u", "hi", 1))).toBe(true);
  expect(settledMessage(done("a", 1))).toBe(true);
  expect(settledMessage(running("b", 1))).toBe(false);
  expect(settledMessage({ info: { id: "c", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ type: "tool", state: { status: "pending" } }] })).toBe(false);
  expect(settledPrefix([user("u", "x", 1), done("a", 2), running("b", 3), done("c", 4)])).toBe(2);
});

test("the interval: default, off, floor, unreadable", () => {
  expect(turnProgressIntervalMs(undefined)).toBe(TURN_PROGRESS_INTERVAL_MS);
  expect(turnProgressIntervalMs("0")).toBe(0);
  expect(turnProgressIntervalMs("10")).toBe(TURN_PROGRESS_FLOOR_MS);
  expect(turnProgressIntervalMs("120000")).toBe(120_000);
  expect(turnProgressIntervalMs("soon")).toBe(TURN_PROGRESS_INTERVAL_MS);
});

test("when progress is due: never in the first minute, then on the interval or a sub-agent's end", () => {
  const progress = new TurnProgress(0, 180_000);
  progress.noteStatuses({ root: { type: "busy" }, c1: { type: "busy" } }, "root");
  progress.noteStatuses({ root: { type: "busy" } }, "root");
  expect(progress.due(30_000)).toBeNull();
  expect(progress.due(61_000)).toBe("sub_agent_ended");
  progress.flushed(61_000);
  expect(progress.due(200_000)).toBeNull();
  expect(progress.due(241_000)).toBe("interval");
  progress.flushed(241_000);
  progress.noteStatuses({ root: { type: "busy" }, c2: { type: "busy" } }, "root");
  progress.noteStatuses({ root: { type: "busy" } }, "root");
  expect(progress.due(250_000)).toBeNull();
  expect(progress.due(256_000)).toBe("sub_agent_ended");
  const off = new TurnProgress(0, 0);
  expect(off.enabled).toBe(false);
  expect(off.due(10 * 60_000)).toBeNull();
});

test("sent ahead once, never a session's newest message; changed since: sent again at the end", () => {
  const progress = new TurnProgress(0, 180_000);
  const messages = [user("u1", "go", 1), done("a1", 2), running("a2", 3)];
  const ahead = progress.ahead(messages, [10, 20, 30]);
  expect(ahead.messages.map((m) => (m as Message).info.id)).toEqual(["u1", "a1"]);
  progress.markSent(ahead.messages, ahead.sizes);
  expect(progress.ahead(messages, [10, 20, 30]).messages).toEqual([]);
  const unsent = progress.unsent(messages, [10, 25, 30]);
  expect(unsent.messages.map((m) => (m as Message).info.id)).toEqual(["a1", "a2"]);
  expect(unsent.sizes).toEqual([25, 30]);
  // A session that ended: its newest message waits for the turn's end (the engine still adds its patch).
  const child = [user("cu", "go", 1), done("ca1", 2), done("ca2", 3)];
  expect(progress.ahead(child, [1, 2, 3], "ses_c").messages.map((m) => (m as Message).info.id)).toEqual(["cu", "ca1"]);
  expect(progress.unsent(child, [1, 2, 3], "ses_c").messages.length).toBe(3);
  expect(progress.sentCount).toBe(2);
});

type Phase = { statuses: Record<string, unknown>; children: Record<string, Array<{ id: string; title?: string }>>; messages: Record<string, Message[]> };

/** A scripted engine: `phase()` gives the statuses, the children and every session's messages. */
function scriptedEngine(phase: () => Phase): EngineTarget {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const now = phase();
      if (url.pathname === "/session/status") return Response.json(now.statuses);
      const children = /^\/session\/([^/]+)\/children$/.exec(url.pathname);
      if (children) return Response.json(now.children[decodeURIComponent(children[1]!)] ?? []);
      const list = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
      if (list) {
        const all = now.messages[decodeURIComponent(list[1]!)] ?? [];
        const limit = Number(url.searchParams.get("limit") ?? all.length);
        const before = url.searchParams.get("before");
        const end = before ? all.findIndex((message) => message.info.id === before) : all.length;
        const page = all.slice(Math.max(0, end - limit), end);
        return Response.json(page, { headers: end - limit > 0 ? { "x-next-cursor": page[0]!.info.id } : {} });
      }
      return Response.json({ id: "ses_root" });
    },
  });
  cleanups.push(() => server.stop(true));
  return { baseUrl: `http://127.0.0.1:${server.port}`, headers: [], search: "", engine: "v1" };
}

type Event = { at: number; type: string; data?: unknown };

function recordingUploader(clock: () => number, events: Event[], flushes: Array<{ at: number; final: unknown }>, checkpoint: string | null): ObservedUploader {
  const childCheckpoints: Record<string, string> = {};
  const childIds: string[] = [];
  return {
    enabled: true,
    sessionCheckpoint: async () => (checkpoint ? { lastMessageId: checkpoint } : {}),
    setSessionCheckpoint: async () => undefined,
    recordTrace: (_id: string, type: string, data?: unknown) => { events.push({ at: clock(), type, data }); },
    recordSessionModel: () => undefined,
    childCheckpoints: async () => ({ ...childCheckpoints }),
    childSessionIds: async () => [...childIds],
    recordChildSession: (_id: string, child: { childSessionId: string; lastMessageId?: string | null }) => {
      if (!childIds.includes(child.childSessionId)) childIds.push(child.childSessionId);
      if (child.lastMessageId) childCheckpoints[child.childSessionId] = child.lastMessageId;
      events.push({ at: clock(), type: "session.child", data: child });
    },
    noteChildSessionIds: () => 0,
    captureSnapshot: () => undefined,
    flushTrace: (_id: string, data?: unknown) => { flushes.push({ at: clock(), final: data ?? null }); },
  } as unknown as ObservedUploader;
}

const archive = { turnFollowed: () => undefined, turnCompleted: () => undefined, turnIncomplete: () => { throw new Error("incomplete"); } };
const ids = (messages: unknown): string[] => (messages as Message[]).map((message) => message.info.id);

test("a long turn with a sub-agent: progress while it runs, the end sends the rest once", async () => {
  let clock = 0;
  const before = [user("u0", "earlier", 0), done("a0", 1)];
  const childFinal = [user("cu1", "research", 10), done("ca1", 11), done("ca2", 12), done("ca3", 13)];
  // 0-70 s: the parent waits on the sub-agent, which works; from 70 s the sub-agent is done;
  // from 150 s the parent's first step ended and its second runs; from 250 s that first step
  // carries one more part (it changed after it went ahead); from 300 s the turn is over.
  const target = scriptedEngine(() => {
    const childRunning = clock < 70_000;
    const a1 = clock < 150_000 ? running("a1", 3) : clock < 250_000 ? done("a1", 3) : done("a1", 3, [{ type: "patch", hash: "h" }]);
    const root = [...before, user("u1", "deep research", 2), a1];
    if (clock >= 150_000) root.push(clock < 300_000 ? running("a2", 4, "bash") : done("a2", 4));
    return {
      statuses: clock >= 300_000 ? {} : childRunning ? { ses_root: { type: "busy" }, ses_c1: { type: "busy" } } : { ses_root: { type: "busy" } },
      children: { ses_root: [{ id: "ses_c1", title: "helper" }] },
      messages: { ses_root: root, ses_c1: childRunning ? [...childFinal.slice(0, 2), running("ca2", 12, "bash")] : childFinal },
    };
  });
  const events: Event[] = [];
  const flushes: Array<{ at: number; final: unknown }> = [];
  const observers = createSessionObservers();
  cleanups.push(() => observers.controller.abort());
  await observeUploadedSession({
    sessionUploader: recordingUploader(() => clock, events, flushes, "a0"),
    archive,
    observers,
    sessionId: "ses_root",
    target,
    timing: { now: () => clock, sleep: async (ms: number) => { clock += ms; }, progressMs: 100_000 },
  });

  const progress = events.filter((event) => event.type === "turn.progress");
  expect(progress.map((event) => (event.data as { reason: string }).reason)).toEqual(["sub_agent_ended", "interval"]);
  expect(progress[0]!.at).toBeGreaterThanOrEqual(70_000);
  expect(progress[0]!.at).toBeLessThan(85_000);

  // The sub-agent: all but its newest message as soon as it ended, the newest at the turn's end;
  // its checkpoint moves only then, as without progress.
  const childEvents = events.filter((event) => event.type === "session.child");
  expect(childEvents.map((event) => ids((event.data as { messages: unknown }).messages))).toEqual([["cu1", "ca1", "ca2"], ["ca3"]]);
  expect(childEvents[0]!.at).toBeLessThan(85_000);
  expect(childEvents[1]!.at).toBeGreaterThanOrEqual(300_000);
  expect(childEvents.map((event) => (event.data as { lastMessageId: string | null }).lastMessageId)).toEqual([null, "ca3"]);

  const ahead = events.filter((event) => event.type === "turn.messages" && (event.data as { progress?: boolean }).progress === true);
  expect(ahead.map((event) => ids((event.data as { messages: unknown }).messages))).toEqual([["u1"], ["a1"]]);
  const end = flushes.filter((flush) => flush.final);
  expect(end.length).toBe(1);
  const final = end[0]!.final as { messages: Message[] };
  expect(ids(final.messages)).toEqual(["a1", "a2"]);
  expect((final.messages[0]!.parts.at(-1) as { type: string }).type).toBe("patch");
  expect(end[0]!.at).toBeGreaterThanOrEqual(300_000);
  expect(end[0]!.at).toBeLessThan(315_000);
  for (const event of progress) expect(flushes.some((flush) => flush.at === event.at && !flush.final)).toBe(true);
});

test("progress off (OMNIRUSH_TURN_PROGRESS_MS=0): the turn's end alone, as before", async () => {
  let clock = 0;
  const target = scriptedEngine(() => ({
    statuses: clock >= 300_000 ? {} : { ses_root: { type: "busy" }, ses_c1: { type: clock < 70_000 ? "busy" : "idle" } },
    children: { ses_root: [{ id: "ses_c1", title: "helper" }] },
    messages: {
      ses_root: [user("u1", "go", 2), clock < 300_000 ? running("a1", 3) : done("a1", 3)],
      ses_c1: [user("cu1", "research", 10), done("ca1", 11)],
    },
  }));
  const events: Event[] = [];
  const flushes: Array<{ at: number; final: unknown }> = [];
  const observers = createSessionObservers();
  cleanups.push(() => observers.controller.abort());
  await observeUploadedSession({
    sessionUploader: recordingUploader(() => clock, events, flushes, null),
    archive,
    observers,
    sessionId: "ses_root",
    target,
    timing: { now: () => clock, sleep: async (ms: number) => { clock += ms; }, progressMs: 0 },
  });
  expect(events.filter((event) => event.type === "turn.progress" || (event.type === "turn.messages" && (event.data as { progress?: boolean }).progress)).length).toBe(0);
  expect(events.filter((event) => event.type === "session.child").length).toBe(1);
  expect(ids((flushes.filter((flush) => flush.final).at(-1)!.final as { messages: unknown }).messages)).toEqual(["u1", "a1"]);
});

test("what the turn's context collects after its end goes out once it is in, not at the next prompt", async () => {
  let clock = 0;
  const target = scriptedEngine(() => ({ statuses: clock >= 5_000 ? {} : { ses_root: { type: "busy" } }, children: {}, messages: { ses_root: [user("u1", "go", 1), clock >= 5_000 ? done("a1", 2) : running("a1", 2)] } }));
  const events: Event[] = [];
  const flushes: Array<{ at: number; final: unknown }> = [];
  let release: () => void = () => undefined;
  const contextIn = new Promise<void>((resolve) => { release = resolve; });
  const uploader = recordingUploader(() => clock, events, flushes, null) as unknown as Record<string, unknown>;
  uploader.context = { settled: async (_id: string, waitMs: number) => { expect(waitMs).toBeGreaterThanOrEqual(10_000); await contextIn; } };
  const observers = createSessionObservers();
  cleanups.push(() => observers.controller.abort());
  await observeUploadedSession({
    sessionUploader: uploader as unknown as ObservedUploader,
    archive,
    observers,
    sessionId: "ses_root",
    target,
    timing: { now: () => clock, sleep: async (ms: number) => { clock += ms; } },
  });
  expect(flushes.map((flush) => (flush.final ? "turn" : "plain"))).toEqual(["turn"]);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  expect(flushes.map((flush) => (flush.final ? "turn" : "plain"))).toEqual(["turn", "plain"]);
});
