import { describe, expect, test } from "bun:test";
import type { DynamicToolUIPart } from "ai";

import { getCapabilityCallQuote, getCapabilityCallSentence, registerMcpServerTitles } from "@/lib/capability-call";

function executeCapability(input: unknown): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "omnirush-cloud_execute_capability",
    toolCallId: "call_test",
    state: "output-error",
    input,
    errorText: "boom",
  } as DynamicToolUIPart;
}

describe("capability call sentences", () => {
  test("names an org MCP capability instead of falling back to 'a capability'", () => {
    const part = executeCapability({
      name: "mcp:emc_01kx2kfb42f6d94y1s1j992jhf:query_granola_meetings",
      body: '{"query": "action items from recent meetings"}',
    });

    const sentence = getCapabilityCallSentence(part);

    expect(sentence.past).toContain("Queried granola meetings");
    expect(sentence.present).toContain("Querying granola meetings");
    expect(sentence.past).not.toContain("a capability");
    // The opaque connection id never reaches the reader.
    expect(sentence.past).not.toContain("emc_01kx2kfb42f6d94y1s1j992jhf");
  });

  test("reads the ask out of a JSON-string body", () => {
    const part = executeCapability({
      name: "mcp:emc_01kx:query_granola_meetings",
      body: '{"query": "action items from recent meetings"}',
    });

    expect(getCapabilityCallQuote(part)).toBe("action items from recent meetings");
    expect(getCapabilityCallSentence(part).past).toContain("action items from recent meetings");
  });

  test("still reads the ask out of an object body", () => {
    const part = executeCapability({
      name: "mcp:emc_01kx:query_granola_meetings",
      body: { query: "yesterday's notes" },
    });

    expect(getCapabilityCallQuote(part)).toBe("yesterday's notes");
  });

  test("keeps naming dotted capabilities by service", () => {
    const part = executeCapability({ name: "granola.get_meetings" });
    const sentence = getCapabilityCallSentence(part);

    expect(sentence.service).toBe("Granola");
    expect(sentence.past).toContain("Fetched meetings");
  });

  test("falls back to a generic sentence only when the name is unusable", () => {
    expect(getCapabilityCallSentence(executeCapability({})).past).toBe("Ran a capability");
  });

  test("a supported MCP server's tool reads with the server's title and the tool's name", () => {
    registerMcpServerTitles([{ id: "sqlite", title: "SQLite" }, { id: "sequential-thinking", title: "Sequential thinking" }]);
    const call = (toolName: string): DynamicToolUIPart => ({ type: "dynamic-tool", toolName, toolCallId: "c", state: "output-available", input: {}, output: "ok" } as DynamicToolUIPart);
    expect(getCapabilityCallSentence(call("sqlite_write_query"))).toMatchObject({ service: "SQLite", past: "Used SQLite: write_query", present: "Using SQLite: write_query" });
    expect(getCapabilityCallSentence(call("sqlite_read_query")).past).toBe("Used SQLite: read_query");
    expect(getCapabilityCallSentence(call("sequential-thinking_sequentialthinking")).past).toBe("Used Sequential thinking: sequentialthinking");
    // Other MCP tools keep their sentences.
    expect(getCapabilityCallSentence(call("granola_list_meetings")).past).toBe("Listed meetings · Granola");
  });
});
