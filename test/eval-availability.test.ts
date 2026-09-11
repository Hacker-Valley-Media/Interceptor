// `eval --main` availability as reported by status/diagnose from the
// extension's `capabilities` answer. Each branch names the fix that can work.
import { describe, expect, test } from "bun:test"
import { describeEvalMain } from "../cli/lib/status-renderer"

describe("describeEvalMain", () => {
  test("enabled userScripts is available", () => {
    expect(describeEvalMain({ userScripts: { manifest_permission: true, api_present: true, enabled: true } })).toEqual({ available: true })
  })
  test("toggle off names the Allow User Scripts page for this extension id", () => {
    const s = describeEvalMain({ userScripts: { manifest_permission: true, api_present: true, enabled: false } }, "abcdefghijklmnopabcdefghijklmnop")
    expect(s.available).toBe(false)
    expect(s.hint).toContain("chrome://extensions/?id=abcdefghijklmnopabcdefghijklmnop")
    expect(s.hint).toContain("Allow User Scripts")
  })
  test("an API the browser does not expose is not a toggle problem", () => {
    const s = describeEvalMain({ userScripts: { manifest_permission: true, api_present: false, enabled: false } })
    expect(s.available).toBe(false)
    expect(s.hint).not.toContain("Allow User Scripts")
    expect(s.hint).toContain("not available in this browser")
  })
  test("no userScripts block means an older extension copy", () => {
    expect(describeEvalMain({}).hint).toContain("older extension copy")
  })
})
