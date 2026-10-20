import { expect, test } from "bun:test";

import { NOTICE_TITLES } from "../../server/src/agent-assist/agent-assist.js";
import { AGENT_ASSIST_TOAST_TITLES, agentAssistToast } from "../src/react-app/domains/session/sync/agent-assist-toast";

test("the app shows the agent assist plugin's toasts, and only those", () => {
  expect(AGENT_ASSIST_TOAST_TITLES).toEqual(NOTICE_TITLES);
  expect(agentAssistToast({ title: "Checked", message: "42 tests passed", variant: "success" }, 1_000)).toEqual({ title: "Checked", message: "42 tests passed", variant: "success" });
  // The same toast from a second workspace stream is dropped.
  expect(agentAssistToast({ title: "Checked", message: "42 tests passed", variant: "success" }, 1_500)).toBeNull();
  expect(agentAssistToast({ title: "Checked", message: "42 tests passed", variant: "success" }, 9_000)).not.toBeNull();
  expect(agentAssistToast({ title: "Some engine toast", message: "x" }, 20_000)).toBeNull();
  expect(agentAssistToast(null)).toBeNull();
});
