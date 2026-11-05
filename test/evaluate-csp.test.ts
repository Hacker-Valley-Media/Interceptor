import { describe, expect, test } from "bun:test"

import { buildCspBypassRule, isCspEvalError } from "../extension/src/background/capabilities/evaluate"

describe("evaluate CSP fallback helpers", () => {
  test("detects page CSP eval failures", () => {
    expect(isCspEvalError(
      `Evaluating a string as JavaScript violates the following Content Security Policy directive because neither 'unsafe-eval' nor the string's hash are an allowed source of script: script-src 'self'`
    )).toBe(true)
    expect(isCspEvalError("ReferenceError: foo is not defined")).toBe(false)
  })

  test("builds one shared session rule that strips CSP response headers for the listed tabs", () => {
    const rule = buildCspBypassRule([321, 654])
    expect(rule.id).toBe(910000)
    expect(rule.action.type).toBe("modifyHeaders")
    expect(rule.action.responseHeaders).toEqual([
      { header: "content-security-policy", operation: "remove" },
      { header: "content-security-policy-report-only", operation: "remove" }
    ])
    expect(rule.condition.tabIds).toEqual([321, 654])
    expect(rule.condition.resourceTypes).toEqual(["main_frame", "sub_frame"])
  })
})
