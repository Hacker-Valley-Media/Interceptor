import { describe, expect, test } from "bun:test"
import { hasOwnPointerCursor } from "./element-tree"

describe("hasOwnPointerCursor", () => {
  test("true when the element's own cursor is pointer and the parent's isn't", () => {
    expect(hasOwnPointerCursor("pointer", "auto")).toBe(true)
    expect(hasOwnPointerCursor("pointer", null)).toBe(true)
  })

  test("false when cursor isn't pointer at all", () => {
    expect(hasOwnPointerCursor("auto", "auto")).toBe(false)
    expect(hasOwnPointerCursor("default", null)).toBe(false)
  })

  test("false when pointer is merely inherited from a pointer-cursor parent", () => {
    // A passive descendant (label span, icon) of a `cursor: pointer`
    // container computes the same "pointer" value via CSS inheritance —
    // this must not be mistaken for the descendant being its own widget.
    expect(hasOwnPointerCursor("pointer", "pointer")).toBe(false)
  })
})
