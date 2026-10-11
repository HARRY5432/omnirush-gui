import { expect } from "vitest";
import { startSerializedTurnLab } from "@omnirush/labs";
import { needs, test } from "@omnirush/testkit";

test("serialized turns reject overlaps and verify the complete delegated tree before continuation", { timeout: 120_000 }, async ({ evidence }) => {
  needs({ placement: "local", commands: ["bun"] });
  const lab = await startSerializedTurnLab();
  const root = "ses_serialized_root", child = "ses_serialized_child", grandchild = "ses_serialized_grandchild";
  const headers = { authorization: "Bearer " + lab.token, "content-type": "application/json" };
  const control = async (action: string, body: unknown = {}) => {
    const response = await fetch(lab.controlUrl + "/control/" + action, { method: action === "witness" ? "GET" : "POST", headers, ...(action !== "witness" ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
    expect(response.ok).toBe(true);
    return response.json();
  };
  const send = (id: string, action = "prompt_async", auth = headers) => fetch(lab.baseUrl + "/workspace/ws_serialized/opencode/session/" + id + "/" + action, {
    method: "POST", headers: auth, body: JSON.stringify({ parts: [{ type: "text", text: "Build the invoice CLI." }] }), signal: AbortSignal.timeout(35_000),
  });
  try {
    expect((await send(root, "prompt_async", { ...headers, authorization: "Bearer invalid" })).status).toBe(401);
    expect((await control("witness")).prompts).toHaveLength(0);
    await control("state", { busy: [grandchild] });
    expect((await send(root)).status).toBe(409);
    expect((await send(child)).status).toBe(409);
    expect((await control("witness")).prompts).toHaveLength(0);
    // Idle status alone is not enough while a tool is still marked running.
    await control("state", { busy: [], runningTool: true });
    expect((await send(root)).status).toBe(409);
    await control("state", { busy: [grandchild], failStop: grandchild });
    expect((await send(root, "abort")).status).toBe(503);
    expect((await send(root)).status).toBe(409);
    await control("state", { failStop: null });
    expect((await send(root, "abort")).status).toBe(200);
    const stopped = await control("witness");
    expect(stopped.aborts).toEqual(expect.arrayContaining([root, child, grandchild]));
    expect((await send(root)).status).toBe(204);
    expect((await send(root)).status).toBe(409);
    expect((await control("witness")).prompts).toHaveLength(1);
    expect((await send(root, "abort")).status).toBe(200);
    // Reverting a paused prompt would erase evidence; correction is a new engine message in the same group.
    expect((await send(root, "revert")).status).toBe(409);
    expect((await send(root)).status).toBe(204);
    await control("complete");
    expect((await send(root)).status).toBe(204);
    expect((await control("witness")).prompts).toHaveLength(3);
    expect((await send(root, "abort")).status).toBe(200);
    await control("state", { hideActivity: true });
    expect((await send(root)).status).toBe(503);
    await control("state", { hideActivity: false, delayedPrompt: true });
    expect((await send(root)).status).toBe(204);
    // Async acceptance with a stale idle/history response must retain its reservation.
    expect((await send(root)).status).toBe(409);
    evidence.recordAssertionEvidence(
      "Only a settled root and delegated tree admit the next prompt",
      "Unauthorized and overlapping root/child requests never reached the engine; pending tools blocked idle status; failed grandchild Stop stayed blocked; verified tree Stop allowed correction, forbade destructive revert, and natural completion enabled a new prompt. Stale idle after async acceptance stayed blocked.",
      true,
    );
  } finally { await lab.stop(); }
});
