import { expect } from "vitest";
import { startCaptureEfficiencyLab, type CaptureEfficiencyAttempt, type CaptureEfficiencyLab, type CaptureEfficiencyWitness } from "@omnirush/labs";
import { eventually, needs, test } from "@omnirush/testkit";

const SESSION_A = "session-a-0001";
const SESSION_B = "session-b-0001";

async function postControl(lab: CaptureEfficiencyLab, path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${lab.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${lab.controlToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  expect(response.status, text).toBe(202);
}

function attemptsFor(witness: CaptureEfficiencyWitness, sessionId: string): CaptureEfficiencyAttempt[] {
  return witness.attempts.filter((attempt) => attempt.sessionId === sessionId);
}

function acceptedTrace(witness: CaptureEfficiencyWitness, sessionId: string): CaptureEfficiencyAttempt {
  const trace = attemptsFor(witness, sessionId).find((attempt) => attempt.snapshotType === "trace" && attempt.status === 201);
  if (!trace) throw new Error(`accepted trace for ${sessionId} was not observed`);
  return trace;
}

test("capture worker uploads ordered, scoped trace artifacts at the HTTP collector boundary", { timeout: 60_000 }, async ({ evidence }) => {
  needs({ placement: "local", commands: ["bun"] });
  const lab = await startCaptureEfficiencyLab();
  try {
    const initial = await lab.witness();
    const unauthorized = await fetch(`${lab.baseUrl}/witness`, { signal: AbortSignal.timeout(5_000) });
    expect(unauthorized.status).toBe(401);
    expect((await lab.witness()).attempts).toHaveLength(initial.attempts.length);
    evidence.recordAssertionEvidence(
      "Capture controls and collector witness require the lab bearer",
      "An unauthenticated HTTP witness request returned 401 and did not alter the outbound request record.",
      true,
    );

    await postControl(lab, "/control/start", { sessionId: SESSION_A, actor: "actor-a", workspace: "workspace-a" });
    await postControl(lab, "/control/trace", {
      sessionId: SESSION_A,
      type: "engine.request",
      data: { actor: "actor-a", workspace: "workspace-a", marker: "request-a" },
    });
    await postControl(lab, "/control/trace", {
      sessionId: SESSION_A,
      type: "turn.messages",
      data: {
        actor: "actor-a",
        workspace: "workspace-a",
        messages: [{ role: "assistant", parts: [{ type: "tool", tool: "apply_patch", state: { input: { path: "notes-a.txt" } } }] }],
      },
    });
    await postControl(lab, "/control/trace", {
      sessionId: SESSION_A,
      type: "turn.completed",
      data: { actor: "actor-a", workspace: "workspace-a", turn: 1 },
    });
    await postControl(lab, "/control/flush", { sessionId: SESSION_A });

    await postControl(lab, "/control/start", { sessionId: SESSION_B, actor: "actor-b", workspace: "workspace-b" });
    await postControl(lab, "/control/trace", {
      sessionId: SESSION_B,
      type: "engine.request",
      data: { actor: "actor-b", workspace: "workspace-b", marker: "request-b" },
    });
    await postControl(lab, "/control/trace", {
      sessionId: SESSION_B,
      type: "turn.completed",
      data: { actor: "actor-b", workspace: "workspace-b", turn: 1 },
    });
    await postControl(lab, "/control/flush", { sessionId: SESSION_B });

    await postControl(lab, "/control/complete", { sessionId: SESSION_A });
    await postControl(lab, "/control/complete", { sessionId: SESSION_B });

    const witness = await eventually(() => lab.witness(), {
      within: 20_000,
      intervalMs: 100,
      label: "capture worker collector requests",
      until: (current) => [SESSION_A, SESSION_B].every(id => current.attempts.some(attempt => attempt.sessionId === id && attempt.snapshotType === "end" && attempt.status === 201)),
    });

    expect(witness.modes).toEqual(["worker", "worker"]);
    const traceA = acceptedTrace(witness, SESSION_A);
    const traceB = acceptedTrace(witness, SESSION_B);
    const traceAttemptsA = attemptsFor(witness, SESSION_A).filter((attempt) => attempt.snapshotType === "trace" && attempt.traceTypes.includes("engine.request"));
    const traceAttemptsB = attemptsFor(witness, SESSION_B).filter((attempt) => attempt.snapshotType === "trace" && attempt.traceTypes.includes("engine.request"));

    expect(traceAttemptsA.map((attempt) => [attempt.status, attempt.schemaVersion])).toEqual([[422, 3], [201, 2]]);
    expect(traceAttemptsB.map((attempt) => [attempt.status, attempt.schemaVersion])).toEqual([[201, 3]]);
    expect(traceB.filePaths).toEqual([]);
    expect(traceB.traceFileCount).toBe(0);
    expect(traceB.traceTypes.filter(type => ["engine.request", "turn.completed"].includes(type))).toEqual(["engine.request", "turn.completed"]);
    expect(traceA.schemaVersion).toBe(2);
    expect(traceA.traceTypes.filter(type => ["engine.request", "turn.messages", "turn.completed"].includes(type))).toEqual(["engine.request", "turn.messages", "turn.completed"]);
    expect(traceA.traceFileCount).toBe(1);
    expect(traceA.traceFileEventTypes).toEqual(traceA.traceTypes);
    evidence.recordAssertionEvidence(
      "Canonical schema 3 is emitted without a duplicate trace artifact",
      "The accepted actor-b trace request used schema 3 with files=[] and no legacy trace file; its ordered events were emitted once.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Unsupported schema 3 downgrades the same ordered batch to legacy schema 2",
      "Actor-a received one 422 unsupported-schema attempt followed by one schema-2 trace with exactly one trace.json whose event order matched the canonical batch.",
      true,
    );

    const actorAAttempts = attemptsFor(witness, SESSION_A).filter((attempt) => attempt.status === 201);
    const actorBAttempts = attemptsFor(witness, SESSION_B).filter((attempt) => attempt.status === 201);
    for (const attempts of [actorAAttempts, actorBAttempts]) {
      expect(attempts[0]?.snapshotType).toBe("start");
      expect(attempts.at(-1)?.snapshotType).toBe("end");
      expect(attempts.slice(1, -1).every(attempt => attempt.snapshotType === "trace")).toBe(true);
    }
    expect(actorAAttempts.every((attempt) => attempt.workspaceRoot === "workspace-a")).toBe(true);
    expect(actorBAttempts.every((attempt) => attempt.workspaceRoot === "workspace-b")).toBe(true);
    expect(actorAAttempts.every((attempt) => attempt.actorMarkers.every((actor) => actor === "actor-a"))).toBe(true);
    expect(actorBAttempts.every((attempt) => attempt.actorMarkers.every((actor) => actor === "actor-b"))).toBe(true);
    expect(actorAAttempts[0]?.filePaths).toContain("notes-a.txt");
    expect(actorAAttempts[0]?.filePaths).not.toContain("notes-b.txt");
    expect(actorBAttempts[0]?.filePaths).toContain("notes-b.txt");
    expect(actorBAttempts[0]?.filePaths).not.toContain("notes-a.txt");
    expect(traceA.actorMarkers).toEqual(["actor-a", "actor-a", "actor-a"]);
    expect(traceB.actorMarkers).toEqual(["actor-b", "actor-b"]);
    expect(witness.capabilityCalls).toEqual({ "actor-a": 1, "actor-b": 1 });
    evidence.recordAssertionEvidence(
      "Capture records preserve completion order and actor/workspace scope",
      "Each synthetic session produced start, trace batches, and end in order; trace markers and workspace roots stayed within their owning actor, with one capability probe per worker.",
      true,
    );
  } finally {
    await lab.stop();
  }
});


test("capture worker retains the original turn baseline across Stop and correction", { timeout: 60_000 }, async ({ evidence }) => {
  needs({ placement: "local", commands: ["bun"] });
  const lab = await startCaptureEfficiencyLab();
  const sessionId = "session-logical-turn-0001";
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  try {
    await postControl(lab, "/control/start", { sessionId, actor: "actor-b", workspace: "workspace-b" });
    await postControl(lab, "/control/turn", { sessionId, action: "begin" });
    await postControl(lab, "/control/write", { sessionId, content: "print('partial')\n" });
    await postControl(lab, "/control/turn", { sessionId, action: "pause",
      finalTrace: { messages: [{ info: { id: "user-original", role: "user" }, parts: [{ type: "text", text: "Build the invoice CLI." }] }] },
    });
    await postControl(lab, "/control/turn", { sessionId, action: "begin" });
    await postControl(lab, "/control/write", { sessionId, content: "print('complete')\n" });
    await postControl(lab, "/control/turn", { sessionId, action: "complete",
      finalTrace: { messages: [{ info: { id: "user-correction", role: "user" }, parts: [{ type: "text", text: "Continue with JSON output." }] }] },
    });
    await postControl(lab, "/control/turn", { sessionId, action: "begin" });
    const accepted = attemptsFor(await lab.witness(), sessionId).filter(attempt => attempt.status === 201);
    const events = accepted.flatMap(attempt => attempt.events);
    const groups = events.filter(event => event.type === "collector.replay_group").map(event => event.data).filter(record);
    const starts = groups.filter(group => group.phase === "start");
    expect(starts).toHaveLength(2);
    expect(starts[0]?.group_id).not.toBe(starts[1]?.group_id);
    expect(starts[0]?.baseline_snapshot).toBeDefined();
    const resumed = groups.find(group => group.phase === "resumed");
    const completed = groups.find(group => group.phase === "completed");
    expect(resumed?.group_id).toBe(starts[0]?.group_id);
    expect(completed?.group_id).toBe(starts[0]?.group_id);
    expect(resumed?.baseline_snapshot).toEqual(starts[0]?.baseline_snapshot);
    expect(completed?.baseline_snapshot).toEqual(starts[0]?.baseline_snapshot);
    expect(completed?.message_ids).toEqual(["user-original", "user-correction"]);
    expect(completed?.prompt_count).toBe(2);
    const diffs = events.filter(event => event.type === "turn.diff").map(event => event.data).filter(record);
    const groupedDiffs = diffs.filter(diff => diff.replay_group_id === starts[0]?.group_id);
    expect(groupedDiffs).toHaveLength(2);
    // Both partial and final diffs still describe cli.py as added to the ORIGINAL baseline.
    for (const diff of groupedDiffs) {
      expect(JSON.stringify(diff)).toContain('"path":"cli.py"');
      expect(JSON.stringify(diff)).toContain('"status":"added"');
    }
    expect(accepted.some(attempt => attempt.filePaths.includes("cli.py"))).toBe(true);
    const transcript = JSON.stringify(events.filter(event => event.type === "turn.completed"));
    expect(transcript).toContain("Build the invoice CLI.");
    expect(transcript).toContain("Continue with JSON output.");
    evidence.recordAssertionEvidence(
      "Stop and correction retain one original capture baseline and both prompts",
      "Worker uploads kept one group and baseline pointer through Stop/resume, cli.py remained added in both diffs, and both original and correction text survived. Only natural completion allowed the next distinct group.",
      true,
    );
  } finally { await lab.stop(); }
});
