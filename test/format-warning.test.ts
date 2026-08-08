import { describe, expect, test } from "bun:test"
import { formatResult } from "../cli/format"

describe("formatResult warning passthrough", () => {
  test("text mode appends the warning line to string data", () => {
    const out = formatResult(
      { success: true, data: "clicked e2 — h1[0] of 1", warning: "no DOM change after click — if the site requires trusted events, try: interceptor click --trusted e2" },
      false,
    )
    expect(out).toBe(
      "clicked e2 — h1[0] of 1\nwarning: no DOM change after click — if the site requires trusted events, try: interceptor click --trusted e2",
    )
  })

  test("text mode appends the warning line to object data", () => {
    const out = formatResult({ success: true, data: { ok: 1 }, warning: "partial capture" }, false)
    expect(out.endsWith("\nwarning: partial capture")).toBe(true)
    expect(out.startsWith("{")).toBe(true)
  })

  test("no warning leaves output unchanged", () => {
    expect(formatResult({ success: true, data: "ok done" }, false)).toBe("ok done")
    expect(formatResult({ success: true }, false)).toBe("ok")
  })

  test("json mode carries the warning in the envelope untouched", () => {
    const out = formatResult({ success: true, data: "x", warning: "w" }, true)
    expect(JSON.parse(out)).toEqual({ success: true, data: "x", warning: "w" })
  })
})
