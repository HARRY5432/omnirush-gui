import { expect } from "vitest";
import { browserScript, spec } from "@omnirush/testkit";
import { shimmerChat } from "../worlds/chat.ts";

const test = spec.world(shimmerChat);

test("a quota handoff waits for a choice, honors decline, and offers again after the allowance changes", async ({ user, probe, step, evidence }) => {
  const offer = (offerID: string, operation = "offer") => probe.eval(
    browserScript(async (inputOfferID: string, inputOperation: string) => {
      const control = window.__omnirushControl;
      const connection = {
        port: localStorage.getItem("omnirush.server.port"),
        token: localStorage.getItem("omnirush.server.token"),
      };
      if (!control || !connection.port || !connection.token) throw new Error("Desktop control server unavailable");
      const response = await fetch(`http://127.0.0.1:${connection.port}/experimental/ui-control/request`, {
        method: "POST",
        headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "query", input: {
          id: "budget.wrap.update",
          args: { sessionID: "ses_budget_journey", offerID: inputOfferID, scopes: "day,week", operation: inputOperation },
        } }),
      });
      if (!response.ok) throw new Error(`Control mailbox returned ${response.status}`);
      return response.json();
    }, [offerID, operation]),
    { awaitPromise: true },
  );
  const dismissed = () => probe.eventually(
    () => probe.eval(() => !document.querySelector('[data-testid="budget-wrap-consent"]')),
    { within: 10_000, until: (value) => value === true, label: "wrap dialog exit animation finished" },
  );

  await step("the offer stays visible until answered", async () => {
    expect(await offer("allowance-one")).toMatchObject({ ok: true, result: { choice: "pending" } });
    await user.see({ testId: "budget-wrap-consent" });
    await user.see({ role: "button", label: "Wrap up" });
    await user.see({ role: "button", label: "Keep working" });
    expect(await offer("allowance-one")).toMatchObject({ ok: true, result: { choice: "pending" } });
    await user.see({ testId: "budget-wrap-consent" });
  });

  await step("declining suppresses that allowance's offer", async () => {
    await user.click({ role: "button", label: "Keep working" });
    await dismissed();
    await user.notSee({ testId: "budget-wrap-consent" });
    expect(await offer("allowance-one")).toMatchObject({ ok: true, result: { choice: "decline" } });
    await user.notSee({ testId: "budget-wrap-consent" });
  });

  await step("a changed allowance asks again, and acceptance closes the offer", async () => {
    expect(await offer("allowance-two")).toMatchObject({ ok: true, result: { choice: "pending" } });
    await user.see({ testId: "budget-wrap-consent" });
    await user.click({ role: "button", label: "Wrap up" });
    await dismissed();
    await user.notSee({ testId: "budget-wrap-consent" });
    expect(await offer("allowance-two")).toMatchObject({ ok: true, result: { choice: "accept" } });
    expect(await offer("allowance-two", "finish")).toMatchObject({ ok: true });
    expect(await offer("allowance-two")).toMatchObject({ ok: true, result: { choice: "done" } });
  });

  await step("a full app restart waits for the server to renew an unanswered offer", async () => {
    expect(await offer("allowance-three")).toMatchObject({ ok: true, result: { choice: "pending" } });
    await user.see({ testId: "budget-wrap-consent" });
    await user.reload();
    await probe.eventually(
      () => probe.eval(() => window.__omnirushControl?.listActions().some((action) => action.id === "budget.wrap.update")),
      { within: 15_000, until: (value) => value === true, label: "wrap control after reload" },
    );
    await user.notSee({ testId: "budget-wrap-consent" });
    expect(await offer("allowance-three")).toMatchObject({ ok: true, result: { choice: "pending" } });
    await user.see({ testId: "budget-wrap-consent" });
    await user.click({ role: "button", label: "Keep working" });
    await dismissed();
  });

  await step("a running turn hides the question until the session is idle", async () => {
    expect(await offer("allowance-four")).toMatchObject({ ok: true, result: { choice: "pending" } });
    await user.see({ testId: "budget-wrap-consent" });
    expect(await offer("allowance-four", "hold")).toMatchObject({ ok: true });
    await dismissed();
    await user.notSee({ testId: "budget-wrap-consent" });
    expect(await offer("allowance-four")).toMatchObject({ ok: true, result: { choice: "pending" } });
    await user.see({ testId: "budget-wrap-consent" });
  });

  await step("a failed wrap is a notice with a retry, never the question again", async () => {
    await user.click({ role: "button", label: "Wrap up" });
    await dismissed();
    expect(await offer("allowance-four", "fail")).toMatchObject({ ok: true });
    await user.see({ text: "Wrap up did not finish" });
    await user.notSee({ testId: "budget-wrap-consent" });
    expect(await offer("allowance-four")).toMatchObject({ ok: true, result: { choice: "failed" } });
    expect(await offer("allowance-four", "clear")).toMatchObject({ ok: true });
    expect(await offer("allowance-four")).toMatchObject({ ok: true, result: { choice: "failed" } });
    await user.notSee({ testId: "budget-wrap-consent" });
    await user.click({ role: "button", label: "Retry" });
    expect(await offer("allowance-four")).toMatchObject({ ok: true, result: { choice: "accept" } });
    await user.notSee({ testId: "budget-wrap-consent" });
  });

  evidence.recordAssertionEvidence(
    "An unanswered wrap stays visible while idle; decline is remembered; a changed allowance asks again; a restart requires renewal; a running turn hides it; a failure is a retry notice",
    "The desktop shell kept the choice open while running. Decline was remembered for that allowance. A changed allowance reopened it; acceptance and completion dismissed it. After a full app reload, an unanswered offer stayed hidden until the server renewed it.",
    true,
  );
});
