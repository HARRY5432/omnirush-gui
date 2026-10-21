import { afterEach, describe, expect, test } from "bun:test";

import { APP_SECRET_HEADER, APP_SECRET_KEY, appRequestRefusal, needsApp, normalizedRequestPath } from "./app-request-gate.js";

const SECRET = "a".repeat(64);
const g = globalThis as Record<symbol, unknown>;
afterEach(() => { delete g[APP_SECRET_KEY]; });

const refused = (method: string, path: string, secret?: string) =>
  appRequestRefusal(method, path, new Headers(secret === undefined ? {} : { [APP_SECRET_HEADER]: secret })) !== null;

describe("settings writes need the app", () => {
  const writes: Array<[string, string]> = [
    ["PUT", "/runtime-config/approvals"],
    ["PUT", "/runtime-config/agent-assist"],
    ["PATCH", "/runtime-config/providers"],
    ["PUT", "/workspace/ws_1/permissions/mode"],
    ["PATCH", "/workspace/ws_1/config"],
    ["POST", "/workspace/ws_1/opencode-config"],
    ["PUT", "/workspace/ws_1/authorized-folders"],
    ["PUT", "/workspace/ws_1/box"],
    ["POST", "/workspace/ws_1/plugins"],
    ["POST", "/workspace/ws_1/skills"],
    ["POST", "/workspace/ws_1/commands"],
    ["POST", "/workspace/ws_1/mcp"],
    ["POST", "/workspace/ws_1/mcp/notes/enabled"],
    ["DELETE", "/workspace/ws_1/mcp/notes"],
    ["POST", "/workspace/ws_1/runtime-config/disabled-providers"],
    ["POST", "/workspace/ws_1/local-workflows"],
    ["POST", "/tokens"],
    ["PUT", "/env"],
    ["POST", "/approvals/apr_1"],
    ["POST", "/workspaces/remote"],
    ["PUT", "/experimental/engine-v2-preview"],
    ["POST", "/experimental/ui-control/req_1/reply"],
    ["PUT", "/omnirush/subagent-model"],
    // approval answers and the engine's own settings, through every proxy mount
    ["POST", "/opencode/permission/per_1/reply"],
    ["POST", "/workspace/ws_1/opencode/permission/per_1/reply"],
    ["POST", "/w/ws_1/opencode/session/ses_1/permissions/per_1"],
    ["POST", "/workspace/ws_1/opencode2/api/permission/per_1/reply"],
    ["POST", "/workspace/ws_1/opencode/question/q_1/reject"],
    ["PATCH", "/opencode/config"],
    ["PUT", "/opencode/auth/openai"],
    ["POST", "/opencode/mcp"],
    ["POST", "/opencode/session/ses%2Fx/permissions/per_1"],
    ["POST", "/workspace/ws_1/opencode/session/ses%2Fx/permissions/per_1"],
    ["POST", "/workspace/ws_1/opencode2/api/session/ses_1/form/f_1/reply"],
    ["POST", "/workspace/ws_1/opencode2/api/session/ses_1/form/f_1/cancel"],
    ["PATCH", "/workspace/ws_1/opencode2/api/config"],
    ["POST", "/workspace/ws_1/opencode2/api/mcp"],
    ["POST", "/workspace/ws_1/opencode2/api/provider"],
    ["PUT", "/workspace/ws_1/opencode2/api/model/default"],
    // a mounted base URL and path tricks
    ["PUT", "/w/ws_1/runtime-config/approvals"],
    ["PUT", "/x/../runtime-config/approvals"],
    ["PUT", "/runtime-config%2Fapprovals"],
    ["PUT", "//runtime-config/approvals"],
    ["PUT", "/runtime-config/approvals;x"],
    ["PUT", "/runtime-config\\approvals"],
    ["PUT", "/%E0%A4%A"],
  ];
  const reads: Array<[string, string]> = [["GET", "/env"], ["GET", "/env/OPENAI_API_KEY"], ["GET", "/runtime-config/providers"], ["GET", "/tokens"]];
  const open: Array<[string, string]> = [
    ["GET", "/runtime-config/approvals"],
    ["GET", "/workspace/ws_1/config"],
    ["GET", "/workspaces"],
    ["OPTIONS", "/runtime-config/approvals"],
    ["POST", "/managed-policy/evaluate"],
    ["POST", "/omnirush/subagent-model/resolve"],
    ["POST", "/experimental/ui-control/request"],
    ["POST", "/experimental/extensions/call"],
    ["POST", "/session-upload/events"],
    ["POST", "/mcp/managed/ws_1/notes"],
    ["POST", "/workspace/ws_1/mcp-apps/call"],
    ["POST", "/workspace/ws_1/opencode/session"],
    ["POST", "/workspace/ws_1/opencode/session/ses_1/prompt_async"],
    ["GET", "/workspace/ws_1/opencode/permission"],
    ["PUT", "/workspace/ws_1/editor/file"],
  ];

  test("with the app's secret configured: refused without it, allowed with it", () => {
    g[APP_SECRET_KEY] = SECRET;
    for (const [method, path] of [...writes, ...reads]) {
      expect([method, path, refused(method, path)]).toEqual([method, path, true]);
      expect([method, path, refused(method, path, SECRET)]).toEqual([method, path, false]);
      expect([method, path, refused(method, path, "b".repeat(64))]).toEqual([method, path, true]);
    }
    for (const [method, path] of open) expect([method, path, refused(method, path)]).toEqual([method, path, false]);
  });

  test("a server run on its own (no secret) is unchanged", () => {
    for (const [method, path] of [...writes, ...reads]) expect(refused(method, path)).toBe(false);
    expect(needsApp("PUT", "/runtime-config/approvals")).toBe(true);
  });

  test("paths are read the way routes read them", () => {
    expect(normalizedRequestPath("/w/ws_1/workspace/ws_1/plugins")).toBe("/workspace/ws_1/plugins");
    expect(normalizedRequestPath("/x/%2e%2e/tokens")).toBe("/tokens");
    expect(normalizedRequestPath("/%E0%A4%A")).toBeNull();
  });
});
