import { describe, expect, test } from "bun:test"

import { isHostedWebSearchToolPart, isWebSearchToolPart } from "../src/lib/build-in-tools"
import { hostedWebSearchSummary, shortPageAddress } from "../src/lib/hosted-web-search"
import { getToolActivityLabel } from "../src/lib/tool-activity"

const output = JSON.stringify({
  action: { type: "search", query: "vite 7 release notes" },
  sources: [
    { type: "url", url: "https://vite.dev/blog/announcing-vite7" },
    { type: "url", url: "https://github.com/vitejs/vite/releases" },
    { type: "url", url: "https://vite.dev/blog/announcing-vite7" },
    { type: "url", url: "javascript:alert(1)" },
    { type: "api" },
  ],
})

describe("hosted web search", () => {
  test("the line and the sources, as the CLI shows them", () => {
    expect(hostedWebSearchSummary({ type: "search", query: "vite 7 release notes" }, output)).toEqual({
      line: 'Searched the web for "vite 7 release notes" (2 sources)',
      sources: ["https://vite.dev/blog/announcing-vite7", "https://github.com/vitejs/vite/releases"],
    })
    // An empty input takes the result's action.
    expect(hostedWebSearchSummary({}, output).line).toBe('Searched the web for "vite 7 release notes" (2 sources)')
    expect(hostedWebSearchSummary({ type: "search", queries: ["a b", "c"] }).line).toBe('Searched the web for "a b"')
    expect(hostedWebSearchSummary({ type: "search", query: "x" }, JSON.stringify({ sources: [{ type: "url", url: "https://a.example/" }] })).line).toBe('Searched the web for "x" (1 source)')
    expect(hostedWebSearchSummary({ type: "openPage", url: "https://docs.example.com/guide/install/?x=1#top" }).line).toBe("Opened docs.example.com/guide/install")
    expect(hostedWebSearchSummary({ type: "find_in_page", url: "https://example.com/", pattern: "v2.1" }).line).toBe('Searched example.com for "v2.1"')
    expect(hostedWebSearchSummary({}, "not json")).toEqual({ line: "Searched the web", sources: [] })
    expect(hostedWebSearchSummary(null, undefined)).toEqual({ line: "Searched the web", sources: [] })
    expect(shortPageAddress(`https://example.com/${"a".repeat(100)}`).length).toBe(72)
  })

  test("the engine's web_search part is the hosted one; websearch stays the engine's own tool", () => {
    const hosted = { type: "dynamic-tool", toolName: "web_search", toolCallId: "ws_1", state: "output-available", input: { type: "search", query: "vite 7 release notes" }, output } as const
    const exa = { type: "dynamic-tool", toolName: "websearch", toolCallId: "c1", state: "output-available", input: { query: "q" }, output: "" } as const
    expect(isHostedWebSearchToolPart(hosted as never)).toBe(true)
    expect(isWebSearchToolPart(hosted as never)).toBe(false)
    expect(isHostedWebSearchToolPart(exa as never)).toBe(false)
    expect(getToolActivityLabel(hosted as never)).toBe('Searched the web for "vite 7 release notes" (2 sources)')
    expect(getToolActivityLabel({ ...hosted, state: "input-available" } as never)).toBe("Searching the web")
  })
})
