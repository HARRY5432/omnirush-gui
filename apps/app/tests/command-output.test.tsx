/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DynamicToolUIPart } from "ai";
import type { ToolPart } from "@opencode-ai/sdk/v2/client";

import {
  boundedCommandOutput,
  getCommandOutput,
  previewCommandOutput,
  splitEngineNotes,
  stripAnsi,
} from "../src/lib/command-output";
import { CommandOutput } from "../src/components/chat/command-output";
import { ToolAggregateGroup } from "../src/components/chat/tool-aggregate-group";
import { CurrentToolLifecycleProvider } from "../src/components/chat/current-tool-lifecycle-context";
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts";

const input = { command: "npm test", description: "Run tests" };

function bash(part: Partial<DynamicToolUIPart> & Pick<DynamicToolUIPart, "state">): DynamicToolUIPart {
  return { type: "dynamic-tool", toolName: "bash", toolCallId: "call-1", input, ...part } as DynamicToolUIPart;
}

function withCommand(command: Record<string, unknown>) {
  return { callProviderMetadata: { opencode: { partId: "p1" }, omnirush: { command } } } as Partial<DynamicToolUIPart>;
}

describe("stripAnsi", () => {
  test("removes colors, cursor moves, titles and links", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m \u001b[1;32mbold\u001b[m")).toBe("red bold");
    expect(stripAnsi("\u001b]0;title\u0007after")).toBe("after");
    expect(stripAnsi("\u001b]8;;https://x.test\u001b\\link\u001b]8;;\u001b\\")).toBe("link");
    expect(stripAnsi("a\u001b[2Kb\u001b[1Ac")).toBe("abc");
  });

  test("keeps the last redraw of a carriage-return progress line", () => {
    expect(stripAnsi("10%\r50%\r100%\ndone")).toBe("100%\ndone");
    expect(stripAnsi("windows\r\nline")).toBe("windows\nline");
    expect(stripAnsi("long text\rX")).toBe("Xong text");
  });

  test("keeps tabs and newlines, drops other control characters", () => {
    expect(stripAnsi("a\tb\nc\u0007\u0008d")).toBe("a\tb\ncd");
  });
});

describe("engine notes", () => {
  test("splits a trailing shell_metadata block into notes", () => {
    expect(splitEngineNotes("out\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>")).toEqual({ text: "out", notes: ["User aborted the command"] });
    expect(splitEngineNotes("plain <shell_metadata> mention")).toEqual({ text: "plain <shell_metadata> mention", notes: [] });
  });
});

describe("getCommandOutput", () => {
  test("ignores other tools", () => {
    expect(getCommandOutput({ ...bash({ state: "output-available", output: "x" }), toolName: "read" } as DynamicToolUIPart)).toBeNull();
  });

  test("a finished command shows its output and exit code", () => {
    const view = getCommandOutput(bash({ state: "output-available", output: "\u001b[32mok\u001b[0m 3 passed\n", ...withCommand({ exit: 0 }) }));
    expect(view).toEqual({ text: "ok 3 passed", running: false, exitCode: 0, notes: [] });
  });

  test("an empty run is reported as no output", () => {
    expect(getCommandOutput(bash({ state: "output-available", output: "(no output)" }))?.text).toBe("");
  });

  test("a running command shows its live metadata output", () => {
    const view = getCommandOutput(bash({ state: "input-available", ...withCommand({ output: "line 1\nline 2" }) }));
    expect(view).toEqual({ text: "line 1\nline 2", running: true, exitCode: null, notes: [] });
    expect(getCommandOutput(bash({ state: "input-available" }))).toEqual({ text: "", running: true, exitCode: null, notes: [] });
  });

  test("a failed call shows output captured before the failure, if any", () => {
    expect(getCommandOutput(bash({ state: "output-error", errorText: "aborted" }))).toBeNull();
    expect(getCommandOutput(bash({ state: "output-error", errorText: "aborted", ...withCommand({ output: "partial" }) }))?.text).toBe("partial");
  });
});

describe("previews", () => {
  test("a short output is shown whole", () => {
    expect(previewCommandOutput("a\nb")).toEqual({ text: "a\nb", hiddenLines: 0, clipped: false, totalLines: 2 });
  });

  test("a long output keeps its last lines", () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const preview = previewCommandOutput(text, 8);
    expect(preview.text.split("\n")).toEqual(Array.from({ length: 8 }, (_, index) => `line ${index + 13}`));
    expect(preview).toMatchObject({ hiddenLines: 12, clipped: true, totalLines: 20 });
  });

  test("one huge line is clipped by characters", () => {
    const preview = previewCommandOutput("x".repeat(5000), 8, 100);
    expect(preview.text.length).toBe(100);
    expect(preview.text.startsWith("…")).toBe(true);
    expect(preview.clipped).toBe(true);
  });

  test("the expanded text is bounded from the end", () => {
    expect(boundedCommandOutput("abcdef", 4)).toEqual({ text: "cdef", omittedChars: 2 });
    expect(boundedCommandOutput("abc", 4)).toEqual({ text: "abc", omittedChars: 0 });
  });
});

describe("CommandOutput card", () => {
  test("renders monospace, newline-preserving output with a failing exit code", () => {
    const markup = renderToStaticMarkup(<CommandOutput output={{ text: "error: boom\nat x", running: false, exitCode: 2, notes: [] }} />);
    expect(markup).toContain("font-mono");
    expect(markup).toContain("whitespace-pre-wrap");
    expect(markup).toContain("error: boom\nat x");
    expect(markup).toContain('data-command-exit="2"');
    expect(markup).toContain("text-destructive");
    expect(markup).not.toContain("data-command-output-toggle");
  });

  test("long output offers to show every line", () => {
    const text = Array.from({ length: 30 }, (_, index) => `l${index}`).join("\n");
    const markup = renderToStaticMarkup(<CommandOutput output={{ text, running: false, exitCode: 0, notes: [] }} />);
    expect(markup).toContain("Show all 30 lines");
    expect(markup).toContain("22 earlier lines");
    expect(markup).not.toContain("l21\n");
    expect(markup).toContain("l29");
  });

  test("a running command says so instead of an exit code", () => {
    const markup = renderToStaticMarkup(<CommandOutput output={{ text: "", running: true, exitCode: null, notes: [] }} />);
    expect(markup).toContain("Running…");
    expect(markup).toContain("Waiting for output…");
    expect(markup).not.toContain("Exit");
  });
});

describe("tool aggregate shows command output", () => {
  test("a collapsed group keeps the output hidden", () => {
    const part = bash({ toolCallId: "agg-collapsed", state: "output-available", output: "secret-ish log" });
    expect(renderToStaticMarkup(<ToolAggregateGroup parts={[part]} />)).not.toContain("data-command-output");
  });

  test("an expanded finished command shows its output under the command", async () => {
    const part = bash({ toolCallId: "agg-done", state: "output-available", output: "hello\nworld", ...withCommand({ exit: 0 }) });
    const markup = await renderExpanded(<ToolAggregateGroup parts={[part]} />);
    expect(markup).toContain("data-command-output");
    expect(markup).toContain("hello\nworld");
    expect(markup).toContain("Exit 0");
  });

  test("a call that is not observed running shows output so far, not a running state", async () => {
    const part = bash({ toolCallId: "agg-unknown", state: "input-available", ...withCommand({ output: "half" }) });
    const markup = await renderExpanded(<ToolAggregateGroup parts={[part]} />);
    expect(markup).toContain("Output so far");
    expect(markup).not.toContain("Running…");
  });

  test("a running observed command streams its output", async () => {
    const part = bash({ toolCallId: "agg-running", state: "input-available", ...withCommand({ output: "step 1" }) });
    const markup = await renderExpanded(
      <CurrentToolLifecycleProvider activityStatus="responding" currentToolCallIds={new Set([part.toolCallId])}>
        <ToolAggregateGroup parts={[part]} />
      </CurrentToolLifecycleProvider>,
    );
    expect(markup).toContain("Running…");
    expect(markup).toContain("step 1");
  });
});

// Groups start collapsed; open one the way a person does, by clicking its summary.
async function renderExpanded(node: React.ReactNode): Promise<string> {
  if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]");
  await act(async () => { toggle?.click(); });
  const html = container.innerHTML;
  await act(async () => { root.unmount(); });
  container.remove();
  return html;
}

describe("session sync forwards command metadata", () => {
  const base = { id: "prt_1", sessionID: "s", messageID: "m", type: "tool", callID: "c1", tool: "bash" } as const;

  test("running output and exit codes reach the card", () => {
    const running = parseDynamicToolUIPart({ ...base, state: { status: "running", input, title: "", metadata: { output: "live" }, time: { start: 1 } } } as unknown as ToolPart);
    expect(running?.callProviderMetadata?.omnirush).toEqual({ command: { output: "live" } });
    const done = parseDynamicToolUIPart({ ...base, state: { status: "completed", input, output: "final", title: "", metadata: { output: "preview", exit: 1 }, time: { start: 1, end: 2 } } } as unknown as ToolPart);
    expect(done?.callProviderMetadata?.omnirush).toEqual({ command: { exit: 1 } });
    expect(getCommandOutput(done!)).toEqual({ text: "final", running: false, exitCode: 1, notes: [] });
  });

  test("other tools and empty metadata add nothing", () => {
    const read = parseDynamicToolUIPart({ ...base, tool: "read", state: { status: "running", input: { filePath: "a" }, title: "", metadata: { output: "x" }, time: { start: 1 } } } as unknown as ToolPart);
    expect(read?.callProviderMetadata?.omnirush).toBeUndefined();
    const quiet = parseDynamicToolUIPart({ ...base, state: { status: "running", input, title: "", metadata: {}, time: { start: 1 } } } as unknown as ToolPart);
    expect(quiet?.callProviderMetadata?.omnirush).toBeUndefined();
  });

  test("very long live output keeps its end", () => {
    const long = "a".repeat(40_000) + "END";
    const running = parseDynamicToolUIPart({ ...base, state: { status: "running", input, title: "", metadata: { output: long }, time: { start: 1 } } } as unknown as ToolPart);
    const output = (running?.callProviderMetadata?.omnirush as { command: { output: string } }).command.output;
    expect(output.length).toBe(32_000);
    expect(output.endsWith("END")).toBe(true);
  });
});
