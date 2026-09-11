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
  test("a missing chrome.userScripts namespace is the toggle-off state, so the toggle hint applies", () => {
    // Chrome removes the namespace entirely while Allow User Scripts is off;
    // `api_present: false` is what a working Chrome reports in that state.
    const s = describeEvalMain({ userScripts: { manifest_permission: true, api_present: false, enabled: false } })
    expect(s.available).toBe(false)
    expect(s.hint).toContain("Allow User Scripts")
  })
  test("no userScripts block means an older extension copy", () => {
    expect(describeEvalMain({}).hint).toContain("older extension copy")
  })
})
