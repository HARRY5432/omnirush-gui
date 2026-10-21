import type { DynamicToolUIPart, ToolUIPart } from "ai"

import { isBashToolPart } from "./build-in-tools"

type AnyToolPart = ToolUIPart | DynamicToolUIPart

/** Lines a collapsed output box shows: the end, where results and errors land. */
export const COMMAND_OUTPUT_PREVIEW_LINES = 8
/** Characters a collapsed output box shows at most (one very long line). */
export const COMMAND_OUTPUT_PREVIEW_CHARS = 1_200
/** Characters the expanded box renders; the engine already keeps a bounded tail. */
export const COMMAND_OUTPUT_RENDER_CHARS = 100_000
/** Characters of live output forwarded from a running command's metadata. */
export const COMMAND_OUTPUT_METADATA_CHARS = 32_000

export type CommandOutputView = {
  /** Output text with terminal escapes removed; empty when the command printed nothing. */
  text: string
  /** The command is still running; `text` is its latest output so far. */
  running: boolean
  /** Process exit code when the engine reported one. */
  exitCode: number | null
  /** Engine notes (timeout, user abort) appended to the output. */
  notes: string[]
}

export type CommandOutputPreview = {
  text: string
  /** Lines before the preview that are not shown. */
  hiddenLines: number
  /** Whether the preview omits anything. */
  clipped: boolean
  totalLines: number
}

// CSI (colors, cursor moves), OSC (titles, links) and other two-byte escapes.
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]/g
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
const ESC = /\u001b[@-Z\\^_]|\u001b[ -/]+[0-~]/g
// Control characters other than tab and newline (\r is handled first).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

/**
 * Remove terminal escape sequences and resolve carriage returns the way a
 * terminal shows them: a progress bar redrawn with `\r` keeps its last state.
 */
export function stripAnsi(text: string): string {
  const withoutEscapes = text.replace(OSC, "").replace(CSI, "").replace(ESC, "")
  const lines = withoutEscapes.replace(/\r\n/g, "\n").split("\n").map((line) => {
    if (!line.includes("\r")) return line
    const frames = line.split("\r")
    let shown = ""
    for (const frame of frames) {
      // A redraw overwrites from the start of the line.
      shown = frame + shown.slice(frame.length)
    }
    return shown
  })
  return lines.join("\n").replace(CONTROL, "")
}

const NOTE_BLOCK = /\n*<(shell|bash)_metadata>\n?([\s\S]*?)\n?<\/\1_metadata>\s*$/

/** Split the engine's trailing `<shell_metadata>` block from the output. */
export function splitEngineNotes(text: string): { text: string; notes: string[] } {
  const match = text.match(NOTE_BLOCK)
  if (!match) return { text, notes: [] }
  const notes = (match[2] ?? "").split("\n").map((line) => line.trim()).filter(Boolean)
  return { text: text.slice(0, match.index), notes }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The `omnirush.command` block session sync forwards for bash calls. */
function commandMetadata(part: AnyToolPart): { output?: string; exit?: number | null } {
  const omnirush = (part as DynamicToolUIPart).callProviderMetadata?.omnirush
  const command = isRecord(omnirush) ? omnirush.command : undefined
  if (!isRecord(command)) return {}
  return {
    ...(typeof command.output === "string" ? { output: command.output } : {}),
    ...(typeof command.exit === "number" && Number.isFinite(command.exit) ? { exit: command.exit } : {}),
  }
}

function cleanOutput(raw: string): { text: string; notes: string[] } {
  const split = splitEngineNotes(raw)
  const text = stripAnsi(split.text).replace(/\s+$/, "")
  // The engine reports an empty run as this placeholder.
  return { text: text.trim() === "(no output)" ? "" : text, notes: split.notes }
}

/**
 * What a terminal command card shows: the final output when the call
 * finished, the live output while it runs, whatever was captured when it
 * failed. Null for other tools, or when there is nothing to show yet.
 */
export function getCommandOutput(part: AnyToolPart): CommandOutputView | null {
  if (!isBashToolPart(part)) return null
  const metadata = commandMetadata(part)
  const exitCode = metadata.exit ?? null
  if (part.state === "input-streaming" || part.state === "input-available") {
    const { text, notes } = cleanOutput(metadata.output ?? "")
    return { text, running: true, exitCode: null, notes }
  }
  if (part.state === "output-available") {
    const raw = typeof part.output === "string" ? part.output : metadata.output ?? ""
    const { text, notes } = cleanOutput(raw)
    return { text, running: false, exitCode, notes }
  }
  if (part.state === "output-error") {
    if (metadata.output === undefined) return null
    const { text, notes } = cleanOutput(metadata.output)
    if (!text && notes.length === 0) return null
    return { text, running: false, exitCode, notes }
  }
  return null
}

/** The end of the output that fits the collapsed box. */
export function previewCommandOutput(
  text: string,
  maxLines = COMMAND_OUTPUT_PREVIEW_LINES,
  maxChars = COMMAND_OUTPUT_PREVIEW_CHARS,
): CommandOutputPreview {
  const lines = text.split("\n")
  const kept = lines.slice(-maxLines)
  let preview = kept.join("\n")
  let clipped = kept.length < lines.length
  if (preview.length > maxChars) {
    preview = `…${preview.slice(preview.length - maxChars + 1)}`
    clipped = true
  }
  const shownLines = preview.split("\n").length
  return { text: preview, hiddenLines: Math.max(0, lines.length - shownLines), clipped, totalLines: lines.length }
}

/** The expanded text, bounded so a huge log cannot freeze the chat. */
export function boundedCommandOutput(text: string, maxChars = COMMAND_OUTPUT_RENDER_CHARS): { text: string; omittedChars: number } {
  if (text.length <= maxChars) return { text, omittedChars: 0 }
  return { text: text.slice(text.length - maxChars), omittedChars: text.length - maxChars }
}
