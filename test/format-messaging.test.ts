// Chrome's messaging errors reach the agent in Interceptor's words, with the
// composed context kept and one recovery hint (276 raw leaks, 2026-09-10).
import { describe, expect, test } from "bun:test"
import { formatResult, humanizeError, isChromeMessagingError, rewriteChromeMessagingError } from "../cli/format"

describe("Chrome messaging error translation", () => {
  test("recognizes the port-closed family", () => {
    expect(isChromeMessagingError("The message port closed before a response was received.")).toBe(true)
    expect(isChromeMessagingError("Could not establish connection. Receiving end does not exist.")).toBe(true)
    expect(isChromeMessagingError("stale element [e7]")).toBe(false)
    expect(isChromeMessagingError(undefined)).toBe(false)
  })

  test("substitutes the fragment inside a composed message and adds one hint", () => {
    const out = rewriteChromeMessagingError("content script re-injected on tab 12 but action still failed: The message port closed before a response was received.")!
    expect(out).toContain("content script re-injected on tab 12")
    expect(out).toContain("the page navigated or reloaded before it answered")
    expect(out).not.toContain("message port")
    expect(out).not.toMatch(/\.\./)
    expect(out.endsWith("Run 'interceptor read' for the current page state before retrying.")).toBe(true)
  })

  test("leaves unrelated errors alone", () => {
    expect(rewriteChromeMessagingError("tab 5 is not in the interceptor group")).toBe("tab 5 is not in the interceptor group")
  })

  test("formatResult applies CSP and messaging rewrites in text mode", () => {
    expect(formatResult({ success: false, error: "The message port closed before a response was received." }, false))
      .toContain("error: the page navigated or reloaded before it answered")
    expect(humanizeError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script")).toContain("page CSP blocks eval")
  })
})
