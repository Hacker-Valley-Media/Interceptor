import { describe, expect, test } from "bun:test"
import { aggregateReadResults } from "../cli/commands/compound"

describe("compound read aggregation", () => {
  test("fails when all requested reads fail", () => {
    const result = aggregateReadResults({
      treeRequested: true,
      textRequested: true,
      treeResult: { success: false, error: "tree unavailable" },
      textResult: { success: false, error: "text unavailable" },
      full: false,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("tree unavailable")
    expect(result.error).toContain("text unavailable")
  })

  test("returns partial success when one requested read succeeds", () => {
    const result = aggregateReadResults({
      treeRequested: true,
      textRequested: true,
      treeResult: { success: true, data: "tree data" },
      textResult: { success: false, error: "text unavailable" },
      full: false,
    })

    expect(result.success).toBe(true)
    expect(result.tree).toBe("tree data")
    expect(result.text).toBeUndefined()
    expect(result.warnings).toContain("text: text unavailable")
  })
})

