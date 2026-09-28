import { describe, expect, test } from "bun:test"
import { parseActionsCommand } from "../cli/commands/actions"

// `check role:name` used to spread the semantic target into a plain `check` action,
// which the content script resolves by ref or index only, so it answered "stale element".

describe("check targets", () => {
  test("role:name becomes find_and_check", () => {
    expect(parseActionsCommand(["check", "checkbox:Normal checkbox"]))
      .toEqual({ type: "find_and_check", name: "Normal checkbox", role: "checkbox", checked: true })
    expect(parseActionsCommand(["check", "switch:Dark mode", "false"]))
      .toEqual({ type: "find_and_check", name: "Dark mode", role: "switch", checked: false })
  })

  test("ref and index still send check", () => {
    expect(parseActionsCommand(["check", "e1"])).toEqual({ type: "check", ref: "e1", checked: true })
    expect(parseActionsCommand(["check", "e1", "false"])).toEqual({ type: "check", ref: "e1", checked: false })
    expect(parseActionsCommand(["check", "4"])).toEqual({ type: "check", index: 4, checked: true })
  })
})
