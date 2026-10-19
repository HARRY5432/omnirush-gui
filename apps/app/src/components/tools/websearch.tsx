"use client"

import { Search } from "lucide-react"
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtStep,
  ChainOfThoughtTrigger,
} from "@/components/ui/chain-of-thought"
import {
  Source,
  SourceContent,
  SourceTrigger,
} from "@/components/ui/source"
import type { HostedWebSearchToolPart, WebSearchToolPart } from "@/lib/build-in-tools"
import { Tool } from "@/components/ui/tool"
import { parseWebSearchResults } from "@/lib/websearch-results"
import { hostedWebSearchSummary, shortPageAddress } from "@/lib/hosted-web-search"

interface WebsearchToolProps {
  part: WebSearchToolPart
}

export function WebsearchTool({ part }: WebsearchToolProps) {
  if (part.state === "output-error") {
    return <Tool toolPart={part} />
  }

  if (part.state !== "output-available") {
    return <Tool toolPart={part} />
  }

  const results = parseWebSearchResults(part.output)

  return (
    <ChainOfThought>
      <ChainOfThoughtStep>
        <ChainOfThoughtTrigger leftIcon={<Search className="size-4" />}>
          {results.length > 0 ? `Searching for "${part.input.query}"` : "Web search (No results)"}
        </ChainOfThoughtTrigger>
        <ChainOfThoughtContent>
          <div className="flex flex-wrap items-center gap-2">
            {results.map((result) => (
              <Source href={result.url} key={result.url}>
                <SourceTrigger showFavicon />
                <SourceContent
                  title={result.title}
                  description={result.description}
                />
              </Source>
            ))}
          </div>
        </ChainOfThoughtContent>
      </ChainOfThoughtStep>
    </ChainOfThought>
  )
}

interface HostedWebSearchToolProps {
  part: HostedWebSearchToolPart
}

/**
 * The model's own web search (run by the provider): one line with what it
 * searched or opened, and the sources it returned as links. No favicons: a
 * favicon would be fetched from a third-party service for every source.
 */
export function HostedWebSearchTool({ part }: HostedWebSearchToolProps) {
  if (part.state === "output-error") {
    return <Tool toolPart={part} />
  }

  if (part.state !== "output-available") {
    return (
      <ChainOfThought>
        <ChainOfThoughtStep>
          <ChainOfThoughtTrigger leftIcon={<Search className="size-4" />} swapIconOnHover={false}>
            Searching the web…
          </ChainOfThoughtTrigger>
        </ChainOfThoughtStep>
      </ChainOfThought>
    )
  }

  const { line, sources } = hostedWebSearchSummary(part.input, part.output)

  if (sources.length === 0) {
    return (
      <ChainOfThought>
        <ChainOfThoughtStep>
          <ChainOfThoughtTrigger leftIcon={<Search className="size-4" />} swapIconOnHover={false}>
            {line}
          </ChainOfThoughtTrigger>
        </ChainOfThoughtStep>
      </ChainOfThought>
    )
  }

  return (
    <ChainOfThought>
      <ChainOfThoughtStep>
        <ChainOfThoughtTrigger leftIcon={<Search className="size-4" />}>
          {line}
        </ChainOfThoughtTrigger>
        <ChainOfThoughtContent>
          <div className="flex flex-wrap items-center gap-2" data-testid="hosted-web-search-sources">
            {sources.map((url) => (
              <Source href={url} key={url}>
                <SourceTrigger />
                <SourceContent title={shortPageAddress(url)} description={url} showFavicon={false} />
              </Source>
            ))}
          </div>
        </ChainOfThoughtContent>
      </ChainOfThoughtStep>
    </ChainOfThought>
  )
}
