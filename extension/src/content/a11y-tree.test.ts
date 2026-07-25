import { describe, expect, test } from "bun:test"
import { shouldDescendDespiteZeroArea } from "./a11y-tree"

describe("shouldDescendDespiteZeroArea", () => {
  test("descends into out-of-flow zero-area wrappers (absolute/fixed)", () => {
    expect(shouldDescendDespiteZeroArea("block", "absolute")).toBe(true)
    expect(shouldDescendDespiteZeroArea("flex", "fixed")).toBe(true)
  })

  test("descends into a zero-area display:inline wrapper regardless of position", () => {
    expect(shouldDescendDespiteZeroArea("inline", "static")).toBe(true)
    expect(shouldDescendDespiteZeroArea("inline", "relative")).toBe(true)
  })

  test("still prunes other in-flow zero-area boxes (static/relative/sticky, block/flex/grid)", () => {
    expect(shouldDescendDespiteZeroArea("block", "static")).toBe(false)
    expect(shouldDescendDespiteZeroArea("flex", "relative")).toBe(false)
    expect(shouldDescendDespiteZeroArea("grid", "sticky")).toBe(false)
  })
})
