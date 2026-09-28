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

describe("formatResult warning on a failed result", () => {
  test("text mode prints the error line and then the warning line", () => {
    const out = formatResult(
      { success: false, error: "TrustedScript required", warning: "the tab was reloaded to strip its CSP header and the retry still failed" },
      false,
    )
    expect(out).toBe("error: TrustedScript required\nwarning: the tab was reloaded to strip its CSP header and the retry still failed")
  })

  test("a failed result without a warning is unchanged", () => {
    expect(formatResult({ success: false, error: "boom" }, false)).toBe("error: boom")
  })

  test("json mode keeps error and warning in the envelope", () => {
    const out = formatResult({ success: false, error: "e", warning: "w" }, true)
    expect(JSON.parse(out)).toEqual({ success: false, error: "e", warning: "w" })
  })
})

describe("formatResult hint on a failed result", () => {
  test("text mode prints data.hint after the error line, before any warning", () => {
    const out = formatResult(
      { success: false, error: "tab 42 is not the active tab of window 5", data: { hint: "Try synthetic input first" }, warning: "w" },
      false,
    )
    expect(out).toBe("error: tab 42 is not the active tab of window 5\nhint: Try synthetic input first\nwarning: w")
  })

  test("a non-string or empty hint prints nothing extra", () => {
    expect(formatResult({ success: false, error: "boom", data: { hint: "" } }, false)).toBe("error: boom")
    expect(formatResult({ success: false, error: "boom", data: { hint: 7 } }, false)).toBe("error: boom")
  })
})
