import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { OmniRushApprovalMode, OmniRushRuntimeApprovals } from "../src/app/lib/omnirush-server";
import {
  applyApprovalMode,
  applyFullPermissions,
  approvalModeLabel,
  type ApprovalsClient,
} from "../src/react-app/domains/settings/approval-mode";
import { ApprovalsCard, BestPracticesCard, GeneralSettingsView } from "../src/react-app/domains/settings/pages/general-view";
import { BEST_PRACTICES_HELP, bestPracticesChangeMessage, type BestPracticesClient } from "../src/react-app/domains/settings/best-practices";

function fakeClient(options: { reloadError?: Error } = {}) {
  const calls: string[] = [];
  let approvals: OmniRushRuntimeApprovals = { mode: "guarded", source: "default", setting: null };
  const client: ApprovalsClient = {
    getRuntimeApprovals: async () => approvals,
    setRuntimeApprovals: async (mode: OmniRushApprovalMode) => {
      calls.push(`set:${mode}`);
      approvals = { mode, source: "settings", setting: mode };
      return { ...approvals, ok: true, changed: true };
    },
    reloadEngine: async (workspaceId: string) => {
      calls.push(`reload:${workspaceId}`);
      if (options.reloadError) throw options.reloadError;
      return { ok: true };
    },
  };
  return { client, calls };
}

/** The Base UI switch root: `aria-checked` carries the mode, `aria-disabled` the locked state. */
function switchMarkup(markup: string): string {
  const match = markup.match(/<[a-z]+[^>]*role="switch"[^>]*>/);
  if (!match) throw new Error(`no switch in ${markup}`);
  return match[0];
}

/** The mode buttons of the Permissions card: `aria-checked` carries the mode, `disabled` the locked state. */
function modeButton(markup: string, mode: OmniRushApprovalMode): string {
  const match = markup.match(new RegExp(`<button[^>]*data-testid="approval-mode-${mode}"[^>]*>`));
  if (!match) throw new Error(`no ${mode} button in ${markup}`);
  return match[0];
}

describe("permissions settings card", () => {
  test("shows Careful / Normal / Auto with the selected mode's summary", () => {
    const markup = renderToStaticMarkup(
      <ApprovalsCard approvals={{ mode: "full", source: "settings", setting: "full" }} busy={false} status="" onSelect={() => {}} />,
    );
    expect(markup).toContain("Permissions");
    expect(markup).toContain('role="radiogroup"');
    for (const [mode, title] of [["careful", "Careful"], ["guarded", "Normal"], ["full", "Auto"]] as const) {
      expect(modeButton(markup, mode)).toContain('role="radio"');
      expect(markup).toContain(`>${title}</button>`);
    }
    expect(modeButton(markup, "full")).toContain('aria-checked="true"');
    expect(modeButton(markup, "guarded")).toContain('aria-checked="false"');
    expect(modeButton(markup, "careful")).not.toContain('disabled=""');
    expect(markup).toContain(approvalModeLabel("full").summary);
    expect(markup).not.toContain("Set by environment");

    const normal = renderToStaticMarkup(
      <ApprovalsCard approvals={{ mode: "guarded", source: "default", setting: null }} busy={false} status="Normal mode. Engine reloaded." onSelect={() => {}} />,
    );
    expect(modeButton(normal, "guarded")).toContain('aria-checked="true"');
    expect(normal).toContain("Asks only before risky actions");
    expect(normal).toContain("Normal mode. Engine reloaded.");

    const careful = renderToStaticMarkup(
      <ApprovalsCard approvals={{ mode: "careful", source: "settings", setting: "careful" }} busy={false} status="" onSelect={() => {}} />,
    );
    expect(modeButton(careful, "careful")).toContain('aria-checked="true"');
    expect(careful).toContain("Asks before every file change and every command.");
  });

  test("disables the choice and says so while the environment or the organisation forces the mode", () => {
    const markup = renderToStaticMarkup(
      <ApprovalsCard approvals={{ mode: "full", source: "environment", setting: "guarded" }} busy={false} status="" onSelect={() => {}} />,
    );
    expect(modeButton(markup, "full")).toContain('aria-checked="true"');
    for (const mode of ["careful", "guarded", "full"] as const) expect(modeButton(markup, mode)).toContain('disabled=""');
    expect(markup).toContain("Set by environment (OMNIRUSH_APPROVALS=full)");
    const locked = renderToStaticMarkup(
      <ApprovalsCard approvals={{ mode: "guarded", source: "default", setting: null }} busy={false} status="" onSelect={() => {}} policyLocked />,
    );
    expect(modeButton(locked, "careful")).toContain('disabled=""');
    expect(locked).toContain("Locked by your organisation");
    // Nothing is claimed before the server has answered.
    const loading = renderToStaticMarkup(<ApprovalsCard approvals={null} busy={false} status="" onSelect={() => {}} />);
    expect(modeButton(loading, "guarded")).toContain('disabled=""');
    expect(modeButton(loading, "guarded")).toContain('aria-checked="false"');
  });

  test("choosing persists the mode, then reloads the workspace engine", async () => {
    const { client, calls } = fakeClient();
    const careful = await applyApprovalMode(client, "ws_1", "careful");
    expect(calls).toEqual(["set:careful", "reload:ws_1"]);
    expect(careful.approvals).toEqual({ mode: "careful", source: "settings", setting: "careful" });
    expect(careful.status).toBe("Careful mode. Engine reloaded.");
    expect(careful.tone).toBe("success");

    const on = await applyFullPermissions(client, "ws_1", true);
    expect(calls.slice(2)).toEqual(["set:full", "reload:ws_1"]);
    expect(on.status).toBe("Auto mode. Engine reloaded.");

    const off = await applyFullPermissions(client, "ws_1", false);
    expect(calls.slice(4)).toEqual(["set:guarded", "reload:ws_1"]);
    expect(off.status).toBe("Normal mode. Engine reloaded.");
    expect(off.tone).toBe("success");
    expect(await client.getRuntimeApprovals()).toEqual({ mode: "guarded", source: "settings", setting: "guarded" });
  });

  test("keeps the saved setting and explains when the reload fails or no workspace is active", async () => {
    const failing = fakeClient({ reloadError: new Error("engine busy") });
    const result = await applyApprovalMode(failing.client, "ws_1", "full");
    expect(failing.calls).toEqual(["set:full", "reload:ws_1"]);
    expect(result.approvals.mode).toBe("full");
    expect(result.status).toBe("Auto mode. Engine reload failed: engine busy Use Reload in Settings to apply it.");
    expect(result.tone).toBe("warning");

    const idle = fakeClient();
    const saved = await applyApprovalMode(idle.client, null, "careful");
    expect(idle.calls).toEqual(["set:careful"]);
    expect(saved.status).toBe("Careful mode. Reload the engine to apply it.");
    expect(saved.tone).toBe("warning");
  });
});

describe("best practices settings card", () => {
  test("shows the global guide switch while the workspace client is still loading", () => {
    const bestPracticesClient: BestPracticesClient = {
      getBestPractices: async () => ({ enabled: true }),
      setBestPractices: async (enabled) => ({ ok: true, changed: true, enabled, engine: { status: "applied" } }),
    };
    const markup = renderToStaticMarkup(
      <GeneralSettingsView
        developerMode={false}
        onNavigateTab={() => {}}
        omnirushClient={null}
        bestPracticesClient={bestPracticesClient}
      />,
    );
    expect(switchMarkup(markup)).toContain('aria-label="Best practices"');
    expect(switchMarkup(markup)).toContain('aria-disabled="true"');
    expect(markup).not.toContain('data-testid="approvals-card"');
  });

  test("labels the switch, describes only guides, and waits for the server choice", () => {
    const on = renderToStaticMarkup(<BestPracticesCard enabled={true} busy={false} status="" onToggle={() => {}} />);
    expect(on).toContain(BEST_PRACTICES_HELP);
    expect(switchMarkup(on)).toContain('aria-label="Best practices"');
    expect(switchMarkup(on)).toContain('aria-describedby="best-practices-help"');
    expect(switchMarkup(on)).toContain('aria-checked="true"');
    expect(on.toLowerCase()).not.toContain("upload");
    const loading = renderToStaticMarkup(<BestPracticesCard enabled={null} busy={false} status="" onToggle={() => {}} />);
    expect(switchMarkup(loading)).toContain('aria-disabled="true"');
    const off = renderToStaticMarkup(<BestPracticesCard enabled={false} busy={true} status="Saving best practices…" onToggle={() => {}} />);
    expect(switchMarkup(off)).toContain('aria-checked="false"');
    expect(switchMarkup(off)).toContain('aria-disabled="true"');
    expect(off).toContain('role="status"');
  });

  test("distinguishes applied, deferred, failed, and not started choices", () => {
    const result = { ok: true, changed: true, enabled: false };
    expect(bestPracticesChangeMessage({ ...result, engine: { status: "applied" } })).toBe("Best practices off. Ready for your next request.");
    expect(bestPracticesChangeMessage({ ...result, engine: { status: "deferred" } })).toBe("Best practices off saved. This change waits until the engine is idle.");
    expect(bestPracticesChangeMessage({ ...result, engine: { status: "failed" } })).toBe("Best practices off saved. The engine change could not be confirmed. Use Reload in Settings to apply it.");
    expect(bestPracticesChangeMessage({ ...result, engine: { status: "unconfigured" } })).toBe("Best practices off saved. The choice will apply when the engine starts.");
  });
});
