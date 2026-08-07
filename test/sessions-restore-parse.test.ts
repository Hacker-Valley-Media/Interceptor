import { describe, expect, test } from "bun:test"
import { parseMetaCommand } from "../cli/commands/meta"

// `sessions restore` must take the first NON-FLAG
// argument as the sessionId (`--json` was being swallowed as an id), and
// `sessions <n>` must skip flags when reading maxResults. The no-arg-refusal
// path calls process.exit and is exercised manually, not here.

describe("sessions restore parsing", () => {
  test("sessionId is the first non-flag argument even with flags present", async () => {
    const action = await parseMetaCommand(["sessions", "restore", "12345", "--json"])
    expect(action).toMatchObject({ type: "session_restore", sessionId: "12345" })
  })

  test("flags before the id do not become the sessionId", async () => {
    const action = await parseMetaCommand(["sessions", "restore", "--json", "12345"])
    expect(action).toMatchObject({ type: "session_restore", sessionId: "12345" })
  })

  test("sessions list skips flags when reading maxResults", async () => {
    const action = await parseMetaCommand(["sessions", "--json"])
    expect(action).toMatchObject({ type: "session_list", maxResults: 10 })
    const action2 = await parseMetaCommand(["sessions", "25", "--json"])
    expect(action2).toMatchObject({ type: "session_list", maxResults: 25 })
  })
})
