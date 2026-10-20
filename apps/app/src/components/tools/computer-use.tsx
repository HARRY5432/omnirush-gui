import { AppWindow, Camera, Hand, LoaderCircle, LogOut, MonitorSmartphone, Search } from "lucide-react"
import type { FileUIPart } from "ai"

import { Image } from "@/components/ui/image"
import type { ComputerUseToolPart } from "@/lib/build-in-tools"
import { describeComputerUseAction } from "@/react-app/domains/session/surface/computer-use/describe"

/** Results that are part of the normal flow, not failures. */
const NEUTRAL_CODES = new Set(["stale_observation", "paused_by_person", "approval_denied"])

const NEUTRAL_LABELS: Record<string, string> = {
  stale_observation: "Looked again",
  paused_by_person: "Paused",
  approval_denied: "Not allowed",
}

type ComputerUseResult = { ok: boolean; code: string | null; message: string | null; appName: string | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/** The JSON a computer use tool answers with ({ok, code, message, ...}), or null. */
export function parseComputerUseResult(output: unknown): ComputerUseResult | null {
  let value = output
  if (typeof output === "string") {
    try {
      value = JSON.parse(output)
    } catch {
      return null
    }
  }
  if (!isRecord(value) || typeof value.ok !== "boolean") return null
  const window = isRecord(value.window) ? value.window : null
  return {
    ok: value.ok,
    code: stringValue(value.code),
    message: stringValue(value.message),
    appName: stringValue(window?.app_name),
  }
}

/** The short label for one computer use call. */
export function computerUseToolLabel(tool: string, input: unknown, appName: string | null): string {
  switch (tool) {
    case "computer_discover":
      return "Looked at open apps"
    case "computer_open_session":
      return `Asked to use ${appName ?? "an app"}`
    case "computer_observe":
      return "Took a screenshot"
    case "computer_act":
      return describeComputerUseAction(isRecord(input) ? input.action : null)
    case "computer_session_status":
      return "Checked the session"
    case "computer_close_session":
      return "Ended computer use"
    default:
      return "Used the computer"
  }
}

function ToolIcon(props: { tool: string }) {
  const className = "size-4 shrink-0"
  switch (props.tool) {
    case "computer_discover":
      return <Search className={className} />
    case "computer_open_session":
      return <AppWindow className={className} />
    case "computer_observe":
      return <Camera className={className} />
    case "computer_act":
      return <Hand className={className} />
    case "computer_close_session":
      return <LogOut className={className} />
    default:
      return <MonitorSmartphone className={className} />
  }
}

/** One computer use step in the transcript: what it did, why, how it went, and its screenshot. */
export function ComputerUseToolLine(props: { part: ComputerUseToolPart; attachments?: FileUIPart[] }) {
  const { part } = props
  const tool = part.toolName.slice("computer-use_".length)
  const input = isRecord(part.input) ? part.input : null
  const intent = stringValue(input?.intent)
  const result = part.state === "output-available" ? parseComputerUseResult(part.output) : null
  const running = part.state === "input-streaming" || part.state === "input-available"
  const errorText = part.state === "output-error" ? part.errorText : null
  // Screenshots arrive as data: URLs; stored media references are not loadable here.
  const thumbnail = props.attachments?.find((file) => file.url.startsWith("data:image/"))
  const label = computerUseToolLabel(tool, input, result?.appName ?? null)

  return (
    <div className="flex flex-col gap-1.5 text-sm" data-computer-use-tool={tool}>
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        {running ? <LoaderCircle className="size-4 shrink-0 animate-spin" /> : <ToolIcon tool={tool} />}
        <span className="min-w-0 truncate text-foreground">{label}</span>
        {result && !result.ok && result.code ? (
          NEUTRAL_CODES.has(result.code) ? (
            <span className="shrink-0 rounded-full border border-border px-2 text-[11px] text-muted-foreground" title={result.message ?? undefined}>
              {NEUTRAL_LABELS[result.code]}
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-red-3 px-2 font-mono text-[11px] text-red-11" title={result.message ?? undefined}>
              {result.code}
            </span>
          )
        ) : null}
        {errorText ? <span className="shrink-0 rounded-full bg-red-3 px-2 text-[11px] text-red-11" title={errorText}>Failed</span> : null}
      </div>
      {intent ? <div className="pl-6 text-xs text-muted-foreground">{intent}</div> : null}
      {thumbnail ? (
        <div className="pl-6">
          <Image src={thumbnail.url} alt="Screenshot" previewMaxWidth={220} previewMaxHeight={124} className="rounded-lg border border-border/70" />
        </div>
      ) : null}
    </div>
  )
}
