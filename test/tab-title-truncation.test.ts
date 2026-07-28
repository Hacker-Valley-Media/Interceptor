import { describe, expect, test } from "bun:test"
import { boundedTabTitle } from "../extension/src/background/capabilities/tabs"

// Regression: a page (or a stray injected script) rewriting document.title
// in a loop instead of replacing it hands chrome.tabs.query back a title
// that's grown to thousands of repeated characters — flooding
// `interceptor tabs` output (and any agent parsing it). tab_list must bound
// what it relays regardless of how the browser got into that state.
describe("boundedTabTitle", () => {
  test("passes short titles through unchanged", () => {
    expect(boundedTabTitle("New chat - Claude")).toBe("New chat - Claude")
  })

  test("passes undefined through unchanged", () => {
    expect(boundedTabTitle(undefined)).toBeUndefined()
  })

  test("passes through a title exactly at the cap", () => {
    const title = "x".repeat(200)
    expect(boundedTabTitle(title)).toBe(title)
  })

  test("truncates a runaway repeated title and reports the original length", () => {
    const unit = " - https://claude.ai/ - https://claude.ai/new#settings/usage"
    const runaway = "New chat - Claude" + unit.repeat(30)
    const result = boundedTabTitle(runaway)!
    expect(result.length).toBeLessThan(runaway.length)
    expect(result.startsWith("New chat - Claude")).toBe(true)
    expect(result).toContain(`truncated, ${runaway.length} chars total`)
  })
})
