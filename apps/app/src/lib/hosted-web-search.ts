/**
 * A provider-run web search (the model's own `web_search` tool): the engine
 * records it as a `web_search` tool part whose input is the search's action
 * ({ type: "search", query } / { type: "openPage", url } / { type: "findInPage",
 * url, pattern }) and whose output is `{ action, sources: [{ type: "url", url }] }`
 * as JSON text. The one line it shows is the CLI's (engine turn-status.ts
 * hostedSearchLine): "Searched the web for "q" (5 sources)", "Opened
 * host/path", "Searched host/path for "x"", else "Searched the web".
 */

export interface HostedWebSearchAction {
  type?: string
  query?: string
  queries?: string[]
  url?: string
  pattern?: string
}

export interface HostedWebSearchSummary {
  line: string
  /** The source addresses the search returned (http/https only, no duplicates). */
  sources: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A page address shortened for one line: host and path, no scheme, query or fragment. */
export function shortPageAddress(url: string): string {
  try {
    const parsed = new URL(url)
    const tail = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "")
    const text = parsed.host + tail
    return text.length > 72 ? `${text.slice(0, 71)}…` : text
  } catch {
    return url.length > 72 ? `${url.slice(0, 71)}…` : url
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function parseOutput(output: unknown): Record<string, unknown> {
  if (isRecord(output)) return output
  if (typeof output !== "string" || !output.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(output)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function webUrl(value: unknown): string | null {
  const raw = isRecord(value) ? value.url : value
  if (typeof raw !== "string") return null
  try {
    const url = new URL(raw)
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null
  } catch {
    return null
  }
}

export function hostedWebSearchSummary(input: unknown, output?: unknown): HostedWebSearchSummary {
  const result = parseOutput(output)
  const given = isRecord(input) ? input : {}
  const action = typeof given.type === "string" || text(given.query)
    ? given
    : isRecord(result.action)
      ? result.action
      : given
  const sources = [...new Set((Array.isArray(result.sources) ? result.sources : []).map(webUrl).filter((url): url is string => url !== null))]
  const type = typeof action.type === "string" ? action.type.replace(/_/g, "").toLowerCase() : ""
  const url = text(action.url)
  if (type === "openpage" && url) return { line: `Opened ${shortPageAddress(url)}`, sources }
  if (type === "findinpage" && url) {
    const pattern = text(action.pattern)
    return { line: pattern ? `Searched ${shortPageAddress(url)} for "${pattern}"` : `Searched ${shortPageAddress(url)}`, sources }
  }
  const queries = Array.isArray(action.queries) ? action.queries.map(text).filter((q): q is string => q !== null) : []
  const query = text(action.query) ?? queries[0] ?? null
  const count = sources.length ? ` (${sources.length} ${sources.length === 1 ? "source" : "sources"})` : ""
  return { line: query ? `Searched the web for "${query}"${count}` : `Searched the web${count}`, sources }
}
