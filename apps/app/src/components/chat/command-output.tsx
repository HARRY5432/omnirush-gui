"use client"

import { useState } from "react"

import { displayRuntimeBrand } from "@/lib/display-runtime-brand"
import {
  boundedCommandOutput,
  previewCommandOutput,
  type CommandOutputView,
} from "@/lib/command-output"
import { cn } from "@/lib/utils"

type CommandOutputProps = {
  /** `partial`: output captured so far from a call that has not finished. */
  output: CommandOutputView & { partial?: boolean }
}

function exitLabel(output: CommandOutputProps["output"]): string | null {
  if (output.running || output.partial || output.exitCode === null) return null
  return `Exit ${output.exitCode}`
}

/**
 * A terminal command's output under its command box: the last lines in a
 * monospace block, expandable to the whole (bounded) output, with the live
 * text while the command runs and its exit code once it ends.
 */
export function CommandOutput({ output }: CommandOutputProps) {
  const [expanded, setExpanded] = useState(false)
  const preview = previewCommandOutput(output.text)
  const full = boundedCommandOutput(output.text)
  const shown = expanded ? full.text : preview.text
  const exit = exitLabel(output)
  const failed = output.exitCode !== null && output.exitCode !== 0
  const empty = output.text.length === 0

  return (
    <div
      data-command-output=""
      data-command-output-state={output.running ? "running" : "done"}
      className="flex min-w-0 max-w-full flex-col rounded-xl border border-border/70 bg-gray-2/40"
    >
      <div className="flex min-w-0 items-center gap-2 px-3 pt-1.5 text-xs text-muted-foreground">
        <span className={cn("shrink-0", output.running && "text-foreground ow-text-shimmer")}>
          {output.running ? "Running…" : output.partial ? "Output so far" : "Output"}
        </span>
        {exit ? (
          <span
            data-command-exit={output.exitCode ?? undefined}
            className={cn("shrink-0 tabular-nums", failed ? "text-destructive" : "text-muted-foreground/70")}
          >
            {exit}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {preview.clipped ? (
          <button
            type="button"
            data-command-output-toggle=""
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="shrink-0 cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
          >
            {expanded
              ? "Show less"
              : preview.totalLines > 1
                ? `Show all ${preview.totalLines} lines`
                : "Show all"}
          </button>
        ) : null}
      </div>
      {empty ? (
        <div className="px-3 pt-1 pb-2 text-xs text-muted-foreground/70">
          {output.running ? "Waiting for output…" : "No output"}
        </div>
      ) : (
        <pre
          data-command-output-text=""
          className={cn(
            "min-w-0 px-3 pt-1 pb-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground/85",
            expanded && "max-h-80 overflow-y-auto",
          )}
        >
          {expanded && full.omittedChars > 0 ? (
            <span className="text-muted-foreground/70">{`… ${full.omittedChars.toLocaleString()} earlier characters not shown\n`}</span>
          ) : !expanded && preview.hiddenLines > 0 ? (
            <span className="text-muted-foreground/70">{`… ${preview.hiddenLines} earlier ${preview.hiddenLines === 1 ? "line" : "lines"}\n`}</span>
          ) : null}
          {displayRuntimeBrand(shown)}
        </pre>
      )}
      {output.notes.length > 0 ? (
        <div className="px-3 pb-2 text-xs text-muted-foreground">
          {output.notes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
