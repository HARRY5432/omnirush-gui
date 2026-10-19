import { describe, expect, test } from "bun:test"

import { folderWriteError, presentOpencodeSessionError } from "../src/react-app/domains/session/sync/session-error"

const body = {
  error: "workspace_not_writable",
  reason: "protected_folder",
  message: "OmniRush can't write to C:\\Users\\sam\\Documents\\OmniRushTest: Windows Security's Controlled folder access blocks the change (EPERM).",
  hint: "Open Windows Security → Virus & threat protection → Ransomware protection → Allow an app through Controlled folder access.",
}

describe("folder not writable", () => {
  test("read from the serialized SDK error, a thrown Error and a nested data record", () => {
    for (const value of [JSON.stringify(body), new Error(JSON.stringify(body)), body, { name: "Error", data: body }]) {
      expect(folderWriteError(value)).toEqual({ reason: "protected_folder", message: body.message, hint: body.hint })
    }
    expect(folderWriteError("Failed to send prompt.")).toBeNull()
    expect(folderWriteError(JSON.stringify({ error: "omnirush_account_required", message: "Sign in" }))).toBeNull()
  })

  test("presented with the folder, the reason and the fix", () => {
    const presentation = presentOpencodeSessionError(JSON.stringify(body))
    expect(presentation.kind).toBe("folder-not-writable")
    expect(presentation.title).toBe(body.message)
    expect(presentation.description).toBe(body.hint)
    expect(presentation.recoveryPrompt).toBeNull()
  })
})
